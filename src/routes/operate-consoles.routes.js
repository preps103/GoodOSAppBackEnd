const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");

const router = express.Router();
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const CONSOLE_ALIASES = {
  advisor: "advisors",
  advisors: "advisors",
  observability: "observability",
  logs: "logs-center",
  "logs-center": "logs-center",
  logscenter: "logs-center",
  integrations: "integrations",
  integration: "integrations"
};

const SECTION_ALIASES = {
  advisors: {
    "security": "security-advisor",
    "security-advisor": "security-advisor",
    "performance": "performance-advisor",
    "performance-advisor": "performance-advisor",
    "query": "query-performance",
    "query-performance": "query-performance",
    "reset": "reset-suggestions",
    "reset-suggestions": "reset-suggestions",
    "suggestions": "reset-suggestions"
  },
  observability: {
    "overview": "overview",
    "query": "query-performance",
    "query-performance": "query-performance",
    "api": "api-gateway",
    "api-gateway": "api-gateway",
    "gateway": "api-gateway",
    "database": "database",
    "data-api": "data-api",
    "dataapi": "data-api",
    "auth": "auth",
    "functions": "functions"
  },
  "logs-center": {
    "unified": "unified-logs",
    "unified-logs": "unified-logs",
    "live": "live-tail",
    "live-tail": "live-tail",
    "database": "database-logs",
    "database-logs": "database-logs",
    "postgrest": "postgrest-logs",
    "postgrest-logs": "postgrest-logs",
    "auth": "auth-logs",
    "auth-logs": "auth-logs",
    "storage": "storage-logs",
    "storage-logs": "storage-logs",
    "edge": "edge-function-logs",
    "edge-function-logs": "edge-function-logs",
    "realtime": "realtime-logs",
    "realtime-logs": "realtime-logs",
    "drains": "log-drains",
    "log-drains": "log-drains"
  },
  integrations: {
    "all": "all",
    "wrappers": "wrappers",
    "postgres": "postgres-modules",
    "postgres-modules": "postgres-modules",
    "modules": "postgres-modules",
    "data-api": "data-api",
    "dataapi": "data-api",
    "vault": "vault",
    "cron": "cron",
    "queues": "queues",
    "queue": "queues",
    "stripe": "stripe-sync-engine",
    "stripe-sync-engine": "stripe-sync-engine"
  }
};

const SECTIONS = {
  advisors: ["security-advisor", "performance-advisor", "query-performance", "reset-suggestions"],
  observability: ["overview", "query-performance", "api-gateway", "database", "data-api", "auth", "functions"],
  "logs-center": ["unified-logs", "live-tail", "database-logs", "postgrest-logs", "auth-logs", "storage-logs", "edge-function-logs", "realtime-logs", "log-drains"],
  integrations: ["all", "wrappers", "postgres-modules", "data-api", "vault", "cron", "queues", "stripe-sync-engine"]
};

function cleanKey(value) {
  return String(value || "")
    .trim()
    .replace(/<[^>]*>/g, "")
    .replace(/[+"'`]/g, "")
    .replace(/[.)\];,]+$/g, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

function normalizeConsole(value) {
  const key = cleanKey(value);
  return CONSOLE_ALIASES[key] || key;
}

function normalizeSection(consoleKey, value) {
  const key = cleanKey(value);
  return SECTION_ALIASES[consoleKey]?.[key] || key;
}

function sendError(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
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

function requireOperateAuth(req, res, next) {
  if (existingAuthMiddleware) return existingAuthMiddleware(req, res, next);

  const authHeader = String(req.headers.authorization || "");
  const cookie = String(req.headers.cookie || "");
  const hasBearer = /^Bearer\s+.+/i.test(authHeader);
  const hasSessionCookie = cookie.includes("token") || cookie.includes("session");

  if (!hasBearer && !hasSessionCookie) {
    return sendError(res, 401, "Authorization token required");
  }

  return next();
}

router.use(requireOperateAuth);

function nowIso() {
  return new Date().toISOString();
}

function safeExists(filePath) {
  try { return fs.existsSync(filePath); } catch (_) { return false; }
}

function safeStat(filePath) {
  try { return fs.statSync(filePath); } catch (_) { return null; }
}

function safeReadDir(dirPath) {
  try { return fs.readdirSync(dirPath, { withFileTypes: true }); } catch (_) { return []; }
}

function safeReadFile(filePath, maxBytes = 140000) {
  try {
    const stat = fs.statSync(filePath);
    const bytes = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, 0);
    fs.closeSync(fd);
    return buffer.toString("utf8");
  } catch (_) {
    return "";
  }
}

function tailFile(filePath, maxBytes = 1024 * 1024 * 2) {
  try {
    const stat = fs.statSync(filePath);
    const bytes = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(bytes);
    fs.readSync(fd, buffer, 0, bytes, Math.max(0, stat.size - bytes));
    fs.closeSync(fd);
    return buffer.toString("utf8");
  } catch (_) {
    return "";
  }
}

function run(command, timeout = 5000) {
  try {
    return childProcess.execSync(command, {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout
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

function rel(filePath) {
  return path.relative(PROJECT_ROOT, filePath).replace(/\\/g, "/") || ".";
}

function walkFiles(startDir, options = {}) {
  const maxFiles = options.maxFiles || 2500;
  const maxDepth = options.maxDepth || 6;
  const includeRegex = options.includeRegex || null;
  const contentRegex = options.contentRegex || null;

  const files = [];
  let folders = 0;
  let bytes = 0;
  let truncated = false;

  if (!safeExists(startDir)) return { exists: false, files, folders, bytes, truncated };

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

      if (["node_modules", ".git", ".pm2", "dist", "build", ".next", "coverage"].includes(entry.name)) continue;

      const full = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        folders += 1;
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (includeRegex && !includeRegex.test(entry.name)) continue;

        const content = contentRegex ? safeReadFile(full, 90000) : "";
        if (contentRegex && !contentRegex.test(content + " " + full)) continue;

        const stat = safeStat(full);
        const size = stat ? stat.size : 0;

        bytes += size;

        files.push({
          file: rel(full),
          name: entry.name,
          extension: path.extname(entry.name).toLowerCase() || "none",
          size: humanBytes(size),
          bytes: size,
          modifiedAt: stat ? stat.mtime.toISOString() : null
        });
      }
    }
  }

  walk(startDir, 0);
  files.sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")));

  return { exists: true, files, folders, bytes, truncated };
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
    return { name: "GoodAppBackEnd", version: "unknown", scripts: {}, dependencies: {}, devDependencies: {} };
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
  const raw = run("pm2 jlist", 8000);
  if (!raw) return [];

  try {
    return JSON.parse(raw).map((item) => ({
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

function getDiskInfo() {
  const df = run("df -Pk . | tail -1", 3000);
  if (!df) return { filesystem: "Unavailable", size: "Unavailable", used: "Unavailable", available: "Unavailable", usedPercent: "Unavailable" };

  const parts = df.split(/\s+/);

  return {
    filesystem: parts[0] || "unknown",
    size: humanBytes(Number(parts[1] || 0) * 1024),
    used: humanBytes(Number(parts[2] || 0) * 1024),
    available: humanBytes(Number(parts[3] || 0) * 1024),
    usedPercent: parts[4] || "unknown"
  };
}

function getEnvRows(keys) {
  return keys.map((key) => {
    const value = process.env[key] || "";
    const sensitive = /SECRET|TOKEN|KEY|PASSWORD|PASS|PRIVATE|CREDENTIAL|DATABASE_URL/i.test(key);

    return {
      setting: key,
      status: value ? "Configured" : "Missing",
      value: value ? (sensitive ? "Configured" : value.slice(0, 90)) : "Not configured"
    };
  });
}

function discoverFilesFromLocations(locations, regex, contentRegex) {
  const rows = [];
  const seen = new Set();

  for (const location of locations) {
    const scan = walkFiles(path.join(PROJECT_ROOT, location), {
      maxFiles: 2000,
      maxDepth: 6,
      includeRegex: regex,
      contentRegex
    });

    for (const file of scan.files) {
      if (seen.has(file.file)) continue;
      seen.add(file.file);
      rows.push(file);
    }
  }

  return rows;
}

function parseLogs(filterRegex = null) {
  const candidates = [
    path.join(PROJECT_ROOT, "logs", "app.log"),
    path.join(PROJECT_ROOT, "logs", "error.log"),
    path.join(PROJECT_ROOT, "logs", "access.log"),
    path.join(PROJECT_ROOT, "logs", "realtime.log"),
    path.join(PROJECT_ROOT, "logs", "execution.log"),
    "/var/log/nginx/access.log",
    "/var/log/nginx/error.log",
    "/var/log/postgresql/postgresql-16-main.log",
    "/var/log/postgresql/postgresql-15-main.log",
    "/var/log/postgresql/postgresql-14-main.log"
  ];

  const existing = candidates.filter(safeExists);
  const primary = existing[0] || "";

  const result = {
    source: primary || "No log source found",
    sources: existing.map((file) => ({ file, size: humanBytes(safeStat(file)?.size || 0), modifiedAt: safeStat(file)?.mtime?.toISOString?.() || null })),
    linesChecked: 0,
    statusCounts: {},
    methodCounts: {},
    topPaths: [],
    recentErrors: [],
    recentLines: []
  };

  const pathCounts = {};

  for (const file of existing.slice(0, 5)) {
    const lines = tailFile(file)
      .split("\n")
      .filter(Boolean)
      .slice(-5000);

    for (const line of lines) {
      if (filterRegex && !filterRegex.test(line)) continue;

      result.linesChecked += 1;

      if (result.recentLines.length < 40) {
        result.recentLines.unshift({ source: file, log: line.slice(0, 320) });
      }

      const requestMatch = line.match(/"([A-Z]+)\s+([^"\s?]+)(?:\?[^"\s]*)?\s+HTTP\/[^"]+"/);
      const statusMatch = line.match(/"\s+(\d{3})\s+/);

      if (requestMatch) {
        const method = requestMatch[1];
        const requestPath = requestMatch[2];

        result.methodCounts[method] = (result.methodCounts[method] || 0) + 1;
        pathCounts[requestPath] = (pathCounts[requestPath] || 0) + 1;
      }

      if (statusMatch) {
        const status = statusMatch[1];
        result.statusCounts[status] = (result.statusCounts[status] || 0) + 1;

        if (/^[45]/.test(status) && result.recentErrors.length < 30) {
          result.recentErrors.unshift({ source: file, error: line.slice(0, 320) });
        }
      } else if (/error|failed|exception|warn/i.test(line) && result.recentErrors.length < 30) {
        result.recentErrors.unshift({ source: file, error: line.slice(0, 320) });
      }
    }
  }

  result.topPaths = Object.entries(pathCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([requestPath, requests]) => ({ path: requestPath, requests }));

  return result;
}

function routeInventory(contentRegex = /\.(get|post|put|patch|delete|use)\s*\(/i) {
  const files = discoverFilesFromLocations(
    ["src/routes", "routes", "api", "src/api", "src/controllers", "controllers"],
    /\.(js|mjs|cjs|ts|tsx)$/i,
    contentRegex
  );

  return files.map((file) => {
    const content = safeReadFile(path.join(PROJECT_ROOT, file.file), 100000);
    const endpoints = [];
    const routeRegex = /\.(get|post|put|patch|delete|use)\s*\(\s*["'`]([^"'`]+)["'`]/g;
    let match;

    while ((match = routeRegex.exec(content)) !== null && endpoints.length < 10) {
      endpoints.push(`${match[1].toUpperCase()} ${match[2]}`);
    }

    return {
      file: file.file,
      endpoints: endpoints.join(", ") || "Not detected",
      size: file.size,
      modifiedAt: file.modifiedAt
    };
  });
}

function makeResponse(consoleKey, section, title, subtitle, metrics, tables, notes = [], extra = {}) {
  return {
    success: true,
    console: consoleKey,
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

function advisorsSection(section) {
  const logs = parseLogs();
  const pkg = getPackageInfo();
  const git = getGitInfo();
  const pm2 = getPm2Rows();
  const disk = getDiskInfo();
  const envSecurity = getEnvRows(["NODE_ENV", "JWT_SECRET", "SESSION_SECRET", "DATABASE_URL", "CORS_ORIGIN", "SMTP_PASS", "STRIPE_SECRET_KEY", "OPENAI_API_KEY"]);
  const configuredSecurity = envSecurity.filter((row) => row.status === "Configured").length;

  if (section === "security-advisor") {
    const checks = [
      { check: "JWT secret", status: process.env.JWT_SECRET ? "Configured" : "Missing", recommendation: "Keep JWT_SECRET configured and rotated." },
      { check: "Session secret", status: process.env.SESSION_SECRET ? "Configured" : "Missing", recommendation: "Configure SESSION_SECRET if cookie sessions are enabled." },
      { check: "Production mode", status: process.env.NODE_ENV === "production" ? "Passed" : "Needs review", recommendation: "Run NODE_ENV=production on the VPS." },
      { check: "CORS origin", status: process.env.CORS_ORIGIN ? "Configured" : "Needs review", recommendation: "Restrict CORS to trusted GoodOS domains." },
      { check: "Git changes", status: git.modifiedFiles === 0 ? "Clean" : "Uncommitted changes", recommendation: "Commit or back up active changes before major patches." },
      { check: "Recent 4xx/5xx logs", status: logs.recentErrors.length ? "Needs review" : "Clean", recommendation: "Review recent error logs and route failures." }
    ];

    return makeResponse("advisors", section, "Security Advisor", "Security issue and suggestion workflow based on live environment, git state, and log signals.",
      [
        { label: "Security Keys", value: envSecurity.length },
        { label: "Configured", value: configuredSecurity },
        { label: "Checks", value: checks.length },
        { label: "Recent Errors", value: logs.recentErrors.length }
      ],
      [
        { title: "Security Checks", columns: ["check", "status", "recommendation"], rows: checks },
        { title: "Sensitive Environment Status", columns: ["setting", "status", "value"], rows: envSecurity },
        { title: "Recent Errors", columns: ["source", "error"], rows: logs.recentErrors }
      ],
      ["Secret values are masked. This advisor is read-only and does not modify configuration."]
    );
  }

  if (section === "performance-advisor") {
    const mem = process.memoryUsage();

    return makeResponse("advisors", section, "Performance Advisor", "Performance issue and suggestion workflow from live runtime, PM2, disk, and request logs.",
      [
        { label: "PM2 Apps", value: pm2.length },
        { label: "Disk Used", value: disk.usedPercent },
        { label: "RSS Memory", value: humanBytes(mem.rss) },
        { label: "Log Lines", value: logs.linesChecked }
      ],
      [
        { title: "PM2 Runtime", columns: ["name", "status", "restarts", "cpu", "memory", "uptime"], rows: pm2 },
        { title: "Disk", columns: ["name", "value"], rows: Object.entries(disk).map(([name, value]) => ({ name, value })) },
        { title: "Top Request Paths", columns: ["path", "requests"], rows: logs.topPaths }
      ],
      ["Use repeated PM2 restarts, high memory, and 5xx logs as signals for optimization."]
    );
  }

  if (section === "query-performance") {
    const queryFiles = discoverFilesFromLocations(
      ["src", "routes", "api", "migrations", "prisma", "sql"],
      /\.(js|mjs|cjs|ts|tsx|sql|prisma)$/i,
      /select\s+|insert\s+|update\s+|delete\s+|from\s+|join\s+|query\(/i
    ).slice(0, 80);

    return makeResponse("advisors", section, "Query Performance", "Query performance advisor using database environment, SQL-bearing files, and request logs.",
      [
        { label: "Query Files", value: queryFiles.length },
        { label: "DB Config", value: process.env.DATABASE_URL ? "Configured" : "Missing" },
        { label: "Top Paths", value: logs.topPaths.length },
        { label: "Errors", value: logs.recentErrors.length }
      ],
      [
        { title: "Query Bearing Files", columns: ["file", "extension", "size", "modifiedAt"], rows: queryFiles },
        { title: "Top Request Paths", columns: ["path", "requests"], rows: logs.topPaths },
        { title: "Database Environment", columns: ["setting", "status", "value"], rows: getEnvRows(["DATABASE_URL", "PGHOST", "PGPORT", "PGDATABASE", "PGUSER"]) }
      ],
      ["This section does not expose query contents. It inventories query-bearing files and traffic signals."]
    );
  }

  return makeResponse("advisors", "reset-suggestions", "Reset Suggestions", "Rerun advisor/linter workflow and safe reset suggestions.",
    [
      { label: "Git Branch", value: git.branch },
      { label: "Git Commit", value: git.commit },
      { label: "Modified Files", value: git.modifiedFiles },
      { label: "Package Version", value: pkg.version }
    ],
    [
      { title: "Safe Reset Checklist", columns: ["step", "action", "reason"], rows: [
        { step: 1, action: "Create backup", reason: "Protect console.html, app.js, routes, and current work." },
        { step: 2, action: "Run syntax checks", reason: "Catch broken JavaScript before PM2 restart." },
        { step: 3, action: "Restart backend", reason: "Reload mounted routes and frontend shell." },
        { step: 4, action: "Verify 401 not 404", reason: "401 means protected route exists; 404 means route is not mounted." },
        { step: 5, action: "Open force URL", reason: "Cache bust the browser shell after patching." }
      ]},
      { title: "Recent Commits", columns: ["hash", "date", "message"], rows: git.recentCommits },
      { title: "PM2 Runtime", columns: ["name", "status", "restarts", "cpu", "memory", "uptime"], rows: pm2 }
    ],
    ["Reset suggestions are read-only. They do not run destructive commands."]
  );
}

function observabilitySection(section) {
  const logs = parseLogs();
  const pm2 = getPm2Rows();
  const git = getGitInfo();
  const disk = getDiskInfo();

  if (section === "overview") {
    return makeResponse("observability", section, "Overview", "Service health, runtime, disk, git, and request overview.",
      [
        { label: "PM2 Apps", value: pm2.length },
        { label: "Disk Used", value: disk.usedPercent },
        { label: "Git Branch", value: git.branch },
        { label: "Recent Errors", value: logs.recentErrors.length }
      ],
      [
        { title: "PM2 Runtime", columns: ["name", "status", "restarts", "cpu", "memory", "uptime"], rows: pm2 },
        { title: "Disk", columns: ["name", "value"], rows: Object.entries(disk).map(([name, value]) => ({ name, value })) },
        { title: "Top Paths", columns: ["path", "requests"], rows: logs.topPaths }
      ]
    );
  }

  if (section === "query-performance") return advisorsSection("query-performance");

  if (section === "api-gateway") {
    return makeResponse("observability", section, "API Gateway", "Gateway latency, request distribution, statuses, and recent gateway errors.",
      [
        { label: "Log Lines", value: logs.linesChecked },
        { label: "Top Paths", value: logs.topPaths.length },
        { label: "Status Types", value: Object.keys(logs.statusCounts).length },
        { label: "Errors", value: logs.recentErrors.length }
      ],
      [
        { title: "Top Gateway Paths", columns: ["path", "requests"], rows: logs.topPaths },
        { title: "Status Counts", columns: ["status", "count"], rows: Object.entries(logs.statusCounts).map(([status, count]) => ({ status, count })) },
        { title: "Method Counts", columns: ["method", "count"], rows: Object.entries(logs.methodCounts).map(([method, count]) => ({ method, count })) },
        { title: "Recent Errors", columns: ["source", "error"], rows: logs.recentErrors }
      ],
      [`Gateway source: ${logs.source}`]
    );
  }

  if (section === "database") {
    const dbFiles = discoverFilesFromLocations(["migrations", "prisma", "sql", "src"], /\.(sql|prisma|js|ts|cjs|mjs)$/i, /database|postgres|sequelize|knex|prisma|pg\.|query\(|select\s+/i).slice(0, 80);
    return makeResponse("observability", section, "Database", "Database observability, configuration status, migrations, and database-related source inventory.",
      [
        { label: "Database URL", value: process.env.DATABASE_URL ? "Configured" : "Missing" },
        { label: "DB Files", value: dbFiles.length },
        { label: "Git Commit", value: git.commit },
        { label: "Modified Files", value: git.modifiedFiles }
      ],
      [
        { title: "Database Environment", columns: ["setting", "status", "value"], rows: getEnvRows(["DATABASE_URL", "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGSSLMODE"]) },
        { title: "Database Files", columns: ["file", "extension", "size", "modifiedAt"], rows: dbFiles }
      ]
    );
  }

  if (section === "data-api") {
    const routes = routeInventory(/data|api|postgrest|rest|table|database/i);
    return makeResponse("observability", section, "Data API", "Data API route observability and endpoint inventory.",
      [
        { label: "Route Files", value: routes.length },
        { label: "Top Paths", value: logs.topPaths.length },
        { label: "Errors", value: logs.recentErrors.length },
        { label: "Log Lines", value: logs.linesChecked }
      ],
      [
        { title: "Data API Routes", columns: ["file", "endpoints", "size", "modifiedAt"], rows: routes },
        { title: "Top Request Paths", columns: ["path", "requests"], rows: logs.topPaths }
      ]
    );
  }

  if (section === "auth") {
    const authRoutes = routeInventory(/auth|login|logout|jwt|session|oauth|mfa|passkey/i);
    return makeResponse("observability", section, "Auth", "Auth observability, route inventory, auth environment, and recent auth-related logs.",
      [
        { label: "Auth Route Files", value: authRoutes.length },
        { label: "JWT Secret", value: process.env.JWT_SECRET ? "Configured" : "Missing" },
        { label: "Session Secret", value: process.env.SESSION_SECRET ? "Configured" : "Missing" },
        { label: "Errors", value: logs.recentErrors.length }
      ],
      [
        { title: "Auth Routes", columns: ["file", "endpoints", "size", "modifiedAt"], rows: authRoutes },
        { title: "Auth Environment", columns: ["setting", "status", "value"], rows: getEnvRows(["JWT_SECRET", "SESSION_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) },
        { title: "Recent Errors", columns: ["source", "error"], rows: logs.recentErrors }
      ]
    );
  }

  const fnRoutes = routeInventory(/function|edge|execution|worker|job|cron/i);
  return makeResponse("observability", "functions", "Functions", "Function observability, active function routes, and PM2 runtime.",
    [
      { label: "Function Files", value: fnRoutes.length },
      { label: "PM2 Apps", value: pm2.length },
      { label: "Git Commit", value: git.commit },
      { label: "Errors", value: logs.recentErrors.length }
    ],
    [
      { title: "Function Routes", columns: ["file", "endpoints", "size", "modifiedAt"], rows: fnRoutes },
      { title: "PM2 Runtime", columns: ["name", "status", "restarts", "cpu", "memory", "uptime"], rows: pm2 }
    ]
  );
}

function logsCenterSection(section) {
  const filterMap = {
    "database-logs": /database|postgres|query|sql|prisma|pg/i,
    "postgrest-logs": /postgrest|rest|data api|data-api|\/api\/data|table/i,
    "auth-logs": /auth|login|logout|jwt|session|oauth|mfa|passkey/i,
    "storage-logs": /storage|bucket|s3|object|upload|download|file/i,
    "edge-function-logs": /edge|function|worker|execution|deploy/i,
    "realtime-logs": /realtime|socket|websocket|channel|presence|message|sse/i
  };

  const logs = parseLogs(filterMap[section] || null);
  const titleMap = {
    "unified-logs": "Unified Logs",
    "live-tail": "Live Tail",
    "database-logs": "Database Logs",
    "postgrest-logs": "PostgREST Logs",
    "auth-logs": "Auth Logs",
    "storage-logs": "Storage Logs",
    "edge-function-logs": "Edge Function Logs",
    "realtime-logs": "Realtime Logs",
    "log-drains": "Log Drains"
  };

  if (section === "log-drains") {
    const drainEnv = getEnvRows(["LOG_DRAIN_URL", "LOGTAIL_TOKEN", "DATADOG_API_KEY", "SENTRY_DSN", "AXIOM_TOKEN", "BETTERSTACK_TOKEN", "CLOUDFLARE_LOGPUSH"]);
    return makeResponse("logs-center", section, "Log Drains", "External log drain configuration and export readiness.",
      [
        { label: "Drain Keys", value: drainEnv.length },
        { label: "Configured", value: drainEnv.filter((row) => row.status === "Configured").length },
        { label: "Sources Found", value: logs.sources.length },
        { label: "Log Lines", value: logs.linesChecked }
      ],
      [
        { title: "Drain Environment", columns: ["setting", "status", "value"], rows: drainEnv },
        { title: "Log Sources", columns: ["file", "size", "modifiedAt"], rows: logs.sources }
      ],
      ["Secret values are masked. Drain setup is read-only in this view."]
    );
  }

  return makeResponse("logs-center", section, titleMap[section] || "Logs", `${titleMap[section] || "Log"} viewer with live source sampling, filters, statuses, and recent lines.`,
    [
      { label: "Log Lines", value: logs.linesChecked },
      { label: "Sources", value: logs.sources.length },
      { label: "Top Paths", value: logs.topPaths.length },
      { label: "Errors", value: logs.recentErrors.length }
    ],
    [
      { title: "Log Sources", columns: ["file", "size", "modifiedAt"], rows: logs.sources },
      { title: "Top Paths", columns: ["path", "requests"], rows: logs.topPaths },
      { title: "Status Counts", columns: ["status", "count"], rows: Object.entries(logs.statusCounts).map(([status, count]) => ({ status, count })) },
      { title: "Recent Errors", columns: ["source", "error"], rows: logs.recentErrors },
      { title: section === "live-tail" ? "Live Tail Sample" : "Recent Lines", columns: ["source", "log"], rows: logs.recentLines }
    ],
    [`Log source: ${logs.source}`]
  );
}

function integrationsSection(section) {
  const pkg = getPackageInfo();
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const depRows = Object.entries(deps).map(([name, version]) => ({ package: name, version })).sort((a, b) => a.package.localeCompare(b.package));
  const git = getGitInfo();

  const integrationEnv = getEnvRows([
    "DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
    "REDIS_URL", "BULL_REDIS_URL", "CRON_SECRET", "VAULT_KEY", "DATA_API_URL", "POSTGREST_URL",
    "AWS_ACCESS_KEY_ID", "S3_BUCKET", "SENDGRID_API_KEY", "OPENAI_API_KEY"
  ]);

  if (section === "all") {
    return makeResponse("integrations", section, "All", "All integrations catalog from installed packages, environment, and route/module discovery.",
      [
        { label: "Packages", value: depRows.length },
        { label: "Env Keys", value: integrationEnv.length },
        { label: "Configured", value: integrationEnv.filter((row) => row.status === "Configured").length },
        { label: "Git Commit", value: git.commit }
      ],
      [
        { title: "Integration Environment", columns: ["setting", "status", "value"], rows: integrationEnv },
        { title: "Installed Packages", columns: ["package", "version"], rows: depRows.slice(0, 120) }
      ],
      ["Sensitive values are masked. This catalog is read-only."]
    );
  }

  if (section === "wrappers") {
    const wrapperFiles = discoverFilesFromLocations(["src", "wrappers", "integrations", "migrations", "sql"], /\.(js|ts|sql|json|md|prisma)$/i, /wrapper|foreign data wrapper|fdw|postgres_fdw|file_fdw|http/i).slice(0, 80);
    return makeResponse("integrations", section, "Wrappers", "Foreign data wrapper catalog and wrapper-ready source files.",
      [
        { label: "Wrapper Files", value: wrapperFiles.length },
        { label: "DB Config", value: process.env.DATABASE_URL ? "Configured" : "Missing" },
        { label: "Packages", value: depRows.length },
        { label: "Git Branch", value: git.branch }
      ],
      [
        { title: "Wrapper Files", columns: ["file", "extension", "size", "modifiedAt"], rows: wrapperFiles },
        { title: "Database Environment", columns: ["setting", "status", "value"], rows: getEnvRows(["DATABASE_URL", "PGHOST", "PGDATABASE", "PGUSER"]) }
      ]
    );
  }

  if (section === "postgres-modules") {
    const pgFiles = discoverFilesFromLocations(["migrations", "sql", "prisma", "src"], /\.(sql|prisma|js|ts|json)$/i, /postgres|extension|create extension|uuid-ossp|pgcrypto|postgis|pg_/i).slice(0, 80);
    return makeResponse("integrations", section, "Postgres Modules", "Postgres module catalog, extension-related files, and database package readiness.",
      [
        { label: "PG Files", value: pgFiles.length },
        { label: "pg Package", value: deps.pg ? "Installed" : "Missing" },
        { label: "Prisma", value: deps.prisma || deps["@prisma/client"] ? "Installed" : "Missing" },
        { label: "DB Config", value: process.env.DATABASE_URL ? "Configured" : "Missing" }
      ],
      [
        { title: "Postgres Module Files", columns: ["file", "extension", "size", "modifiedAt"], rows: pgFiles },
        { title: "Relevant Packages", columns: ["package", "version"], rows: depRows.filter((row) => /pg|prisma|sequelize|knex|postgres/i.test(row.package)) }
      ]
    );
  }

  if (section === "data-api") return observabilitySection("data-api");

  if (section === "vault") {
    const vaultEnv = getEnvRows(["VAULT_KEY", "VAULT_SECRET", "JWT_SECRET", "SESSION_SECRET", "DATABASE_URL", "STRIPE_SECRET_KEY", "OPENAI_API_KEY", "SMTP_PASS"]);
    return makeResponse("integrations", section, "Vault", "Vault encryption shell, secret readiness, and sensitive environment inventory.",
      [
        { label: "Vault Keys", value: vaultEnv.length },
        { label: "Configured", value: vaultEnv.filter((row) => row.status === "Configured").length },
        { label: "JWT Secret", value: process.env.JWT_SECRET ? "Configured" : "Missing" },
        { label: "Session Secret", value: process.env.SESSION_SECRET ? "Configured" : "Missing" }
      ],
      [
        { title: "Vault / Secret Status", columns: ["setting", "status", "value"], rows: vaultEnv }
      ],
      ["Secret values are masked. Vault write actions are not enabled from this panel."]
    );
  }

  if (section === "cron") {
    const cronFiles = discoverFilesFromLocations(["src", "jobs", "cron", "workers", "scripts"], /\.(js|ts|cjs|mjs|json|md)$/i, /cron|schedule|node-cron|setInterval|worker|job/i).slice(0, 80);
    const scriptRows = Object.entries(pkg.scripts || {}).map(([script, command]) => ({ script, command }));
    return makeResponse("integrations", section, "Cron", "Cron job integration, scheduled job source files, and package scripts.",
      [
        { label: "Cron Files", value: cronFiles.length },
        { label: "Scripts", value: scriptRows.length },
        { label: "node-cron", value: deps["node-cron"] ? "Installed" : "Missing" },
        { label: "Git Commit", value: git.commit }
      ],
      [
        { title: "Cron / Job Files", columns: ["file", "extension", "size", "modifiedAt"], rows: cronFiles },
        { title: "Package Scripts", columns: ["script", "command"], rows: scriptRows }
      ]
    );
  }

  if (section === "queues") {
    const queueFiles = discoverFilesFromLocations(["src", "queues", "workers", "jobs", "services"], /\.(js|ts|cjs|mjs|json)$/i, /queue|bull|bullmq|redis|worker|job|enqueue|dequeue/i).slice(0, 80);
    return makeResponse("integrations", section, "Queues", "Queue integration, worker readiness, Redis/Bull configuration, and queue source files.",
      [
        { label: "Queue Files", value: queueFiles.length },
        { label: "Redis URL", value: process.env.REDIS_URL ? "Configured" : "Missing" },
        { label: "BullMQ", value: deps.bullmq ? "Installed" : "Missing" },
        { label: "Bull", value: deps.bull ? "Installed" : "Missing" }
      ],
      [
        { title: "Queue Files", columns: ["file", "extension", "size", "modifiedAt"], rows: queueFiles },
        { title: "Queue Environment", columns: ["setting", "status", "value"], rows: getEnvRows(["REDIS_URL", "BULL_REDIS_URL", "QUEUE_PREFIX", "WORKER_CONCURRENCY"]) },
        { title: "Queue Packages", columns: ["package", "version"], rows: depRows.filter((row) => /bull|redis|queue|worker/i.test(row.package)) }
      ]
    );
  }

  const stripeFiles = discoverFilesFromLocations(["src", "routes", "services", "workers", "jobs"], /\.(js|ts|cjs|mjs|json)$/i, /stripe|checkout|payment|invoice|webhook|subscription|sync/i).slice(0, 80);
  return makeResponse("integrations", "stripe-sync-engine", "Stripe Sync Engine", "Payment sync shell, Stripe environment, webhook readiness, and sync source files.",
    [
      { label: "Stripe Files", value: stripeFiles.length },
      { label: "Stripe Key", value: process.env.STRIPE_SECRET_KEY ? "Configured" : "Missing" },
      { label: "Webhook Secret", value: process.env.STRIPE_WEBHOOK_SECRET ? "Configured" : "Missing" },
      { label: "Stripe Package", value: deps.stripe ? "Installed" : "Missing" }
    ],
    [
      { title: "Stripe Environment", columns: ["setting", "status", "value"], rows: getEnvRows(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_ID", "STRIPE_PRODUCT_ID"]) },
      { title: "Stripe Sync Files", columns: ["file", "extension", "size", "modifiedAt"], rows: stripeFiles },
      { title: "Stripe Packages", columns: ["package", "version"], rows: depRows.filter((row) => /stripe/i.test(row.package)) }
    ],
    ["Secret values are masked. Stripe sync actions are not executed from this panel."]
  );
}

function buildSection(consoleKey, section) {
  if (consoleKey === "advisors") return advisorsSection(section);
  if (consoleKey === "observability") return observabilitySection(section);
  if (consoleKey === "logs-center") return logsCenterSection(section);
  if (consoleKey === "integrations") return integrationsSection(section);
  return null;
}

function buildSummary(consoleKey) {
  const sections = SECTIONS[consoleKey] || [];
  const git = getGitInfo();
  const logs = parseLogs();
  const pm2 = getPm2Rows();

  return {
    success: true,
    console: consoleKey,
    title: consoleKey.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" "),
    generatedAt: nowIso(),
    sections: sections.map((section) => ({
      key: section,
      label: section.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" "),
      endpoint: `/api/admin/operate-console/${consoleKey}/section/${section}`
    })),
    metrics: [
      { label: "Sections", value: sections.length },
      { label: "PM2 Apps", value: pm2.length },
      { label: "Log Lines", value: logs.linesChecked },
      { label: "Git Branch", value: git.branch },
      { label: "Git Commit", value: git.commit }
    ]
  };
}

router.get("/:consoleKey", (req, res) => {
  const consoleKey = normalizeConsole(req.params.consoleKey);
  if (!SECTIONS[consoleKey]) return sendError(res, 404, "Unknown operate console", { console: consoleKey, availableConsoles: Object.keys(SECTIONS) });
  return res.json(buildSummary(consoleKey));
});

router.get("/:consoleKey/summary", (req, res) => {
  const consoleKey = normalizeConsole(req.params.consoleKey);
  if (!SECTIONS[consoleKey]) return sendError(res, 404, "Unknown operate console", { console: consoleKey, availableConsoles: Object.keys(SECTIONS) });
  return res.json(buildSummary(consoleKey));
});

router.get("/:consoleKey/section/:sectionKey", (req, res) => {
  const consoleKey = normalizeConsole(req.params.consoleKey);
  if (!SECTIONS[consoleKey]) return sendError(res, 404, "Unknown operate console", { console: consoleKey, availableConsoles: Object.keys(SECTIONS) });

  const section = normalizeSection(consoleKey, req.params.sectionKey);
  if (!SECTIONS[consoleKey].includes(section)) return sendError(res, 404, "Unknown operate section", { console: consoleKey, section, availableSections: SECTIONS[consoleKey] });

  return res.json(buildSection(consoleKey, section));
});

router.get("/:consoleKey/sections/:sectionKey", (req, res) => {
  const consoleKey = normalizeConsole(req.params.consoleKey);
  if (!SECTIONS[consoleKey]) return sendError(res, 404, "Unknown operate console", { console: consoleKey, availableConsoles: Object.keys(SECTIONS) });

  const section = normalizeSection(consoleKey, req.params.sectionKey);
  if (!SECTIONS[consoleKey].includes(section)) return sendError(res, 404, "Unknown operate section", { console: consoleKey, section, availableSections: SECTIONS[consoleKey] });

  return res.json(buildSection(consoleKey, section));
});

router.get("/:consoleKey/export/:sectionKey", (req, res) => {
  const consoleKey = normalizeConsole(req.params.consoleKey);
  if (!SECTIONS[consoleKey]) return sendError(res, 404, "Unknown operate console", { console: consoleKey, availableConsoles: Object.keys(SECTIONS) });

  const section = normalizeSection(consoleKey, req.params.sectionKey);
  if (!SECTIONS[consoleKey].includes(section)) return sendError(res, 404, "Unknown operate section", { console: consoleKey, section, availableSections: SECTIONS[consoleKey] });

  const data = buildSection(consoleKey, section);
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="goodos-${consoleKey}-${section}-${Date.now()}.json"`);
  return res.send(JSON.stringify(data, null, 2));
});

router.get("/:consoleKey/:sectionKey", (req, res) => {
  const consoleKey = normalizeConsole(req.params.consoleKey);
  if (!SECTIONS[consoleKey]) return sendError(res, 404, "Unknown operate console", { console: consoleKey, availableConsoles: Object.keys(SECTIONS) });

  const section = normalizeSection(consoleKey, req.params.sectionKey);
  if (!SECTIONS[consoleKey].includes(section)) return sendError(res, 404, "Unknown operate section", { console: consoleKey, section, availableSections: SECTIONS[consoleKey] });

  return res.json(buildSection(consoleKey, section));
});

module.exports = router;
