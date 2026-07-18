const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const database = require("../config/database");

const wsClients = new Map();
const sseClients = new Map();

function dbQuery(sql, params = []) {
  if (typeof database.query === "function") return database.query(sql, params);
  if (database.pool && typeof database.pool.query === "function") return database.pool.query(sql, params);
  if (typeof database.getPool === "function") return database.getPool().query(sql, params);
  if (database.default && typeof database.default.query === "function") return database.default.query(sql, params);
  throw new Error("Database query function not found");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizeChannel(value) {
  const channel = String(value || "system")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_.*-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 120);

  return channel || "system";
}

function normalizeList(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return fallback;
}

function hasScope(apiKey = {}, scope) {
  const scopes = normalizeList(apiKey.scopes, []);
  return scopes.includes("*") || scopes.includes(scope);
}

function clientCanReceive(client, channel) {
  return client.channel === "*" || normalizeChannel(client.channel) === normalizeChannel(channel);
}

async function authenticateRealtimeApiKey(rawKey) {
  const key = String(rawKey || "").trim();

  if (!key) {
    const error = new Error("Realtime API key is required.");
    error.statusCode = 401;
    throw error;
  }

  const result = await dbQuery(
    `
      SELECT
        id,
        name,
        type,
        key_prefix AS "keyPrefix",
        scopes,
        allowed_app_ids AS "allowedAppIds",
        status,
        organization_id AS "organizationId",
        project_id AS "projectId",
        environment_id AS "environmentId"
      FROM backend_api_keys
      WHERE key_hash = $1
        AND expires_at > NOW()
        AND status = 'active'
      LIMIT 1
    `,
    [sha256(key)]
  );

  const apiKey = result.rows[0];

  if (!apiKey) {
    const error = new Error("Invalid or inactive realtime API key.");
    error.statusCode = 401;
    throw error;
  }

  return apiKey;
}

async function ensureChannel(channelName) {
  const channel = normalizeChannel(channelName);

  const result = await dbQuery(
    `
      SELECT *
      FROM backend_realtime_channels
      WHERE name = $1
        AND status = 'active'
      LIMIT 1
    `,
    [channel]
  );

  if (result.rows[0]) return result.rows[0];

  const id = `rtch_${crypto.randomUUID().replace(/-/g, "")}`;

  const insert = await dbQuery(
    `
      INSERT INTO backend_realtime_channels (
        id,
        name,
        display_name,
        description,
        visibility,
        status,
        allow_public_subscribe,
        allow_public_publish,
        require_api_key,
        policy_json,
        metadata_json,
        organization_id,
        project_id,
        environment_id
      )
      VALUES ($1,$2,$3,$4,'private','active',true,true,true,$5::jsonb,$6::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production')
      RETURNING *
    `,
    [
      id,
      channel,
      channel,
      `Realtime channel: ${channel}`,
      JSON.stringify({ autoCreated: true }),
      JSON.stringify({ createdBy: "realtime-v2-hub" }),
    ]
  );

  return insert.rows[0];
}

async function recordConnection({ connectionId, transport, channel, apiKey, request } = {}) {
  await dbQuery(
    `
      INSERT INTO backend_realtime_connections (
        id,
        transport,
        channel,
        status,
        api_key_id,
        actor_type,
        actor_id,
        ip_address,
        user_agent,
        organization_id,
        project_id,
        environment_id,
        metadata_json
      )
      VALUES ($1,$2,$3,'connected',$4,'api_key',$5,$6,$7,$8,$9,$10,$11::jsonb)
      ON CONFLICT (id) DO NOTHING
    `,
    [
      connectionId,
      transport,
      normalizeChannel(channel),
      apiKey?.id || null,
      apiKey?.id || null,
      request?.headers?.["x-forwarded-for"] || request?.socket?.remoteAddress || null,
      request?.headers?.["user-agent"] || null,
      apiKey?.organizationId || "org_goodos",
      apiKey?.projectId || "proj_goodos_platform",
      apiKey?.environmentId || "env_goodos_production",
      JSON.stringify({ connectedBy: "realtime-v2" }),
    ]
  );

  await dbQuery(
    `
      INSERT INTO backend_realtime_subscriptions (
        id,
        connection_id,
        channel,
        transport,
        api_key_id,
        status,
        organization_id,
        project_id,
        environment_id,
        metadata_json
      )
      VALUES ($1,$2,$3,$4,$5,'active',$6,$7,$8,$9::jsonb)
      ON CONFLICT (id) DO NOTHING
    `,
    [
      `rtsub_${connectionId}_${normalizeChannel(channel).replace(/[^a-z0-9]/g, "_")}`.slice(0, 180),
      connectionId,
      normalizeChannel(channel),
      transport,
      apiKey?.id || null,
      apiKey?.organizationId || "org_goodos",
      apiKey?.projectId || "proj_goodos_platform",
      apiKey?.environmentId || "env_goodos_production",
      JSON.stringify({ subscribedBy: "realtime-v2" }),
    ]
  );

  await dbQuery(
    `
      INSERT INTO backend_realtime_presence (
        id,
        channel,
        connection_id,
        api_key_id,
        actor_type,
        actor_id,
        presence_state,
        organization_id,
        project_id,
        environment_id,
        metadata_json
      )
      VALUES ($1,$2,$3,$4,'api_key',$5,'online',$6,$7,$8,$9::jsonb)
      ON CONFLICT (id) DO UPDATE
      SET
        presence_state = 'online',
        updated_at = NOW(),
        metadata_json = EXCLUDED.metadata_json
    `,
    [
      `rtpres_${connectionId}`,
      normalizeChannel(channel),
      connectionId,
      apiKey?.id || null,
      apiKey?.id || null,
      apiKey?.organizationId || "org_goodos",
      apiKey?.projectId || "proj_goodos_platform",
      apiKey?.environmentId || "env_goodos_production",
      JSON.stringify({ transport }),
    ]
  );
}

async function markConnectionClosed(connectionId, closeCode = null, closeReason = "") {
  await dbQuery(
    `
      UPDATE backend_realtime_connections
      SET
        status = 'disconnected',
        disconnected_at = NOW(),
        last_seen_at = NOW(),
        close_code = $2,
        close_reason = NULLIF($3, '')
      WHERE id = $1
    `,
    [connectionId, closeCode, String(closeReason || "").slice(0, 500)]
  ).catch(() => null);

  await dbQuery(
    `
      UPDATE backend_realtime_subscriptions
      SET status = 'inactive', unsubscribed_at = NOW()
      WHERE connection_id = $1
    `,
    [connectionId]
  ).catch(() => null);

  await dbQuery(
    `
      UPDATE backend_realtime_presence
      SET presence_state = 'offline', updated_at = NOW()
      WHERE connection_id = $1
    `,
    [connectionId]
  ).catch(() => null);
}

function broadcastRealtime(payload = {}) {
  const channel = normalizeChannel(payload.channel || "system");
  let wsDelivered = 0;
  let sseDelivered = 0;

  const message = JSON.stringify({
    type: "realtime",
    channel,
    eventType: payload.eventType || payload.event_type || "message",
    message: payload.message || "",
    payload: payload.payload || payload.payload_json || {},
    id: payload.id || payload.messageId || null,
    createdAt: payload.createdAt || new Date().toISOString(),
  });

  for (const [id, client] of wsClients.entries()) {
    if (!clientCanReceive(client, channel)) continue;
    if (!client.ws || client.ws.readyState !== client.ws.OPEN) continue;

    try {
      client.ws.send(message);
      wsDelivered += 1;
    } catch {
      wsClients.delete(id);
    }
  }

  for (const [id, client] of sseClients.entries()) {
    if (!clientCanReceive(client, channel)) continue;

    try {
      client.res.write(`event: realtime\n`);
      client.res.write(`data: ${message}\n\n`);
      sseDelivered += 1;
    } catch {
      sseClients.delete(id);
    }
  }

  return { wsDelivered, sseDelivered };
}

async function publishRealtimeMessage({
  channel = "system",
  eventType = "message",
  source = "public-api",
  message = "",
  payload = {},
  apiKey = {},
  connectionId = null,
  requestId = null,
  metadata = {},
} = {}) {
  const normalizedChannel = normalizeChannel(channel);
  const channelRow = await ensureChannel(normalizedChannel);
  const messageId = `rtmsg_${crypto.randomUUID().replace(/-/g, "")}`;
  const eventId = `evt_${crypto.randomUUID().replace(/-/g, "")}`;

  const delivered = broadcastRealtime({
    id: messageId,
    channel: normalizedChannel,
    eventType,
    message,
    payload,
    createdAt: new Date().toISOString(),
  });

  await dbQuery(
    `
      INSERT INTO backend_realtime_messages (
        id,
        channel_id,
        channel,
        event_type,
        source,
        message,
        payload_json,
        status,
        delivered_ws_count,
        delivered_sse_count,
        api_key_id,
        connection_id,
        request_id,
        metadata_json,
        organization_id,
        project_id,
        environment_id
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'recorded',$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)
    `,
    [
      messageId,
      channelRow.id,
      normalizedChannel,
      String(eventType || "message"),
      String(source || "public-api"),
      String(message || ""),
      JSON.stringify(payload || {}),
      delivered.wsDelivered,
      delivered.sseDelivered,
      apiKey?.id || null,
      connectionId,
      requestId,
      JSON.stringify(metadata || {}),
      apiKey?.organizationId || "org_goodos",
      apiKey?.projectId || "proj_goodos_platform",
      apiKey?.environmentId || "env_goodos_production",
    ]
  );

  await dbQuery(
    `
      INSERT INTO backend_realtime_events (
        id,
        event_type,
        source,
        channel,
        message,
        payload,
        status,
        message_id,
        delivered_ws_count,
        delivered_sse_count,
        metadata_json,
        organization_id,
        project_id,
        environment_id
      )
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,'recorded',$7,$8,$9,$10::jsonb,$11,$12,$13)
    `,
    [
      eventId,
      String(eventType || "message"),
      String(source || "public-api"),
      normalizedChannel,
      String(message || ""),
      JSON.stringify(payload || {}),
      messageId,
      delivered.wsDelivered,
      delivered.sseDelivered,
      JSON.stringify(metadata || {}),
      apiKey?.organizationId || "org_goodos",
      apiKey?.projectId || "proj_goodos_platform",
      apiKey?.environmentId || "env_goodos_production",
    ]
  );

  await dbQuery(
    `
      UPDATE backend_realtime_channels
      SET
        message_count = message_count + 1,
        last_message_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
    `,
    [channelRow.id]
  );

  return {
    id: messageId,
    eventId,
    channel: normalizedChannel,
    eventType,
    message,
    payload,
    delivered,
  };
}

function registerSseClient({ res, channel, apiKey, request }) {
  const connectionId = `rtsse_${crypto.randomUUID().replace(/-/g, "")}`;
  const normalizedChannel = normalizeChannel(channel);
  const client = { id: connectionId, res, channel: normalizedChannel, apiKey };
  sseClients.set(connectionId, client);

  recordConnection({
    connectionId,
    transport: "sse",
    channel: normalizedChannel,
    apiKey,
    request,
  }).catch(() => null);

  const connectedPayload = {
    type: "connected",
    connectionId,
    channel: normalizedChannel,
    transport: "sse",
    connectedAt: new Date().toISOString(),
  };

  res.write(`event: connected\n`);
  res.write(`data: ${JSON.stringify(connectedPayload)}\n\n`);

  const interval = setInterval(() => {
    try {
      res.write(`event: ping\n`);
      res.write(`data: ${JSON.stringify({ time: new Date().toISOString(), channel: normalizedChannel })}\n\n`);
    } catch {
      clearInterval(interval);
      sseClients.delete(connectionId);
      markConnectionClosed(connectionId, null, "sse write failed");
    }
  }, 25000);

  request.on("close", () => {
    clearInterval(interval);
    sseClients.delete(connectionId);
    markConnectionClosed(connectionId, null, "sse closed");
  });

  return connectionId;
}

function attachRealtimeWebSocketServer(server, options = {}) {
  if (!server || server.goodosRealtimeV2Attached) return null;

  const path = options.path || "/api/v1/realtime/ws";
  const wss = new WebSocketServer({ noServer: true });
  server.goodosRealtimeV2Attached = true;

  server.on("upgrade", async (request, socket, head) => {
    let url;

    try {
      url = new URL(request.url, "http://127.0.0.1");
    } catch {
      socket.destroy();
      return;
    }

    if (url.pathname !== path) return;

    try {
      const rawKey =
        url.searchParams.get("api_key") ||
        url.searchParams.get("apiKey") ||
        request.headers["x-goodos-api-key"] ||
        "";

      const apiKey = await authenticateRealtimeApiKey(rawKey);

      if (!hasScope(apiKey, "subscribe:realtime")) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      const channel = normalizeChannel(url.searchParams.get("channel") || "system");

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request, { apiKey, channel });
      });
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
    }
  });

  wss.on("connection", (ws, request, context = {}) => {
    const connectionId = `rtws_${crypto.randomUUID().replace(/-/g, "")}`;
    const apiKey = context.apiKey || {};
    let channel = normalizeChannel(context.channel || "system");

    const client = { id: connectionId, ws, channel, apiKey };
    wsClients.set(connectionId, client);

    recordConnection({
      connectionId,
      transport: "websocket",
      channel,
      apiKey,
      request,
    }).catch(() => null);

    ws.send(JSON.stringify({
      type: "connected",
      connectionId,
      channel,
      transport: "websocket",
      connectedAt: new Date().toISOString(),
    }));

    ws.on("message", async (data) => {
      try {
        const input = JSON.parse(String(data || "{}"));
        const type = String(input.type || "message");

        if (type === "subscribe") {
          channel = normalizeChannel(input.channel || channel);
          client.channel = channel;

          await recordConnection({
            connectionId,
            transport: "websocket",
            channel,
            apiKey,
            request,
          });

          ws.send(JSON.stringify({
            type: "subscribed",
            connectionId,
            channel,
            subscribedAt: new Date().toISOString(),
          }));
          return;
        }

        if (type === "ping") {
          ws.send(JSON.stringify({ type: "pong", time: new Date().toISOString() }));
          return;
        }

        if (type === "publish") {
          if (!hasScope(apiKey, "publish:realtime")) {
            ws.send(JSON.stringify({ type: "error", message: "Missing publish:realtime scope." }));
            return;
          }

          const published = await publishRealtimeMessage({
            channel: input.channel || channel,
            eventType: input.eventType || "realtime.websocket.message",
            source: "websocket",
            message: input.message || "",
            payload: input.payload || {},
            apiKey,
            connectionId,
            metadata: { transport: "websocket" },
          });

          ws.send(JSON.stringify({ type: "published", ...published }));
          return;
        }

        ws.send(JSON.stringify({
          type: "error",
          message: `Unsupported realtime message type: ${type}`,
        }));
      } catch (error) {
        ws.send(JSON.stringify({
          type: "error",
          message: error.message || "Realtime message failed.",
        }));
      }
    });

    ws.on("close", (code, reason) => {
      wsClients.delete(connectionId);
      markConnectionClosed(connectionId, code, reason ? reason.toString() : "");
    });

    ws.on("error", () => {
      wsClients.delete(connectionId);
      markConnectionClosed(connectionId, null, "websocket error");
    });
  });

  console.log(`GoodOS Realtime V2 WebSocket server attached at ${path}`);

  return wss;
}

function getRealtimeClientStats() {
  return {
    websocketClients: wsClients.size,
    sseClients: sseClients.size,
    totalClients: wsClients.size + sseClients.size,
  };
}

module.exports = {
  attachRealtimeWebSocketServer,
  authenticateRealtimeApiKey,
  publishRealtimeMessage,
  registerSseClient,
  broadcastRealtime,
  getRealtimeClientStats,
  normalizeChannel,
  hasScope,
};
