const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");

const router = express.Router();
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const SECTION_ALIASES = {
  general: "general",
  "compute-and-disk": "compute-and-disk",
  compute: "compute-and-disk",
  disk: "compute-and-disk",
  infrastructure: "infrastructure",
  integrations: "integrations",
  "api-keys": "api-keys",
  apikeys: "api-keys",
  keys: "api-keys",
  "jwt-keys": "jwt-keys",
  jwt: "jwt-keys",
  "log-drains": "log-drains",
  logdrains: "log-drains",
  drains: "log-drains",
  "add-ons": "add-ons",
  addons: "add-ons",
  "data-api": "data-api",
  dataapi: "data-api",
  vault: "vault",
  subscription: "subscription",
  usage: "usage"
};

const KNOWN_SECTIONS = [
  "general",
  "compute-and-disk",
  "infrastructure",
  "integrations",
  "api-keys",
  "jwt-keys",
  "log-drains",
  "add-ons",
  "data-api",
  "vault",
  "subscription",
  "usage"
];

function nowIso() {
  return new Date().toISOString();
}

function cleanKey(value) {
  const key = String(value || "")
    .trim()
    .replace(/<[^>]*>/g, "")
    .replace(/[+"'`]/g, "")
    .replace(/[.)\];,]+$/g, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();

  return SECTION_ALIASES[key] || key;
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

function requireProjectSettingsAuth(req, res, next) {
  if (existingAuthMiddleware) {
    return existingAuthMiddleware(req, res, next);
  }

  const authHeader = String(req.headers.authorization || "");
  const cookie = String(req.headers.cookie || "");
  const hasBearer = /^Bearer\s+.+/i.test(authHeader);
  const hasSessionCookie = cookie.includes("token") || cookie.includes("session");

  if (!hasBearer && !hasSessionCookie) {
    return sendError(res, 401, "Authorization token required");
  }

  return next();
}

router.use(requireProjectSettingsAuth);

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

function safeReadFile(filePath, maxBytes = 120000) {
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
    recentCommits: run("git log -8 --pretty=format:%h%x09%ad%x09%s --date=short")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash, date, ...message] = line.split("\t");
        return {
          hash,
          date,
          message: message.join(" ")
        };
      })
  };
}

function getDiskInfo() {
  const df = run("df -Pk . | tail -1", 3000);

  if (!df) {
    return {
      filesystem: "Unavailable",
      size: "Unavailable",
      used: "Unavailable",
      available: "Unavailable",
      usedPercent: "Unavailable"
    };
  }

  const parts = df.split(/\s+/);

  return {
    filesystem: parts[0] || "unknown",
    size: humanBytes(Number(parts[1] || 0) * 1024),
    used: humanBytes(Number(parts[2] || 0) * 1024),
    available: humanBytes(Number(parts[3] || 0) * 1024),
    usedPercent: parts[4] || "unknown"
  };
}

function getPm2Rows() {
  const raw = run("pm2 jlist", 8000);

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

function walkFiles(startDir, options = {}) {
  const maxFiles = options.maxFiles || 2500;
  const maxDepth = options.maxDepth || 5;
  const includeRegex = options.includeRegex || null;
  const contentRegex = options.contentRegex || null;

  const rows = [];
  let folders = 0;
  let bytes = 0;
  let truncated = false;

  if (!safeExists(startDir)) {
    return {
      exists: false,
      files: rows,
      folders,
      bytes,
      truncated
    };
  }

  function walk(currentDir, depth) {
    if (rows.length >= maxFiles) {
      truncated = true;
      return;
    }

    if (depth > maxDepth) return;

    for (const entry of safeReadDir(currentDir)) {
      if (rows.length >= maxFiles) {
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

        rows.push({
          file: rel(full),
          extension: path.extname(entry.name).toLowerCase() || "none",
          size: humanBytes(size),
          bytes: size,
          modifiedAt: stat ? stat.mtime.toISOString() : null
        });
      }
    }
  }

  walk(startDir, 0);

  rows.sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")));

  return {
    exists: true,
    files: rows,
    folders,
    bytes,
    truncated
  };
}

function discoverFiles(locations, regex, contentRegex) {
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

  return rows.slice(0, 100);
}

function routeInventory(contentRegex = /\.(get|post|put|patch|delete|use)\s*\(/i) {
  const files = discoverFiles(
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

function parseLogs(filterRegex = null) {
  const candidates = [
    path.join(PROJECT_ROOT, "logs", "app.log"),
    path.join(PROJECT_ROOT, "logs", "error.log"),
    path.join(PROJECT_ROOT, "logs", "access.log"),
    "/var/log/nginx/access.log",
    "/var/log/nginx/error.log"
  ];

  const existing = candidates.filter(safeExists);
  const result = {
    source: existing[0] || "No log source found",
    sources: existing.map((file) => ({
      file,
      size: humanBytes(safeStat(file)?.size || 0),
      modifiedAt: safeStat(file)?.mtime?.toISOString?.() || null
    })),
    linesChecked: 0,
    statusCounts: {},
    methodCounts: {},
    topPaths: [],
    recentErrors: [],
    recentLines: []
  };

  const pathCounts = {};

  for (const file of existing.slice(0, 5)) {
    const lines = tailFile(file).split("\n").filter(Boolean).slice(-5000);

    for (const line of lines) {
      if (filterRegex && !filterRegex.test(line)) continue;

      result.linesChecked += 1;

      if (result.recentLines.length < 40) {
        result.recentLines.unshift({
          source: file,
          log: line.slice(0, 320)
        });
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
          result.recentErrors.unshift({
            source: file,
            error: line.slice(0, 320)
          });
        }
      } else if (/error|failed|exception|warn/i.test(line) && result.recentErrors.length < 30) {
        result.recentErrors.unshift({
          source: file,
          error: line.slice(0, 320)
        });
      }
    }
  }

  result.topPaths = Object.entries(pathCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([requestPath, requests]) => ({
      path: requestPath,
      requests
    }));

  return result;
}

function envRows(keys) {
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

function makeResponse(section, title, subtitle, metrics, tables, notes = [], extra = {}) {
  return {
    success: true,
    console: "project-settings",
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

function sectionGeneral() {
  const pkg = getPackageInfo();
  const git = getGitInfo();

  return makeResponse(
    "general",
    "General",
    "Project name, ID, region, lifecycle, package version, Git state, and runtime identity.",
    [
      { label: "Package", value: pkg.name },
      { label: "Version", value: pkg.version },
      { label: "Git Branch", value: git.branch },
      { label: "Modified Files", value: git.modifiedFiles }
    ],
    [
      {
        title: "Project Identity",
        columns: ["name", "value"],
        rows: [
          { name: "Project Root", value: PROJECT_ROOT },
          { name: "Package", value: pkg.name },
          { name: "Package Version", value: pkg.version },
          { name: "Environment", value: process.env.NODE_ENV || "unknown" },
          { name: "Port", value: process.env.PORT || "not set" },
          { name: "Node Version", value: process.version },
          { name: "Platform", value: `${os.platform()} ${os.release()}` }
        ]
      },
      {
        title: "Git State",
        columns: ["name", "value"],
        rows: [
          { name: "Branch", value: git.branch },
          { name: "Commit", value: git.commit },
          { name: "Last Commit", value: git.lastCommit },
          { name: "Modified Files", value: git.modifiedFiles }
        ]
      },
      {
        title: "Recent Commits",
        columns: ["hash", "date", "message"],
        rows: git.recentCommits
      }
    ],
    ["General settings are read-only in this panel."]
  );
}

function sectionComputeDisk() {
  const disk = getDiskInfo();
  const pm2 = getPm2Rows();
  const memory = process.memoryUsage();
  const uptimeSeconds = Math.round(process.uptime());

  return makeResponse(
    "compute-and-disk",
    "Compute and Disk",
    "Compute sizing, disk controls, PM2 runtime health, Node memory, and VPS resource readiness.",
    [
      { label: "Disk Used", value: disk.usedPercent },
      { label: "Disk Free", value: disk.available },
      { label: "PM2 Apps", value: pm2.length },
      { label: "Node Uptime", value: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m` }
    ],
    [
      {
        title: "Disk",
        columns: ["name", "value"],
        rows: Object.entries(disk).map(([name, value]) => ({ name, value }))
      },
      {
        title: "Node Memory",
        columns: ["name", "value"],
        rows: [
          { name: "RSS", value: humanBytes(memory.rss) },
          { name: "Heap Total", value: humanBytes(memory.heapTotal) },
          { name: "Heap Used", value: humanBytes(memory.heapUsed) },
          { name: "External", value: humanBytes(memory.external) }
        ]
      },
      {
        title: "PM2 Runtime",
        columns: ["name", "status", "restarts", "cpu", "memory", "uptime"],
        rows: pm2
      }
    ],
    ["This section is read-only and does not resize compute or modify disk settings."]
  );
}

function sectionInfrastructure() {
  const pm2 = getPm2Rows();
  const nginxStatus = run("systemctl is-active nginx", 3000) || "unknown";
  const certbotStatus = run("systemctl is-active certbot.timer", 3000) || "unknown";
  const sshStatus = run("systemctl is-active ssh || systemctl is-active sshd", 3000) || "unknown";

  return makeResponse(
    "infrastructure",
    "Infrastructure",
    "Project infrastructure shell with service status, PM2 apps, Nginx, Certbot, and SSH readiness.",
    [
      { label: "Nginx", value: nginxStatus },
      { label: "Certbot Timer", value: certbotStatus },
      { label: "SSH", value: sshStatus },
      { label: "PM2 Apps", value: pm2.length }
    ],
    [
      {
        title: "Core Services",
        columns: ["service", "status"],
        rows: [
          { service: "nginx", status: nginxStatus },
          { service: "certbot.timer", status: certbotStatus },
          { service: "ssh/sshd", status: sshStatus }
        ]
      },
      {
        title: "PM2 Apps",
        columns: ["name", "status", "restarts", "cpu", "memory", "uptime"],
        rows: pm2
      }
    ],
    ["Infrastructure actions are read-only here; service changes should remain command-controlled."]
  );
}

function sectionIntegrations() {
  const pkg = getPackageInfo();
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const depRows = Object.entries(deps).map(([name, version]) => ({ package: name, version })).sort((a, b) => a.package.localeCompare(b.package));
  const env = envRows([
    "DATABASE_URL",
    "SUPABASE_URL",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "REDIS_URL",
    "S3_BUCKET",
    "R2_BUCKET",
    "SENDGRID_API_KEY",
    "OPENAI_API_KEY"
  ]);

  return makeResponse(
    "integrations",
    "Integrations",
    "Project integration settings, package dependencies, provider environment, and installed integration readiness.",
    [
      { label: "Packages", value: depRows.length },
      { label: "Env Keys", value: env.length },
      { label: "Configured", value: env.filter((row) => row.status === "Configured").length },
      { label: "Missing", value: env.filter((row) => row.status === "Missing").length }
    ],
    [
      {
        title: "Integration Environment",
        columns: ["setting", "status", "value"],
        rows: env
      },
      {
        title: "Installed Packages",
        columns: ["package", "version"],
        rows: depRows.slice(0, 120)
      }
    ],
    ["Secret values are masked."]
  );
}

function sectionApiKeys() {
  const env = envRows([
    "API_KEY",
    "GOODOS_API_KEY",
    "ADMIN_API_KEY",
    "PUBLIC_API_KEY",
    "SERVICE_API_KEY",
    "SENDGRID_API_KEY",
    "STRIPE_SECRET_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "CLOUDFLARE_API_TOKEN"
  ]);

  const routes = routeInventory(/api.?key|token|key|credential|secret/i);

  return makeResponse(
    "api-keys",
    "API Keys",
    "Project API key settings, environment readiness, masked key status, and API-key route inventory.",
    [
      { label: "Key Slots", value: env.length },
      { label: "Configured", value: env.filter((row) => row.status === "Configured").length },
      { label: "Missing", value: env.filter((row) => row.status === "Missing").length },
      { label: "Key Routes", value: routes.length }
    ],
    [
      {
        title: "API Key Environment",
        columns: ["setting", "status", "value"],
        rows: env
      },
      {
        title: "API Key Related Routes",
        columns: ["file", "endpoints", "size", "modifiedAt"],
        rows: routes
      }
    ],
    ["Key values are masked and never returned."]
  );
}

function sectionJwtKeys() {
  const env = envRows([
    "JWT_SECRET",
    "JWT_EXPIRES_IN",
    "JWT_REFRESH_SECRET",
    "JWT_REFRESH_EXPIRES_IN",
    "SESSION_SECRET",
    "ACCESS_TOKEN_SECRET",
    "REFRESH_TOKEN_SECRET"
  ]);

  const authRoutes = routeInventory(/jwt|token|session|auth|login|logout|refresh/i);

  return makeResponse(
    "jwt-keys",
    "JWT Keys",
    "JWT key settings, token/session configuration, masked secret status, and auth route inventory.",
    [
      { label: "JWT Settings", value: env.length },
      { label: "Configured", value: env.filter((row) => row.status === "Configured").length },
      { label: "Auth Routes", value: authRoutes.length },
      { label: "JWT Secret", value: process.env.JWT_SECRET ? "Configured" : "Missing" }
    ],
    [
      {
        title: "JWT / Session Environment",
        columns: ["setting", "status", "value"],
        rows: env
      },
      {
        title: "Auth / Token Routes",
        columns: ["file", "endpoints", "size", "modifiedAt"],
        rows: authRoutes
      }
    ],
    ["JWT and session secret values are masked."]
  );
}

function sectionLogDrains() {
  const logs = parseLogs();
  const env = envRows([
    "LOG_DRAIN_URL",
    "LOGTAIL_TOKEN",
    "DATADOG_API_KEY",
    "SENTRY_DSN",
    "AXIOM_TOKEN",
    "BETTERSTACK_TOKEN",
    "CLOUDFLARE_LOGPUSH"
  ]);

  return makeResponse(
    "log-drains",
    "Log Drains",
    "External log drain settings, log source inventory, export readiness, and recent backend log samples.",
    [
      { label: "Drain Keys", value: env.length },
      { label: "Configured", value: env.filter((row) => row.status === "Configured").length },
      { label: "Log Sources", value: logs.sources.length },
      { label: "Lines Checked", value: logs.linesChecked }
    ],
    [
      {
        title: "Log Drain Environment",
        columns: ["setting", "status", "value"],
        rows: env
      },
      {
        title: "Log Sources",
        columns: ["file", "size", "modifiedAt"],
        rows: logs.sources
      },
      {
        title: "Recent Log Lines",
        columns: ["source", "log"],
        rows: logs.recentLines
      }
    ],
    ["External drain secrets are masked."]
  );
}

function sectionAddOns() {
  const pkg = getPackageInfo();
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const addonPackages = Object.entries(deps)
    .filter(([name]) => /stripe|redis|bull|cron|mail|sendgrid|s3|aws|openai|anthropic|cloudflare|socket|ws|jwt|passport/i.test(name))
    .map(([name, version]) => ({ addOn: name, version }))
    .sort((a, b) => a.addOn.localeCompare(b.addOn));

  const addonFiles = discoverFiles(
    ["src", "services", "routes", "jobs", "workers", "integrations"],
    /\.(js|mjs|cjs|ts|tsx|json)$/i,
    /add.?on|plugin|integration|stripe|redis|cron|worker|queue|mail|openai|cloudflare|s3/i
  );

  return makeResponse(
    "add-ons",
    "Add-ons",
    "Project add-on settings, installed add-on packages, integration modules, and feature expansion inventory.",
    [
      { label: "Add-on Packages", value: addonPackages.length },
      { label: "Add-on Files", value: addonFiles.length },
      { label: "Dependencies", value: Object.keys(deps).length },
      { label: "Package", value: pkg.version }
    ],
    [
      {
        title: "Add-on Packages",
        columns: ["addOn", "version"],
        rows: addonPackages
      },
      {
        title: "Add-on / Integration Files",
        columns: ["file", "extension", "size", "modifiedAt"],
        rows: addonFiles
      }
    ],
    ["This panel only inventories add-ons. It does not install or remove packages."]
  );
}

function sectionDataApi() {
  const routes = routeInventory(/data|api|postgrest|rest|table|database|rows/i);
  const dbFiles = discoverFiles(
    ["migrations", "sql", "prisma", "src"],
    /\.(sql|prisma|js|ts|cjs|mjs)$/i,
    /database|postgres|sequelize|knex|prisma|pg\.|query\(|select\s+|insert\s+|update\s+|delete\s+/i
  );

  return makeResponse(
    "data-api",
    "Data API",
    "Data API integration settings, REST route inventory, database configuration, and published route readiness.",
    [
      { label: "Data Routes", value: routes.length },
      { label: "DB Files", value: dbFiles.length },
      { label: "Database URL", value: process.env.DATABASE_URL ? "Configured" : "Missing" },
      { label: "Node Env", value: process.env.NODE_ENV || "unknown" }
    ],
    [
      {
        title: "Data API Routes",
        columns: ["file", "endpoints", "size", "modifiedAt"],
        rows: routes
      },
      {
        title: "Database / Query Files",
        columns: ["file", "extension", "size", "modifiedAt"],
        rows: dbFiles
      },
      {
        title: "Data API Environment",
        columns: ["setting", "status", "value"],
        rows: envRows(["DATABASE_URL", "POSTGREST_URL", "DATA_API_URL", "PGHOST", "PGDATABASE", "PGUSER"])
      }
    ],
    ["Database URL is masked."]
  );
}

function sectionVault() {
  const env = envRows([
    "VAULT_KEY",
    "VAULT_SECRET",
    "JWT_SECRET",
    "SESSION_SECRET",
    "DATABASE_URL",
    "STRIPE_SECRET_KEY",
    "OPENAI_API_KEY",
    "SMTP_PASS",
    "AWS_SECRET_ACCESS_KEY",
    "R2_SECRET_ACCESS_KEY"
  ]);

  const vaultFiles = discoverFiles(
    ["src", "services", "routes", "utils", "middleware"],
    /\.(js|mjs|cjs|ts|tsx|json)$/i,
    /vault|secret|encrypt|decrypt|crypto|credential|key/i
  );

  return makeResponse(
    "vault",
    "Vault",
    "Vault settings, encryption readiness, masked secret status, and secret-management source inventory.",
    [
      { label: "Vault Keys", value: env.length },
      { label: "Configured", value: env.filter((row) => row.status === "Configured").length },
      { label: "Vault Files", value: vaultFiles.length },
      { label: "JWT Secret", value: process.env.JWT_SECRET ? "Configured" : "Missing" }
    ],
    [
      {
        title: "Vault / Secret Environment",
        columns: ["setting", "status", "value"],
        rows: env
      },
      {
        title: "Vault / Secret Files",
        columns: ["file", "extension", "size", "modifiedAt"],
        rows: vaultFiles
      }
    ],
    ["Secret values are masked."]
  );
}

function sectionSubscription() {
  const env = envRows([
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_ID",
    "STRIPE_PRODUCT_ID",
    "BILLING_PLAN",
    "SUBSCRIPTION_STATUS",
    "PAYMENT_PROVIDER"
  ]);

  const stripeFiles = discoverFiles(
    ["src", "routes", "services", "workers", "jobs"],
    /\.(js|mjs|cjs|ts|tsx|json)$/i,
    /stripe|checkout|payment|invoice|webhook|subscription|billing|plan/i
  );

  return makeResponse(
    "subscription",
    "Subscription",
    "Subscription settings, billing provider readiness, Stripe/webhook configuration, and billing source inventory.",
    [
      { label: "Billing Keys", value: env.length },
      { label: "Configured", value: env.filter((row) => row.status === "Configured").length },
      { label: "Billing Files", value: stripeFiles.length },
      { label: "Provider", value: process.env.PAYMENT_PROVIDER || "Not configured" }
    ],
    [
      {
        title: "Billing Environment",
        columns: ["setting", "status", "value"],
        rows: env
      },
      {
        title: "Billing / Subscription Files",
        columns: ["file", "extension", "size", "modifiedAt"],
        rows: stripeFiles
      }
    ],
    ["Billing secrets are masked. No charges or subscription updates are performed from this panel."]
  );
}

function sectionUsage() {
  const disk = getDiskInfo();
  const logs = parseLogs();
  const pm2 = getPm2Rows();
  const storageStats = walkFiles(PROJECT_ROOT, { maxFiles: 5000, maxDepth: 4 });

  return makeResponse(
    "usage",
    "Usage",
    "Usage and billing metrics shell with disk, storage, runtime, request logs, and PM2 usage signals.",
    [
      { label: "Disk Used", value: disk.usedPercent },
      { label: "Project Files", value: storageStats.files.length },
      { label: "PM2 Apps", value: pm2.length },
      { label: "Log Lines", value: logs.linesChecked }
    ],
    [
      {
        title: "Disk Usage",
        columns: ["name", "value"],
        rows: Object.entries(disk).map(([name, value]) => ({ name, value }))
      },
      {
        title: "PM2 Runtime",
        columns: ["name", "status", "restarts", "cpu", "memory", "uptime"],
        rows: pm2
      },
      {
        title: "Top Request Paths",
        columns: ["path", "requests"],
        rows: logs.topPaths
      },
      {
        title: "Recent Errors",
        columns: ["source", "error"],
        rows: logs.recentErrors
      }
    ],
    ["Usage is read-only and based on available VPS signals."]
  );
}

function buildSection(section) {
  if (section === "general") return sectionGeneral();
  if (section === "compute-and-disk") return sectionComputeDisk();
  if (section === "infrastructure") return sectionInfrastructure();
  if (section === "integrations") return sectionIntegrations();
  if (section === "api-keys") return sectionApiKeys();
  if (section === "jwt-keys") return sectionJwtKeys();
  if (section === "log-drains") return sectionLogDrains();
  if (section === "add-ons") return sectionAddOns();
  if (section === "data-api") return sectionDataApi();
  if (section === "vault") return sectionVault();
  if (section === "subscription") return sectionSubscription();
  if (section === "usage") return sectionUsage();

  return null;
}

function buildSummary() {
  const git = getGitInfo();
  const disk = getDiskInfo();

  return {
    success: true,
    console: "project-settings",
    title: "Project Settings",
    generatedAt: nowIso(),
    sections: KNOWN_SECTIONS.map((section) => ({
      key: section,
      label: section.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
      endpoint: `/api/admin/project-settings-console/section/${section}`
    })),
    metrics: [
      { label: "Sections", value: KNOWN_SECTIONS.length },
      { label: "Git Branch", value: git.branch },
      { label: "Git Commit", value: git.commit },
      { label: "Disk Used", value: disk.usedPercent }
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
  const section = cleanKey(req.params.sectionKey);
  const data = buildSection(section);

  if (!data) {
    return sendError(res, 404, "Unknown project settings section", {
      section,
      availableSections: KNOWN_SECTIONS
    });
  }

  return res.json(data);
});

router.get("/sections/:sectionKey", (req, res) => {
  const section = cleanKey(req.params.sectionKey);
  const data = buildSection(section);

  if (!data) {
    return sendError(res, 404, "Unknown project settings section", {
      section,
      availableSections: KNOWN_SECTIONS
    });
  }

  return res.json(data);
});

router.get("/export/:sectionKey", (req, res) => {
  const section = cleanKey(req.params.sectionKey);
  const data = buildSection(section);

  if (!data) {
    return sendError(res, 404, "Unknown project settings section", {
      section,
      availableSections: KNOWN_SECTIONS
    });
  }

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="goodos-project-settings-${section}-${Date.now()}.json"`);
  return res.send(JSON.stringify(data, null, 2));
});

router.get("/:sectionKey", (req, res) => {
  const section = cleanKey(req.params.sectionKey);
  const data = buildSection(section);

  if (!data) {
    return sendError(res, 404, "Unknown project settings section", {
      section,
      availableSections: KNOWN_SECTIONS
    });
  }

  return res.json(data);
});

module.exports = router;
