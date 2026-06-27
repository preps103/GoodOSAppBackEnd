(function () {
  "use strict";

  const state = {
    view: (location.hash || "#overview").replace("#", "") || "overview",
    health: "checking"
  };

  const titles = {
    overview: ["Build and run your backend from one control center", "GoodOS Cloud provides the database, auth, storage, functions, realtime, jobs, billing, notifications, and encrypted secrets your applications need to scale with confidence."],
    projects: ["Projects", "Create and manage customer projects, environments, applications, and backend hosting workspaces."],
    database: ["Database", "Build hosted database APIs, table permissions, row access rules, and managed data workflows."],
    auth: ["Authentication", "Manage users, sessions, roles, permissions, MFA, password reset, and team access."],
    storage: ["Storage", "Host files, configure buckets, connect S3-compatible providers, and manage CDN-ready routes."],
    realtime: ["Realtime", "Stream events, presence, channels, subscriptions, and live app updates."],
    functions: ["Functions", "Deploy secure runtime functions, versions, secrets, and environment-based triggers."],
    jobs: ["Jobs", "Run scheduled jobs, queue workers, retries, locks, and background automations."],
    logs: ["Logs", "Review system events, audit trails, API usage, delivery logs, and operational activity."],
    monitoring: ["Monitoring", "Track uptime, usage, infrastructure health, performance, and service readiness."],
    alerts: ["Alerts", "Configure notification rules, warnings, quota alerts, and important system messages."],
    backups: ["Backups", "Manage backup jobs, restore readiness, database snapshots, and disaster recovery."],
    secrets: ["Secrets", "Store encrypted secrets, rotate provider credentials, and safely connect SMTP, Stripe, S3, and AI services."],
    team: ["Team", "Manage organizations, members, roles, invitations, ownership, and access control."],
    "api-keys": ["API Keys", "Create, monitor, revoke, and meter customer API keys across projects and environments."],
    billing: ["Billing", "Manage plans, subscriptions, quotas, invoices, usage metering, and customer billing readiness."],
    settings: ["Settings", "Configure platform-level controls, environment preferences, security, and developer operations."]
  };

  function qs(selector) {
    return document.querySelector(selector);
  }

  function qsa(selector) {
    return Array.from(document.querySelectorAll(selector));
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function kpiCards() {
    return `
      <section class="kpi-grid">
        <div class="kpi"><small>API Requests · Last 24 hours</small><b>2.46M</b><span class="up">↑ 18.6%</span><div class="sparkline"></div></div>
        <div class="kpi"><small>Active Users · Last 24 hours</small><b>18.7K</b><span class="up">↑ 12.3%</span><div class="sparkline"></div></div>
        <div class="kpi"><small>Storage Used · Total</small><b>1.24 TB</b><span class="up">↑ 5.7%</span><div class="progress"><span style="width:62%"></span></div></div>
        <div class="kpi"><small>Realtime Events · Last 24 hours</small><b>4.32M</b><span class="up">↑ 23.1%</span><div class="sparkline"></div></div>
        <div class="kpi"><small>Monthly Spend · May</small><b>$1,432</b><span class="up">↓ 8.4%</span><div class="progress"><span style="width:74%"></span></div></div>
      </section>
    `;
  }

  function overview() {
    return `
      <section class="hero">
        <span class="pill"><span class="dot"></span> Production environment ${escapeHtml(state.health)}</span>
        <h1>Build and run your backend from one control center</h1>
        <p>GoodOS Cloud provides the database, auth, storage, functions, realtime, jobs, billing, notifications, and encrypted secrets your applications need to scale with confidence.</p>
        <div class="hero-art"><div class="orbit"></div><div class="cube one"></div><div class="cube two"></div><div class="cube three"></div></div>
      </section>

      ${kpiCards()}

      <section class="main-grid">
        <div class="panel">
          <div class="panel-head">
            <div>
              <h2>Project Overview</h2>
              <p>GoodOS Platform <span class="badge">Production</span></p>
            </div>
            <div class="actions"><button class="btn" type="button">Settings</button><button class="btn" type="button">View Project</button></div>
          </div>

          <div class="health">
            <div class="ring"><div><b>100</b><br><span class="muted">Excellent</span></div></div>
            <div class="list">
              <div class="row"><span><span class="dot"></span> All services operational</span><strong>Healthy</strong></div>
              <div class="row"><span><span class="dot"></span> Backups up to date</span><strong>Ready</strong></div>
              <div class="row"><span><span class="dot"></span> No critical alerts</span><strong>Clean</strong></div>
              <div class="row"><span><span class="dot"></span> Performance optimal</span><strong>Fast</strong></div>
            </div>
          </div>

          <div class="list" style="margin-top:18px;">
            ${["Database","Auth","Storage","Realtime","Functions","Jobs"].map(name => `<div class="row"><span>${name}</span><span><span class="dot"></span> Operational</span></div>`).join("")}
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <div><h2>Usage Analytics</h2><p>API Requests <strong>73.2M</strong> <span class="up">↑ 24.7%</span></p></div>
            <span class="badge">30D</span>
          </div>
          <div class="chart">
            ${[42,55,64,70,58,75,86,62,68,84,92,88,78,96,72,83,91,70,88,95,82,76,98,86].map((h, i) => `<span class="bar ${i % 5 === 0 ? "alt" : ""}" style="height:${h}%"></span>`).join("")}
          </div>
        </div>
      </section>

      <section class="lower-grid">
        <div class="panel">
          <div class="panel-head"><h3>Quick Start</h3><span class="badge">3/5</span></div>
          <div class="list">
            <div class="row"><span><span class="dot"></span> Create a new project</span><strong>Done</strong></div>
            <div class="row"><span><span class="dot"></span> Connect to your project</span><strong>Done</strong></div>
            <div class="row"><span><span class="dot"></span> Create first database table</span><strong>Done</strong></div>
            <div class="row"><span>Deploy a function</span><strong>Next</strong></div>
            <div class="row"><span>Configure authentication</span><strong>Open</strong></div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><h3>Recent Activity</h3><a href="#">View all</a></div>
          <div class="list">
            <div class="row"><span>Deployed function <code>create-user</code></span><small>2m ago</small></div>
            <div class="row"><span>Database migration <code>add_index</code></span><small>15m ago</small></div>
            <div class="row"><span>Storage file uploaded <code>avatar.png</code></span><small>1h ago</small></div>
            <div class="row"><span>Auth user signed up <code>new_user</code></span><small>2h ago</small></div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><h3>Starter Templates</h3><a href="#">View all</a></div>
          <div class="list">
            <div class="row"><span>AI Chat App<br><small class="muted">Auth, database, storage</small></span><button class="btn" type="button">Use</button></div>
            <div class="row"><span>E-commerce API<br><small class="muted">Auth, functions, webhooks</small></span><button class="btn" type="button">Use</button></div>
            <div class="row"><span>SaaS Starter<br><small class="muted">Tenant, billing, analytics</small></span><button class="btn" type="button">Use</button></div>
            <div class="row"><span>Realtime Dashboard<br><small class="muted">Events, charts, presence</small></span><button class="btn" type="button">Use</button></div>
          </div>
        </div>
      </section>

      <section class="status-strip">
        <div><span><span class="dot"></span> All Systems Operational</span><b>Updated 2m ago</b></div>
        <div><span>Database</span><b>CPU 23% · RAM 45%</b></div>
        <div><span>Functions</span><b>1.2M invocations</b></div>
        <div><span>Storage</span><b>342 GB bandwidth</b></div>
        <div><span>Edge Network</span><b>98% cache hit rate</b></div>
      </section>
    `;
  }

  function genericView(view) {
    const data = titles[view] || titles.overview;
    const name = data[0];
    const description = data[1];

    return `
      <section class="hero">
        <span class="pill"><span class="dot"></span> ${escapeHtml(name)} module ready</span>
        <h1>${escapeHtml(name)}</h1>
        <p>${escapeHtml(description)}</p>
      </section>

      <section class="simple-grid">
        <div class="simple-card">
          <h3>Overview</h3>
          <p>Manage ${escapeHtml(name.toLowerCase())} from a productized customer-ready backend hosting layer.</p>
        </div>
        <div class="simple-card">
          <h3>Configuration</h3>
          <p>Set safe defaults, environments, permissions, and operating rules before exposing this to customers.</p>
        </div>
        <div class="simple-card">
          <h3>Activity</h3>
          <p>Track changes, monitor health, and keep a clean audit trail for support and compliance.</p>
        </div>
      </section>

      <section class="panel" style="margin-top:16px;">
        <div class="panel-head">
          <div><h2>${escapeHtml(name)} Readiness</h2><p>This area is ready for the next build-out phase.</p></div>
          <span class="badge">GoodOS Cloud</span>
        </div>
        <div class="list">
          <div class="row"><span><span class="dot"></span> Customer-ready navigation</span><strong>Complete</strong></div>
          <div class="row"><span><span class="dot"></span> Backend foundation connected</span><strong>Ready</strong></div>
          <div class="row"><span><span class="dot"></span> UI shell stabilized</span><strong>Stable</strong></div>
        </div>
      </section>
    `;
  }

  function render() {
    const view = titles[state.view] ? state.view : "overview";
    state.view = view;

    const appView = qs("#appView");
    if (!appView) return;

    appView.innerHTML = view === "overview" ? overview() : genericView(view);

    qsa(".nav-btn").forEach((btn) => {
      const active = btn.dataset.view === view;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-current", active ? "page" : "false");
    });

    if (location.hash.replace("#", "") !== view) {
      history.replaceState(null, "", "#" + view);
    }
  }

  function navigate(view) {
    if (!titles[view]) view = "overview";
    state.view = view;
    render();
  }

  function bind() {
    qsa(".nav-btn").forEach((btn) => {
      btn.addEventListener("click", function () {
        navigate(btn.dataset.view);
      });
    });

    const createBtn = qs("#createProjectBtn");
    if (createBtn) {
      createBtn.addEventListener("click", function () {
        navigate("projects");
      });
    }

    window.addEventListener("hashchange", function () {
      const next = (location.hash || "#overview").replace("#", "") || "overview";
      navigate(next);
    });

    fetch("/health", { cache: "no-store" })
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        state.health = data && data.success ? "operational" : "checking";
        if (state.view === "overview") render();
      })
      .catch(() => {
        state.health = "checking";
      });
  }

  document.addEventListener("DOMContentLoaded", function () {
    bind();
    render();
  });
})();
