const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const router = express.Router();

const DB_PATH = path.resolve(
  process.env.GOODOS_VOICE_DB_PATH ||
  path.join(process.cwd(), "data", "goodos-voice-db.json")
);

const TABLES = {
  numbers: "voice_numbers",
  agents: "voice_agents",
  routes: "voice_routes",
  "business-hours": "voice_business_hours",
  queues: "voice_queues",
  "voicemail-profiles": "voice_voicemail_profiles",
  "call-logs": "voice_call_logs",
  "active-calls": "voice_active_calls",
  "call-events": "voice_call_events",
  "route-decisions": "voice_route_decisions"
};

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function ensureDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(DB_PATH)) {
    const fresh = {};
    for (const table of Object.values(TABLES)) fresh[table] = [];
    fs.writeFileSync(DB_PATH, JSON.stringify(fresh, null, 2));
  }

  let db = {};
  try {
    db = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch (err) {
    db = {};
  }

  let changed = false;
  for (const table of Object.values(TABLES)) {
    if (!Array.isArray(db[table])) {
      db[table] = [];
      changed = true;
    }
  }

  if (changed) saveDb(db);
  return db;
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function normalizeNumber(value) {
  return String(value || "").trim();
}

function listTable(tableName) {
  return (req, res) => {
    const db = ensureDb();
    return res.json(db[tableName]);
  };
}

function createTableRecord(tableName, prefix) {
  return (req, res) => {
    const db = ensureDb();
    const record = {
      id: req.body && req.body.id ? req.body.id : makeId(prefix),
      ...(req.body || {}),
      created_at: (req.body && req.body.created_at) || nowIso(),
      updated_at: nowIso()
    };

    db[tableName].push(record);
    saveDb(db);
    return res.status(201).json(record);
  };
}

function updateTableRecord(tableName) {
  return (req, res) => {
    const db = ensureDb();
    const idx = db[tableName].findIndex((row) => String(row.id) === String(req.params.id));

    if (idx < 0) {
      return res.status(404).json({
        success: false,
        message: `${tableName} record not found`
      });
    }

    db[tableName][idx] = {
      ...db[tableName][idx],
      ...(req.body || {}),
      updated_at: nowIso()
    };

    saveDb(db);
    return res.json(db[tableName][idx]);
  };
}

function deleteTableRecord(tableName) {
  return (req, res) => {
    const db = ensureDb();
    const before = db[tableName].length;

    db[tableName] = db[tableName].filter((row) => String(row.id) !== String(req.params.id));

    if (db[tableName].length === before) {
      return res.status(404).json({
        success: false,
        message: `${tableName} record not found`
      });
    }

    saveDb(db);
    return res.json({
      success: true,
      deleted: true,
      id: req.params.id
    });
  };
}

function crud(pathName, tableName, prefix) {
  router.get(pathName, listTable(tableName));
  router.post(pathName, createTableRecord(tableName, prefix));
  router.patch(`${pathName}/:id`, updateTableRecord(tableName));
  router.delete(`${pathName}/:id`, deleteTableRecord(tableName));
}

router.get("/health", (req, res) => {
  let databaseConnected = false;
  let tablesReady = false;

  try {
    const db = ensureDb();
    databaseConnected = true;
    tablesReady = Object.values(TABLES).every((table) => Array.isArray(db[table]));
  } catch (err) {
    databaseConnected = false;
    tablesReady = false;
  }

  return res.json({
    status: "ok",
    module: "GoodOS Voice",
    database_connected: databaseConnected,
    database_persistent: true,
    voice_tables_ready: tablesReady,
    backend_api_ready: true,
    asterisk_connected: false,
    sip_trunk_connected: false,
    ami_connected: false,
    gateway_secret_configured: Boolean(process.env.GOODOS_VOICE_SECRET),
    last_gateway_event_at: (() => {
      try {
        const db = ensureDb();
        const events = db.voice_call_events || [];
        if (!events.length) return null;
        return events
          .map((event) => event.event_timestamp || event.created_at)
          .filter(Boolean)
          .sort()
          .slice(-1)[0] || null;
      } catch (_) {
        return null;
      }
    })(),
    version: "2.1.0"
  });
});

router.get("/tables", (req, res) => {
  const db = ensureDb();

  return res.json({
    success: true,
    database_path: DB_PATH,
    tables: Object.values(TABLES).map((table) => ({
      name: table,
      count: db[table].length
    }))
  });
});

crud("/numbers", TABLES.numbers, "num");
crud("/agents", TABLES.agents, "agent");
crud("/routes", TABLES.routes, "route");
crud("/business-hours", TABLES["business-hours"], "hours");
crud("/queues", TABLES.queues, "queue");
crud("/voicemail-profiles", TABLES["voicemail-profiles"], "vm");
crud("/call-logs", TABLES["call-logs"], "cdr");

router.patch("/agents/:id/status", (req, res) => {
  const db = ensureDb();
  const idx = db.voice_agents.findIndex((row) => String(row.id) === String(req.params.id));

  if (idx < 0) {
    return res.status(404).json({
      success: false,
      message: "voice agent not found"
    });
  }

  db.voice_agents[idx] = {
    ...db.voice_agents[idx],
    current_status: req.body.current_status || req.body.currentStatus || req.body.status || "available",
    updated_at: nowIso()
  };

  saveDb(db);
  return res.json(db.voice_agents[idx]);
});

router.get("/active-calls", (req, res) => {
  const db = ensureDb();
  return res.json(db.voice_active_calls);
});

router.get("/route-decisions", (req, res) => {
  const db = ensureDb();
  return res.json(db.voice_route_decisions);
});

router.get("/call-events", (req, res) => {
  const db = ensureDb();
  return res.json(db.voice_call_events);
});

router.get("/call-logs/export", (req, res) => {
  const db = ensureDb();
  const rows = db.voice_call_logs;

  const headers = [
    "call_id",
    "from_number",
    "to_number",
    "partner_name",
    "department",
    "selected_agent_name",
    "action",
    "result",
    "duration_seconds",
    "wait_seconds",
    "started_at",
    "answered_at",
    "ended_at"
  ];

  const csv = [
    headers.join(","),
    ...rows.map((row) =>
      headers.map((key) => {
        const value = row[key] === undefined || row[key] === null ? "" : String(row[key]);
        return `"${value.replace(/"/g, '""')}"`;
      }).join(",")
    )
  ].join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=goodos-voice-call-logs.csv");
  return res.send(csv);
});

router.post("/route-call", (req, res) => {
  const started = Date.now();
  const db = ensureDb();

  const callId = req.body.call_id || req.body.callId || makeId("call");
  const fromNumber = normalizeNumber(req.body.from_number || req.body.fromNumber);
  const toNumber = normalizeNumber(req.body.to_number || req.body.toNumber);
  const classification = req.body.classification || req.body.department || "General";

  const voiceNumber = db.voice_numbers.find((number) => {
    const storedNumber = normalizeNumber(number.phone_number || number.phoneNumber);
    const status = String(number.status || "active").toLowerCase();
    return storedNumber === toNumber && status !== "disabled" && number.is_active !== false;
  });

  let response;

  if (!voiceNumber) {
    response = {
      action: "reject",
      reason: "No active voice number found"
    };
  } else {
    const route = db.voice_routes.find((item) => {
      const routeNumberId = item.incoming_number_id || item.incomingNumberId || item.voice_number_id || item.voiceNumberId;
      const routeToNumber = normalizeNumber(item.to_number || item.toNumber || item.phone_number || item.phoneNumber);
      const routeDept = item.department || item.classification;

      const numberMatches =
        String(routeNumberId || "") === String(voiceNumber.id) ||
        routeToNumber === toNumber;

      const deptMatches =
        !routeDept ||
        String(routeDept).toLowerCase() === String(classification).toLowerCase();

      const active = String(item.status || "active").toLowerCase() !== "disabled" && item.is_active !== false;

      return numberMatches && deptMatches && active;
    });

    if (!route) {
      response = {
        action: "reject",
        reason: "No active route found"
      };
    } else {
      const assignedIds = Array.isArray(route.assigned_agent_ids)
        ? route.assigned_agent_ids
        : Array.isArray(route.assignedAgentIds)
          ? route.assignedAgentIds
          : [];

      const availableAgents = db.voice_agents.filter((agent) => {
        const agentStatus = String(agent.current_status || agent.currentStatus || "available").toLowerCase();
        const accountStatus = String(agent.status || "active").toLowerCase();
        const assigned = assignedIds.length === 0 || assignedIds.map(String).includes(String(agent.id));

        return assigned &&
          agentStatus === "available" &&
          accountStatus !== "disabled" &&
          agent.is_active !== false;
      });

      if (availableAgents.length > 0) {
        const selected = availableAgents.sort((a, b) => Number(a.priority || 999) - Number(b.priority || 999))[0];

        response = {
          action: "dial_agent",
          agent_id: selected.id,
          agent_name: selected.name,
          agent_phone: selected.direct_phone_number || selected.directPhoneNumber || selected.phone_number || selected.phoneNumber,
          extension: selected.extension,
          timeout_seconds: Number(route.timeout_seconds || route.timeoutSeconds || 25)
        };
      } else if (route.queue_id || route.queueId) {
        const queueId = route.queue_id || route.queueId;
        const queue = db.voice_queues.find((item) => String(item.id) === String(queueId));

        response = {
          action: "queue",
          queue_id: queueId,
          queue_name: queue ? queue.queue_name || queue.queueName : "GoodOS Voice Queue"
        };
      } else if (route.voicemail_profile_id || route.voicemailProfileId) {
        response = {
          action: "voicemail",
          voicemail_profile_id: route.voicemail_profile_id || route.voicemailProfileId
        };
      } else {
        response = {
          action: "reject",
          reason: "No available agent or fallback route"
        };
      }
    }
  }

  db.voice_route_decisions.push({
    id: makeId("decision"),
    call_id: callId,
    from_number: fromNumber,
    to_number: toNumber,
    classification,
    decision_action: response.action,
    selected_agent_id: response.agent_id || null,
    selected_queue_id: response.queue_id || null,
    selected_voicemail_profile_id: response.voicemail_profile_id || null,
    reject_reason: response.reason || null,
    decision_time_ms: Date.now() - started,
    raw_request: req.body,
    raw_response: response,
    created_at: nowIso()
  });

  if (["dial_agent", "queue", "voicemail"].includes(response.action)) {
    db.voice_active_calls.push({
      id: makeId("active"),
      call_id: callId,
      from_number: fromNumber,
      to_number: toNumber,
      selected_agent_id: response.agent_id || null,
      selected_agent_name: response.agent_name || null,
      current_status: response.action,
      route_path: response.action,
      started_at: nowIso(),
      last_event_at: nowIso(),
      raw_payload: req.body
    });
  }

  saveDb(db);
  return res.json(response);
});

router.post("/call-event", (req, res) => {
  const db = ensureDb();

  const event = {
    id: makeId("event"),
    call_id: req.body.call_id || req.body.callId || null,
    event_type: req.body.event_type || req.body.eventType || "Unknown",
    event_source: req.body.event_source || req.body.eventSource || "goodos_voice",
    event_timestamp: req.body.event_timestamp || req.body.eventTimestamp || nowIso(),
    channel_id: req.body.channel_id || req.body.channelId || null,
    agent_id: req.body.agent_id || req.body.agentId || null,
    message: req.body.message || "",
    raw_event: req.body.raw_event || req.body.rawEvent || req.body,
    created_at: nowIso()
  };

  db.voice_call_events.push(event);

  const callId = event.call_id;
  if (callId) {
    const active = db.voice_active_calls.find((call) => String(call.call_id) === String(callId));
    if (active) {
      active.current_status = event.event_type;
      active.last_event_at = event.event_timestamp;
    }

    if (["Hangup", "BridgeLeave", "Voicemail", "RouteFailed"].includes(event.event_type)) {
      db.voice_active_calls = db.voice_active_calls.filter((call) => String(call.call_id) !== String(callId));

      db.voice_call_logs.push({
        id: makeId("cdr"),
        call_id: callId,
        from_number: active ? active.from_number : null,
        to_number: active ? active.to_number : null,
        selected_agent_id: active ? active.selected_agent_id : null,
        selected_agent_name: active ? active.selected_agent_name : null,
        action: active ? active.route_path : null,
        result: event.event_type,
        started_at: active ? active.started_at : null,
        ended_at: nowIso(),
        raw_payload: {
          active_call: active || null,
          final_event: event
        },
        created_at: nowIso(),
        updated_at: nowIso()
      });
    }
  }

  saveDb(db);
  return res.status(201).json({
    success: true,
    event
  });
});

router.post("/seed-demo", (req, res) => {
  const db = ensureDb();

  // Make demo seeding idempotent: remove previous demo rows first.
  for (const table of Object.values(TABLES)) {
    db[table] = db[table].filter((row) => row.demo_data !== true);
  }

  db.voice_numbers.push(
    {
      id: "num_demo_001",
      phone_number: "+17145550101",
      label: "Transparency Sales Line",
      partner_name: "Transparency Partner",
      department: "Sales",
      routing_mode: "priority",
      status: "active",
      demo_data: true,
      created_at: nowIso(),
      updated_at: nowIso()
    },
    {
      id: "num_demo_002",
      phone_number: "+17145550102",
      label: "Support Line",
      partner_name: "GoodOS Support",
      department: "Support",
      routing_mode: "round_robin",
      status: "active",
      demo_data: true,
      created_at: nowIso(),
      updated_at: nowIso()
    }
  );

  db.voice_agents.push(
    {
      id: "agent_demo_001",
      name: "Demo Agent One",
      extension: "101",
      direct_phone_number: "+17145559876",
      email: "agent1@example.com",
      partner_name: "Transparency Partner",
      skills: ["Sales", "General"],
      priority: 1,
      max_concurrent_calls: 1,
      current_status: "available",
      status: "active",
      demo_data: true,
      created_at: nowIso(),
      updated_at: nowIso()
    },
    {
      id: "agent_demo_002",
      name: "Demo Agent Two",
      extension: "102",
      direct_phone_number: "+17145559877",
      email: "agent2@example.com",
      partner_name: "GoodOS Support",
      skills: ["Support", "General"],
      priority: 2,
      max_concurrent_calls: 1,
      current_status: "available",
      status: "active",
      demo_data: true,
      created_at: nowIso(),
      updated_at: nowIso()
    }
  );

  db.voice_routes.push(
    {
      id: "route_demo_001",
      incoming_number_id: "num_demo_001",
      partner_name: "Transparency Partner",
      department: "Sales",
      routing_strategy: "priority",
      assigned_agent_ids: ["agent_demo_001"],
      status: "active",
      demo_data: true,
      created_at: nowIso(),
      updated_at: nowIso()
    },
    {
      id: "route_demo_002",
      incoming_number_id: "num_demo_002",
      partner_name: "GoodOS Support",
      department: "Support",
      routing_strategy: "round_robin",
      assigned_agent_ids: ["agent_demo_002"],
      status: "active",
      demo_data: true,
      created_at: nowIso(),
      updated_at: nowIso()
    }
  );

  saveDb(db);

  return res.json({
    success: true,
    message: "GoodOS Voice demo data seeded"
  });
});

router.delete("/demo-data", (req, res) => {
  const db = ensureDb();

  for (const table of Object.values(TABLES)) {
    db[table] = db[table].filter((row) => row.demo_data !== true);
  }

  saveDb(db);

  return res.json({
    success: true,
    message: "GoodOS Voice demo data cleared"
  });
});

module.exports = router;
