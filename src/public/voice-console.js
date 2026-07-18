const API_BASE = window.location.origin;

const endpoints = [
  "/api/voice/health",
  "/api/voice/tables",
  "/api/voice/numbers",
  "/api/voice/agents",
  "/api/voice/routes",
  "/api/voice/business-hours",
  "/api/voice/queues",
  "/api/voice/voicemail-profiles",
  "/api/voice/active-calls",
  "/api/voice/call-events",
  "/api/voice/route-decisions",
  "/api/voice/call-logs"
];

function el(id) {
  return document.getElementById(id);
}

function pretty(data) {
  return JSON.stringify(data, null, 2);
}

function setOutput(title, data) {
  const target = el("diagnosticsOutput");
  if (!target) return;
  target.textContent = `${title}\n\n${typeof data === "string" ? data : pretty(data)}`;
}

function statusClass(ok, warn = false) {
  if (ok) return "pill good";
  if (warn) return "pill warn";
  return "pill bad";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, options = {}) {
  const started = performance.now();

  const response = await fetch(API_BASE + path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const text = await response.text();
  let data = text;

  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {}

  return {
    path,
    ok: response.ok,
    status: response.status,
    ms: Math.round(performance.now() - started),
    data
  };
}

function table(headers, rows) {
  if (!rows || rows.length === 0) {
    return '<div class="small">No records yet.</div>';
  }

  return `
    <table>
      <thead>
        <tr>${headers.map(h => `<th>${h.label}</th>`).join("")}</tr>
      </thead>
      <tbody>
        ${rows.map(row => `
          <tr>
            ${headers.map(h => `<td>${h.render ? h.render(row) : escapeHtml(row[h.key] ?? "")}</td>`).join("")}
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

async function runHealth() {
  try {
    const result = await api("/api/voice/health");
    const h = result.data || {};

    el("backendValue").textContent = h.backend_api_ready ? "Connected" : "Issue";
    el("backendSub").textContent = `HTTP ${result.status} • ${result.ms}ms`;

    el("databaseValue").textContent = h.database_connected ? "Persistent" : "Offline";
    el("databaseSub").textContent = h.voice_tables_ready ? "Voice tables ready" : "Voice tables not ready";

    el("gatewayValue").textContent = h.gateway_secret_configured ? "Secured" : "Open";
    el("gatewaySub").textContent = h.last_gateway_event_at ? `Last event: ${h.last_gateway_event_at}` : "No gateway events yet";

    el("overallStatus").className = statusClass(result.ok && h.database_connected);
    el("overallStatus").textContent = result.ok ? "Operational" : "Issue";

    setOutput("Health Check Result", result);
    return result;
  } catch (err) {
    el("overallStatus").className = "pill bad";
    el("overallStatus").textContent = "Error";
    setOutput("Health Check Failed", String(err.stack || err));
  }
}

async function testAllEndpoints() {
  const results = [];

  for (const endpoint of endpoints) {
    try {
      results.push(await api(endpoint));
    } catch (err) {
      results.push({
        path: endpoint,
        ok: false,
        status: "ERROR",
        ms: 0,
        error: String(err.message || err)
      });
    }
  }

  setOutput("All Endpoint Test Results", results);
  await refreshLiveData();
}

async function testRouteDecision() {
  const payload = {
    call_id: "frontend_voice_console_test_" + Date.now(),
    from_number: "+17145551212",
    to_number: "+17145550101",
    classification: "Sales"
  };

  const result = await api("/api/voice/route-call", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  setOutput("Route Decision Test", {
    request: payload,
    response: result
  });

  await refreshLiveData();
}

async function sendCallEvent() {
  const payload = {
    call_id: "frontend_voice_console_event_" + Date.now(),
    event_type: "Ringing",
    event_source: "voice_console",
    channel_id: "voice-console-channel",
    agent_id: "agent_demo_001",
    message: "GoodOS Voice Console manual test event"
  };

  const result = await api("/api/voice/call-event", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  setOutput("Call Event Test", {
    request: payload,
    response: result
  });

  await refreshLiveData();
}

async function seedDemo() {
  const result = await api("/api/voice/seed-demo", {
    method: "POST",
    body: JSON.stringify({})
  });

  setOutput("Seed Demo Data", result);
  await refreshLiveData();
}

async function clearActiveCalls() {
  const active = await api("/api/voice/active-calls");
  const calls = Array.isArray(active.data) ? active.data : [];
  const results = [];

  for (const call of calls) {
    const payload = {
      call_id: call.call_id,
      event_type: "Hangup",
      event_source: "voice_console_cleanup",
      channel_id: "voice-console-cleanup",
      message: "Cleared from GoodOS Voice Console"
    };

    results.push(await api("/api/voice/call-event", {
      method: "POST",
      body: JSON.stringify(payload)
    }));
  }

  setOutput("Clear Active Calls", {
    cleared_count: calls.length,
    results
  });

  await refreshLiveData();
}

async function refreshLiveData() {
  const [health, numbers, agents, routes, active, events, decisions, logs] = await Promise.all([
    api("/api/voice/health"),
    api("/api/voice/numbers"),
    api("/api/voice/agents"),
    api("/api/voice/routes"),
    api("/api/voice/active-calls"),
    api("/api/voice/call-events"),
    api("/api/voice/route-decisions"),
    api("/api/voice/call-logs")
  ]);

  const h = health.data || {};

  el("backendValue").textContent = h.backend_api_ready ? "Connected" : "Issue";
  el("backendSub").textContent = `Voice API ${health.status}`;

  el("databaseValue").textContent = h.database_connected ? "Persistent" : "Offline";
  el("databaseSub").textContent = h.voice_tables_ready ? "Voice records mapped" : "Missing voice tables";

  el("gatewayValue").textContent = h.gateway_secret_configured ? "Secured" : "Open";
  el("gatewaySub").textContent = h.last_gateway_event_at ? `Last event: ${h.last_gateway_event_at}` : "No gateway events";

  el("overallStatus").className = statusClass(health.ok && h.database_connected);
  el("overallStatus").textContent = health.ok ? "Operational" : "Issue";

  const numbersData = Array.isArray(numbers.data) ? numbers.data : [];
  const agentsData = Array.isArray(agents.data) ? agents.data : [];
  const routesData = Array.isArray(routes.data) ? routes.data : [];
  const activeData = Array.isArray(active.data) ? active.data : [];
  const eventsData = Array.isArray(events.data) ? events.data : [];
  const decisionsData = Array.isArray(decisions.data) ? decisions.data : [];
  const logsData = Array.isArray(logs.data) ? logs.data : [];

  el("activeValue").textContent = activeData.length;
  el("activeSub").textContent = activeData.length ? "Calls currently in progress" : "No active calls";

  el("numbersCount").textContent = numbersData.length;
  el("agentsCount").textContent = agentsData.length;
  el("routesCount").textContent = routesData.length;
  el("activeCount").textContent = activeData.length;
  el("eventsCount").textContent = eventsData.length;
  el("decisionsCount").textContent = decisionsData.length;
  el("logsCount").textContent = logsData.length;

  el("numbersTable").innerHTML = table([
    { label: "Label", key: "label" },
    { label: "Number", key: "phone_number" },
    { label: "Partner", key: "partner_name" },
    { label: "Department", key: "department" },
    { label: "Status", key: "status", render: r => `<span class="status-dot good">${escapeHtml(r.status || "active")}</span>` }
  ], numbersData);

  el("agentsTable").innerHTML = table([
    { label: "Name", key: "name" },
    { label: "Ext", key: "extension" },
    { label: "Phone", key: "direct_phone_number" },
    { label: "Status", key: "current_status", render: r => `<span class="status-dot ${r.current_status === "available" ? "good" : "warn"}">${escapeHtml(r.current_status || "unknown")}</span>` }
  ], agentsData);

  el("routesTable").innerHTML = table([
    { label: "Route", key: "id" },
    { label: "Number ID", key: "incoming_number_id" },
    { label: "Partner", key: "partner_name" },
    { label: "Department", key: "department" },
    { label: "Strategy", key: "routing_strategy" },
    { label: "Agents", key: "assigned_agent_ids", render: r => escapeHtml((r.assigned_agent_ids || []).join(", ")) }
  ], routesData);

  el("activeTable").innerHTML = table([
    { label: "Call ID", key: "call_id" },
    { label: "From", key: "from_number" },
    { label: "To", key: "to_number" },
    { label: "Status", key: "current_status" },
    { label: "Agent", key: "selected_agent_name" }
  ], activeData.slice(-10).reverse());

  el("eventsTable").innerHTML = table([
    { label: "Time", key: "event_timestamp" },
    { label: "Call ID", key: "call_id" },
    { label: "Event", key: "event_type" },
    { label: "Source", key: "event_source" }
  ], eventsData.slice(-10).reverse());

  el("decisionsTable").innerHTML = table([
    { label: "Time", key: "created_at" },
    { label: "Call ID", key: "call_id" },
    { label: "To", key: "to_number" },
    { label: "Decision", key: "decision_action" },
    { label: "Agent", key: "selected_agent_id" }
  ], decisionsData.slice(-10).reverse());

  el("logsTable").innerHTML = table([
    { label: "Ended", key: "ended_at" },
    { label: "Call ID", key: "call_id" },
    { label: "Action", key: "action" },
    { label: "Result", key: "result" },
    { label: "Agent", key: "selected_agent_name" }
  ], logsData.slice(-10).reverse());

  return {
    health,
    numbers,
    agents,
    routes,
    active,
    events,
    decisions,
    logs
  };
}

function wireButtons() {
  const actions = {
    runHealth,
    testAllEndpoints,
    testRouteDecision,
    sendCallEvent,
    refreshLiveData,
    seedDemo,
    clearActiveCalls
  };

  document.querySelectorAll("[data-action]").forEach((button) => {
    const actionName = button.getAttribute("data-action");
    const fn = actions[actionName];

    if (!fn) return;

    button.addEventListener("click", async () => {
      button.disabled = true;
      const oldText = button.textContent;
      button.textContent = "Working...";

      try {
        await fn();
      } catch (err) {
        setOutput(`${oldText} Failed`, String(err.stack || err));
      } finally {
        button.disabled = false;
        button.textContent = oldText;
      }
    });
  });
}

document.addEventListener("DOMContentLoaded", () => {
  wireButtons();

  refreshLiveData()
    .then(() => setOutput("GoodOS Voice Console Ready", {
      api_base: API_BASE,
      message: "Live data loaded successfully."
    }))
    .catch(err => setOutput("Initial Load Failed", String(err.stack || err)));
});
