const crypto = require("crypto");
const database = require("../src/config/database");

function dbQuery(sql, params = []) {
  if (typeof database.query === "function") return database.query(sql, params);
  if (database.pool && typeof database.pool.query === "function") return database.pool.query(sql, params);
  if (typeof database.getPool === "function") return database.getPool().query(sql, params);
  if (database.default && typeof database.default.query === "function") return database.default.query(sql, params);
  throw new Error("Database query function not found");
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function sign(secret, body) {
  return "sha256=" + crypto.createHmac("sha256", String(secret || "")).update(body).digest("hex");
}

async function main() {
  const webhookResult = await dbQuery(
    `
      SELECT id, name, url, secret, status
      FROM backend_webhooks
      WHERE id = 'wh_builtin_receiver'
      LIMIT 1
    `
  );

  const webhook = webhookResult.rows[0];

  if (!webhook) throw new Error("Built In Test Receiver webhook is missing.");
  if (webhook.status !== "active") throw new Error("Built In Test Receiver webhook is not active.");

  const eventId = randomId("evt");
  const deliveryId = randomId("whdel");

  const payload = {
    id: eventId,
    type: "webhook.test",
    source: "terminal-delivery-test",
    createdAt: new Date().toISOString(),
    data: {
      message: "GoodAppBackEnd terminal webhook delivery test.",
      webhookId: webhook.id,
      webhookName: webhook.name,
    },
  };

  const rawBody = JSON.stringify(payload);

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "GoodAppBackEnd-Webhooks/1.0",
    "X-GoodOS-Event": payload.type,
    "X-GoodOS-Webhook-Id": webhook.id,
    "X-GoodOS-Delivery-Id": deliveryId,
    "X-GoodOS-Signature": sign(webhook.secret, rawBody),
  };

  await dbQuery(
    `
      INSERT INTO backend_events (id, event_type, source, message, payload)
      VALUES ($1, $2, $3, $4, $5::jsonb)
      ON CONFLICT (id) DO NOTHING
    `,
    [
      eventId,
      payload.type,
      payload.source,
      "Terminal webhook delivery test",
      rawBody,
    ]
  );

  await dbQuery(
    `
      INSERT INTO backend_webhook_deliveries (
        id,
        webhook_id,
        event_id,
        event_type,
        url,
        request_headers,
        request_body,
        status,
        attempt_count
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'pending', 0)
    `,
    [
      deliveryId,
      webhook.id,
      eventId,
      payload.type,
      webhook.url,
      JSON.stringify(headers),
      rawBody,
    ]
  );

  try {
    const response = await fetch(webhook.url, {
      method: "POST",
      headers,
      body: rawBody,
    });

    const responseText = await response.text();
    const responseHeaders = Object.fromEntries(response.headers.entries());
    const delivered = response.status >= 200 && response.status < 300;

    await dbQuery(
      `
        UPDATE backend_webhook_deliveries
        SET
          response_status = $1,
          response_headers = $2::jsonb,
          response_body = $3,
          status = $4,
          attempt_count = attempt_count + 1,
          error_message = $5,
          delivered_at = $6,
          updated_at = NOW()
        WHERE id = $7
      `,
      [
        response.status,
        JSON.stringify(responseHeaders),
        responseText.slice(0, 10000),
        delivered ? "delivered" : "failed",
        delivered ? null : `HTTP ${response.status}`,
        delivered ? new Date() : null,
        deliveryId,
      ]
    );

    await dbQuery(
      `
        UPDATE backend_webhooks
        SET last_triggered_at = NOW()
        WHERE id = $1
      `,
      [webhook.id]
    );

    console.log(JSON.stringify({
      success: true,
      deliveryId,
      eventId,
      status: delivered ? "delivered" : "failed",
      responseStatus: response.status,
      responseBody: responseText.slice(0, 500),
    }, null, 2));
  } catch (error) {
    await dbQuery(
      `
        UPDATE backend_webhook_deliveries
        SET
          status = 'failed',
          attempt_count = attempt_count + 1,
          error_message = $1,
          next_retry_at = NOW() + INTERVAL '5 minutes',
          updated_at = NOW()
        WHERE id = $2
      `,
      [error.message, deliveryId]
    );

    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
