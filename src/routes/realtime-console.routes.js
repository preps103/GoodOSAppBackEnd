const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");

const router = express.Router();
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const SECTION_ALIASES = {
  inspector: "inspector",
  inspect: "inspector",
  channels: "channels",
  channel: "channels",
  messages: "messages",
  message: "messages",
  events: "messages",
  presence: "presence",
  users: "presence",
  online: "presence",
  policies: "policies",
  policy: "policies",
  rules: "policies",
  settings: "settings",
  setting: "settings",
  config: "settings",
  configuration: "settings"
};

const KNOWN_SECTIONS = [
  "inspector",
  "channels",
  "messages",
  "presence",
  "policies",
  "settings"
];

function nowIso() {
  return new Date().toISOString();
}

function cleanSectionKey(value) {
  const key = String(value || "")
    .trim()
    .replace(/<[^>]*>/g, "")
    .replace(/[+"'`]/g, "")
    .replace(/[.)\];,]+$/g, "")
    .replace(/^\/+|\/+$/g, "");

  return SECTION_ALIASES[key] || SECTION_ALIASES[key.toLowerCase()] || key.toLowerCase();
}

function sendError(res, status, message, extra = {}) {
  return res.status(status).json({
    success: false,
    message,
    ...extra
  });
}

function loadExistingAuthMiddleware() {
  const candidates = [
    "../middleware/auth.middleware",
    "../middleware/auth",
    "../middleware/admin-auth.middleware",
    "../middleware/adminAuth",
    "../middlewares/auth.middleware",
    "../middlewares/auth",
    "../utils/auth.middleware",
    "../utils/auth"
  ];

  const names = [
    "requireAuth",
    "authenticate",
    "authenticateToken",
    "authMiddleware",
    "verifyToken",
    "verifyAuth",
    "requireAdmin",
    "adminAuth",
    "protect",
    "default"
  ];

  for (const candidate of candidates) {
    try {
      const mod = require(candidate);

      if (typeof mod === "function") return mod;

      for (const name of names) {
        if (typeof mod?.[name] === "function") return mod[name];
      }
    } catch (_) {}
  }

  return null;
}

const existingAuthMiddleware = loadExistingAuthMiddleware();

function requireRealtimeConsoleAuth(req, res, next) {
  if (existingAuthMiddleware) {
    return existingAuthMiddleware(req, res, next);
  }

  const authHeader = String(req.headers.authorization || "");
  const hasBearer = /^Bearer\s+.+/i.test(authHeader);
  const cookie = String(req.headers.cookie || "");
  const hasSessionCookie = cookie.includes("token") || cookie.includes("session");

  if (!hasBearer && !hasSessionCookie) {
    return sendError(res, 401, "Authorization token required");
  }

  return next();
}

router.use(requireRealtimeConsoleAuth);

function safeExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch (_) {
    return false;
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch (_) {
    return null;
  }
}

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (_) {
    return [];
  }
}

function safeReadFile(filePath, maxBytes = 140000) {
  try {
    const stat = fs.statSync(filePath);
    const fd = fs.openSync(filePath, "r");
    const bytes = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytes);

    fs.readSync(fd, buffer, 0, bytes, 0);
    fs.closeSync(fd);

    return buffer.toString("utf8");
  } catch (_) {
    return "";
  }
}

function run(command, options = {}) {
  try {
    return childProcess.execSync(command, {
      cwd: options.cwd || PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: options.timeout || 5000
    }).trim();
  } catch (_) {
    return "";
  }
}

function humanBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = value;
  let i = 0;

  while (n >= 1024 && i < units.length - 1) {
    n = n / 1024;
    i++;
  }

  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function relativePath(filePath) {
  return path.relative(PROJECT_ROOT, filePath).replace(/\\/g, "/") || ".";
}

function walkFiles(startDir, options = {}) {
  const maxFiles = options.maxFiles || 2500;
  const maxDepth = options.maxDepth || 6;
  const includeRegex = options.includeRegex || null;

  const files = [];
  let folders = 0;
  let bytes = 0;
  let truncated = false;

  if (!safeExists(startDir)) {
    return { exists: false, files, folders, bytes, truncated };
  }

  function walk(currentDir, depth) {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }

    if (depth > maxDepth) return;

    for (const entry of safeReadDir(currentDir)) {
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }

      if (["node_modules", ".git", ".pm2", "dist", "build", ".next"].includes(entry.name)) continue;

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        folders += 1;
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        if (includeRegex && !includeRegex.test(entry.name)) continue;

        const stat = safeStat(fullPath);
        const size = stat ? stat.size : 0;

        bytes += size;

        files.push({
          path: relativePath(fullPath),
          name: entry.name,
          extension: path.extname(entry.name).toLowerCase() || "none",
          size,
          sizeHuman: humanBytes(size),
          modifiedAt: stat ? stat.mtime.toISOString() : null
        });
      }
    }
  }

  walk(startDir, 0);

  files.sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")));

  return {
    exists: true,
    files,
    folders,
    bytes,
    truncated
  };
}

function getPackageInfo() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));

    return {
      name: pkg.name || "GoodAppBackEnd",
      version: pkg.version || "unknown",
      scripts: pkg.scripts || {},
      dependencies: pkg.dependencies || {},
      devDependencies: pkg.devDependencies || {}
    };
  } catch (_) {
    return {
      name: "GoodAppBackEnd",
      version: "unknown",
      scripts: {},
      dependencies: {},
      devDependencies: {}
    };
  }
}

function getGitInfo() {
  return {
    branch: run("git rev-parse --abbrev-ref HEAD") || "unknown",
    commit: run("git rev-parse --short HEAD") || "unknown",
    lastCommit: run("git log -1 --pretty=format:%s") || "unknown",
    modifiedFiles: run("git status --short").split("\n").filter(Boolean).length,
    recentCommits: run("git log -10 --pretty=format:%h%x09%ad%x09%s --date=short")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, date, ...message] = line.split("\t");
        return { hash, date, message: message.join(" ") };
      })
  };
}

function getPm2Rows() {
  const raw = run("pm2 jlist", { timeout: 8000 });

  if (!raw) return [];

  try {
    const list = JSON.parse(raw);

    return list.map((item) => ({
      name: item.name || "",
      status: item.pm2_env?.status || "",
      restarts: item.pm2_env?.restart_time || 0,
      cpu: item.monit?.cpu != null ? `${item.monit.cpu}%` : "",
      memory: item.monit?.memory != null ? humanBytes(item.monit.memory) : "",
      uptime: item.pm2_env?.pm_uptime ? new Date(item.pm2_env.pm_uptime).toISOString() : ""
    }));
  } catch (_) {
    return [];
  }
}

function parseLogs() {
  const candidates = [
    path.join(PROJECT_ROOT, "logs", "realtime.log"),
    path.join(PROJECT_ROOT, "logs", "events.log"),
    path.join(PROJECT_ROOT, "logs", "app.log"),
    path.join(PROJECT_ROOT, "logs", "error.log"),
    "/var/log/nginx/access.log",
    "/var/log/nginx/error.log"
  ];

  const found = candidates.find((file) => safeExists(file));

  const result = {
    source: found || "No realtime log found",
    linesChecked: 0,
    statusCounts: {},
    methodCounts: {},
    topPaths: [],
    realtimePaths: [],
    recentErrors: [],
    recentLines: []
  };

  if (!found) return result;

  try {
    const stat = fs.statSync(found);
    const maxBytes = Math.min(stat.size, 1024 * 1024 * 2);
    const fd = fs.openSync(found, "r");
    const buffer = Buffer.alloc(maxBytes);

    fs.readSync(fd, buffer, 0, maxBytes, Math.max(0, stat.size - maxBytes));
    fs.closeSync(fd);

    const lines = buffer.toString("utf8").split("\n").filter(Boolean).slice(-6000);
    const pathCounts = {};
    const realtimeCounts = {};

    result.linesChecked = lines.length;
    result.recentLines = lines.slice(-20).reverse().map((line) => ({ log: line.slice(0, 260) }));

    for (const line of lines) {
      const requestMatch = line.match(/"([A-Z]+)\s+([^"\s?]+)(?:\?[^"\s]*)?\s+HTTP\/[^"]+"/);
      const statusMatch = line.match(/"\s+(\d{3})\s+/);

      if (requestMatch) {
        const method = requestMatch[1];
        const requestPath = requestMatch[2];

        result.methodCounts[method] = (result.methodCounts[method] || 0) + 1;
        pathCounts[requestPath] = (pathCounts[requestPath] || 0) + 1;

        if (/realtime|socket|ws|event|message|presence|channel|stream/i.test(requestPath)) {
          realtimeCounts[requestPath] = (realtimeCounts[requestPath] || 0) + 1;
        }
      }

      if (statusMatch) {
        const status = statusMatch[1];
        result.statusCounts[status] = (result.statusCounts[status] || 0) + 1;

        if (/^[45]/.test(status) && result.recentErrors.length < 20) {
          result.recentErrors.unshift({ error: line.slice(0, 260) });
        }
      }
    }

    result.topPaths = Object.entries(pathCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([requestPath, count]) => ({ path: requestPath, requests: count }));

    result.realtimePaths = Object.entries(realtimeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([requestPath, count]) => ({ path: requestPath, requests: count }));
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

function getEnvRows(keys) {
  return keys.map((key) => {
    const value = process.env[key] || "";
    const sensitive = /SECRET|TOKEN|KEY|PASSWORD|PASS|PRIVATE|CREDENTIAL/i.test(key);

    return {
      setting: key,
      status: value ? "Configured" : "Missing",
      value: value ? (sensitive ? "Configured" : value.slice(0, 90)) : "Not configured"
    };
  });
}

function discoverRealtimeFiles() {
  const locations = [
    "src/realtime",
    "realtime",
    "src/socket",
    "socket",
    "src/sockets",
    "sockets",
    "src/events",
    "events",
    "src/channels",
    "channels",
    "src/routes",
    "src/services",
    "services"
  ];

  const rows = [];
  const seen = new Set();

  for (const location of locations) {
    const absolute = path.join(PROJECT_ROOT, location);
    const scan = walkFiles(absolute, {
      maxFiles: 2000,
      maxDepth: 5,
      includeRegex: /\.(js|mjs|cjs|ts|tsx)$/i
    });

    for (const file of scan.files) {
      if (seen.has(file.path)) continue;

      const fullPath = path.join(PROJECT_ROOT, file.path);
      const content = safeReadFile(fullPath, 90000);

      if (!/realtime|socket|websocket|ws|sse|eventsource|channel|presence|message|publish|subscribe|broadcast|emit|on\(/i.test(content + " " + file.path)) {
        continue;
      }

      seen.add(file.path);

      const routeMatches = [];
      const routeRegex = /\.(get|post|put|patch|delete|use)\s*\(\s*["'`]([^"'`]+)["'`]/g;
      let routeMatch;

      while ((routeMatch = routeRegex.exec(content)) !== null && routeMatches.length < 8) {
        routeMatches.push(`${routeMatch[1].toUpperCase()} ${routeMatch[2]}`);
      }

      const channelMatches = [];
      const channelRegex = /(?:channel|room|topic|event|namespace)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi;
      let channelMatch;

      while ((channelMatch = channelRegex.exec(content)) !== null && channelMatches.length < 8) {
        channelMatches.push(channelMatch[1]);
      }

      const signalCount = (content.match(/emit\(|broadcast|publish|subscribe|presence|channel|message|socket|websocket|sse|EventSource/gi) || []).length;

      rows.push({
        file: file.path,
        type: file.path.includes("routes") ? "Route-backed realtime" : "Realtime module",
        endpoints: routeMatches.join(", ") || "Not detected",
        detectedChannels: channelMatches.join(", ") || "Not detected",
        realtimeSignals: signalCount,
        size: file.sizeHuman,
        modifiedAt: file.modifiedAt
      });
    }
  }

  return rows.sort((a, b) => Number(b.realtimeSignals || 0) - Number(a.realtimeSignals || 0)).slice(0, 80);
}

function getRealtimeDependencies() {
  const pkg = getPackageInfo();
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  const wanted = [
    "ws",
    "socket.io",
    "socket.io-client",
    "uWebSockets.js",
    "eventsource",
    "sse",
    "express-sse",
    "redis",
    "ioredis",
    "bullmq",
    "bull",
    "pusher",
    "ably",
    "@supabase/realtime-js"
  ];

  return wanted.map((name) => ({
    package: name,
    status: deps[name] ? "Installed" : "Not installed",
    version: deps[name] || "Not installed"
  }));
}

function makeResponse(section, title, subtitle, metrics, tables, notes = [], extra = {}) {
  return {
    success: true,
    section,
    title,
    subtitle,
    generatedAt: nowIso(),
    metrics,
    tables,
    notes,
    ...extra
  };
}

function sectionInspector() {
  const memory = process.memoryUsage();
  const realtimeFiles = discoverRealtimeFiles();
  const deps = getRealtimeDependencies();
  const pm2Rows = getPm2Rows();
  const uptimeSeconds = Math.round(process.uptime());

  return makeResponse(
    "inspector",
    "Inspector",
    "Realtime channel inspector, runtime status, socket dependency checks, and server process health.",
    [
      { label: "Realtime Modules", value: realtimeFiles.length },
      { label: "Realtime Packages", value: deps.filter((row) => row.status === "Installed").length },
      { label: "Node Uptime", value: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m` },
      { label: "Heap Used", value: humanBytes(memory.heapUsed) }
    ],
    [
      {
        title: "Realtime Runtime",
        columns: ["name", "value"],
        rows: [
          { name: "Node Version", value: process.version },
          { name: "Platform", value: `${os.platform()} ${os.release()}` },
          { name: "Architecture", value: os.arch() },
          { name: "Project Root", value: PROJECT_ROOT },
          { name: "Process PID", value: process.pid },
          { name: "RSS Memory", value: humanBytes(memory.rss) },
          { name: "Heap Total", value: humanBytes(memory.heapTotal) },
          { name: "Heap Used", value: humanBytes(memory.heapUsed) }
        ]
      },
      {
        title: "Realtime Dependencies",
        columns: ["package", "status", "version"],
        rows: deps
      },
      {
        title: "PM2 Processes",
        columns: ["name", "status", "restarts", "cpu", "memory", "uptime"],
        rows: pm2Rows
      }
    ],
    [
      "Inspector is read-only and checks live runtime details without modifying services.",
      "Realtime package status is detected from package.json dependencies."
    ]
  );
}

function sectionChannels() {
  const realtimeFiles = discoverRealtimeFiles();
  const channelRows = realtimeFiles
    .filter((row) => row.detectedChannels !== "Not detected" || /channel|room|topic/i.test(row.file))
    .map((row) => ({
      channelSource: row.file,
      type: row.type,
      detectedChannels: row.detectedChannels,
      endpoints: row.endpoints,
      realtimeSignals: row.realtimeSignals,
      modifiedAt: row.modifiedAt
    }));

  return makeResponse(
    "channels",
    "Channels",
    "Realtime channel registry, route-backed realtime endpoints, and channel source inventory.",
    [
      { label: "Channel Sources", value: channelRows.length },
      { label: "Realtime Modules", value: realtimeFiles.length },
      { label: "Detected Signals", value: realtimeFiles.reduce((sum, row) => sum + Number(row.realtimeSignals || 0), 0) },
      { label: "Endpoint Sources", value: realtimeFiles.filter((row) => row.endpoints !== "Not detected").length }
    ],
    [
      {
        title: "Channel Registry",
        columns: ["channelSource", "type", "detectedChannels", "endpoints", "realtimeSignals", "modifiedAt"],
        rows: channelRows
      },
      {
        title: "All Realtime Modules",
        columns: ["file", "type", "endpoints", "detectedChannels", "realtimeSignals", "size", "modifiedAt"],
        rows: realtimeFiles
      }
    ],
    [
      "Channels are detected from route files, realtime folders, service files, and common channel/room/topic patterns.",
      "When a dedicated channel table is added later, this panel can be upgraded to read database-backed channels."
    ]
  );
}

function sectionMessages() {
  const logs = parseLogs();
  const statusRows = Object.entries(logs.statusCounts).map(([status, count]) => ({ status, count }));
  const methodRows = Object.entries(logs.methodCounts).map(([method, count]) => ({ method, count }));

  return makeResponse(
    "messages",
    "Messages",
    "Realtime message stream, API message activity, event paths, and recent log samples.",
    [
      { label: "Log Lines Checked", value: logs.linesChecked },
      { label: "Realtime Paths", value: logs.realtimePaths.length },
      { label: "HTTP Status Types", value: statusRows.length },
      { label: "Recent Errors", value: logs.recentErrors.length }
    ],
    [
      {
        title: "Realtime Message Paths",
        columns: ["path", "requests"],
        rows: logs.realtimePaths
      },
      {
        title: "Top Request Paths",
        columns: ["path", "requests"],
        rows: logs.topPaths
      },
      {
        title: "HTTP Status Counts",
        columns: ["status", "count"],
        rows: statusRows
      },
      {
        title: "HTTP Method Counts",
        columns: ["method", "count"],
        rows: methodRows
      },
      {
        title: "Recent Log Lines",
        columns: ["log"],
        rows: logs.recentLines
      }
    ],
    [
      `Message stream source: ${logs.source}`,
      "This panel samples recent log data and filters realtime/message/channel/presence paths."
    ],
    {
      logSource: logs.source
    }
  );
}

function sectionPresence() {
  const logs = parseLogs();
  const realtimeFiles = discoverRealtimeFiles();

  const presenceFiles = realtimeFiles
    .filter((row) => /presence|online|session|member|join|leave/i.test(row.file + " " + row.detectedChannels + " " + row.endpoints))
    .map((row) => ({
      file: row.file,
      type: row.type,
      detectedChannels: row.detectedChannels,
      endpoints: row.endpoints,
      realtimeSignals: row.realtimeSignals,
      modifiedAt: row.modifiedAt
    }));

  const presencePaths = logs.realtimePaths
    .filter((row) => /presence|online|session|member|join|leave/i.test(row.path));

  return makeResponse(
    "presence",
    "Presence",
    "Presence state, online session signals, member activity, and presence-ready source files.",
    [
      { label: "Presence Sources", value: presenceFiles.length },
      { label: "Presence Paths", value: presencePaths.length },
      { label: "Runtime Sessions", value: "Read-only" },
      { label: "Presence Status", value: presenceFiles.length || presencePaths.length ? "Detected" : "Pending" }
    ],
    [
      {
        title: "Presence Source Files",
        columns: ["file", "type", "detectedChannels", "endpoints", "realtimeSignals", "modifiedAt"],
        rows: presenceFiles
      },
      {
        title: "Presence Request Paths",
        columns: ["path", "requests"],
        rows: presencePaths
      }
    ],
    [
      "Presence is detected from source files and logs using presence/session/member/join/leave signals.",
      "A live in-memory presence registry can be connected later once socket rooms are centralized."
    ]
  );
}

function sectionPolicies() {
  const keys = [
    "REALTIME_ENABLED",
    "REALTIME_REQUIRE_AUTH",
    "REALTIME_MAX_CHANNELS",
    "REALTIME_MAX_MESSAGE_BYTES",
    "REALTIME_RATE_LIMIT_WINDOW_MS",
    "REALTIME_RATE_LIMIT_MAX",
    "REALTIME_ALLOW_PUBLIC_CHANNELS",
    "WEBSOCKET_ENABLED",
    "SSE_ENABLED",
    "CORS_ORIGIN",
    "JWT_SECRET",
    "SESSION_SECRET"
  ];

  const rows = getEnvRows(keys);
  const configured = rows.filter((row) => row.status === "Configured").length;

  const defaultPolicies = [
    { policy: "Authenticated realtime access", status: process.env.REALTIME_REQUIRE_AUTH === "false" ? "Disabled by env" : "Recommended / enforced by API auth", risk: "High if disabled" },
    { policy: "Message size limit", status: process.env.REALTIME_MAX_MESSAGE_BYTES || "Default pending", risk: "Medium" },
    { policy: "Rate limit", status: process.env.REALTIME_RATE_LIMIT_MAX || "Default pending", risk: "Medium" },
    { policy: "Public channels", status: process.env.REALTIME_ALLOW_PUBLIC_CHANNELS === "true" ? "Allowed by env" : "Restricted / pending", risk: "Medium" },
    { policy: "CORS origin", status: process.env.CORS_ORIGIN ? "Configured" : "Needs review", risk: "Medium" }
  ];

  return makeResponse(
    "policies",
    "Policies",
    "Realtime access policy, authorization rules, rate-limit readiness, and message control settings.",
    [
      { label: "Policy Keys Checked", value: rows.length },
      { label: "Configured Keys", value: configured },
      { label: "Missing Keys", value: rows.length - configured },
      { label: "Policy Status", value: configured >= 4 ? "Configured" : "Needs Review" }
    ],
    [
      {
        title: "Realtime Policy Environment",
        columns: ["setting", "status", "value"],
        rows
      },
      {
        title: "Default Policy Review",
        columns: ["policy", "status", "risk"],
        rows: defaultPolicies
      }
    ],
    [
      "Secret values are masked. This section only shows whether sensitive values are configured.",
      "Policy write actions are intentionally not enabled until admin permission checks are finalized."
    ]
  );
}

function sectionSettings() {
  const pkg = getPackageInfo();
  const git = getGitInfo();

  const settingsRows = [
    { setting: "Package", value: pkg.name },
    { setting: "Package Version", value: pkg.version },
    { setting: "Git Branch", value: git.branch },
    { setting: "Git Commit", value: git.commit },
    { setting: "Last Commit", value: git.lastCommit },
    { setting: "Modified Files", value: git.modifiedFiles },
    { setting: "Node Env", value: process.env.NODE_ENV || "unknown" },
    { setting: "Port", value: process.env.PORT || "not set" }
  ];

  const scriptRows = Object.entries(pkg.scripts || {}).map(([script, command]) => ({ script, command }));

  return makeResponse(
    "settings",
    "Settings",
    "Realtime console settings, project version, deployment scripts, and runtime configuration.",
    [
      { label: "Package Version", value: pkg.version },
      { label: "Git Branch", value: git.branch },
      { label: "Git Commit", value: git.commit },
      { label: "Modified Files", value: git.modifiedFiles }
    ],
    [
      {
        title: "Realtime Console Settings",
        columns: ["setting", "value"],
        rows: settingsRows
      },
      {
        title: "Package Scripts",
        columns: ["script", "command"],
        rows: scriptRows
      },
      {
        title: "Recent Commits",
        columns: ["hash", "date", "message"],
        rows: git.recentCommits
      }
    ],
    [
      "Settings are read-only in this console view.",
      "Use protected backend workflows before enabling write/edit actions for realtime configuration."
    ],
    {
      package: {
        name: pkg.name,
        version: pkg.version
      },
      git
    }
  );
}

function buildSection(section) {
  if (section === "inspector") return sectionInspector();
  if (section === "channels") return sectionChannels();
  if (section === "messages") return sectionMessages();
  if (section === "presence") return sectionPresence();
  if (section === "policies") return sectionPolicies();
  if (section === "settings") return sectionSettings();

  return null;
}

function buildSummary() {
  const realtimeFiles = discoverRealtimeFiles();
  const logs = parseLogs();
  const deps = getRealtimeDependencies();
  const git = getGitInfo();

  return {
    success: true,
    title: "Realtime Console",
    generatedAt: nowIso(),
    sections: KNOWN_SECTIONS.map((section) => ({
      key: section,
      label: section.charAt(0).toUpperCase() + section.slice(1),
      endpoint: `/api/admin/realtime-console/section/${section}`
    })),
    metrics: [
      { label: "Realtime Modules", value: realtimeFiles.length },
      { label: "Realtime Packages", value: deps.filter((row) => row.status === "Installed").length },
      { label: "Realtime Paths", value: logs.realtimePaths.length },
      { label: "Git Branch", value: git.branch },
      { label: "Git Commit", value: git.commit }
    ]
  };
}

router.get("/", (req, res) => {
  return res.json(buildSummary());
});

router.get("/summary", (req, res) => {
  return res.json(buildSummary());
});

router.get("/section/:sectionKey", (req, res) => {
  const section = cleanSectionKey(req.params.sectionKey);
  const data = buildSection(section);

  if (!data) {
    return sendError(res, 404, "Unknown realtime console section", {
      section,
      availableSections: KNOWN_SECTIONS
    });
  }

  return res.json(data);
});

router.get("/sections/:sectionKey", (req, res) => {
  const section = cleanSectionKey(req.params.sectionKey);
  const data = buildSection(section);

  if (!data) {
    return sendError(res, 404, "Unknown realtime console section", {
      section,
      availableSections: KNOWN_SECTIONS
    });
  }

  return res.json(data);
});

router.get("/export/:sectionKey", (req, res) => {
  const section = cleanSectionKey(req.params.sectionKey);
  const data = buildSection(section);

  if (!data) {
    return sendError(res, 404, "Unknown realtime console section", {
      section,
      availableSections: KNOWN_SECTIONS
    });
  }

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="goodos-realtime-console-${section}-${Date.now()}.json"`);
  return res.send(JSON.stringify(data, null, 2));
});

router.get("/:sectionKey", (req, res) => {
  const section = cleanSectionKey(req.params.sectionKey);
  const data = buildSection(section);

  if (!data) {
    return sendError(res, 404, "Unknown realtime console section", {
      section,
      availableSections: KNOWN_SECTIONS
    });
  }

  return res.json(data);
});

module.exports = router;
