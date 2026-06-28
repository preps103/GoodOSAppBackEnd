const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");

const router = express.Router();
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const SECTION_ALIASES = {
  functions: "functions",
  function: "functions",
  fn: "functions",
  funcs: "functions",
  secrets: "secrets",
  secret: "secrets",
  env: "secrets",
  environment: "secrets",
  templates: "templates",
  template: "templates",
  starters: "templates",
  deployments: "deployments",
  deployment: "deployments",
  deploys: "deployments",
  releases: "deployments",
  executions: "executions",
  execution: "executions",
  runs: "executions",
  logs: "executions",
  invocations: "executions"
};

const KNOWN_SECTIONS = [
  "functions",
  "secrets",
  "templates",
  "deployments",
  "executions"
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

function requireEdgeFunctionsConsoleAuth(req, res, next) {
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

router.use(requireEdgeFunctionsConsoleAuth);

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
      dependencies: Object.keys(pkg.dependencies || {}).length,
      devDependencies: Object.keys(pkg.devDependencies || {}).length
    };
  } catch (_) {
    return {
      name: "GoodAppBackEnd",
      version: "unknown",
      scripts: {},
      dependencies: 0,
      devDependencies: 0
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

function discoverFunctionFiles() {
  const locations = [
    "src/functions",
    "functions",
    "edge-functions",
    "src/edge-functions",
    "api",
    "src/api",
    "src/routes"
  ];

  const rows = [];
  const seen = new Set();

  for (const location of locations) {
    const absolute = path.join(PROJECT_ROOT, location);
    const scan = walkFiles(absolute, {
      maxFiles: 1800,
      maxDepth: 5,
      includeRegex: /\.(js|mjs|cjs|ts|tsx)$/i
    });

    for (const file of scan.files) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);

      const content = safeReadFile(path.join(PROJECT_ROOT, file.path), 80000);
      const endpointMatches = [];
      const routeRegex = /\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/g;
      let match;

      while ((match = routeRegex.exec(content)) !== null && endpointMatches.length < 8) {
        endpointMatches.push(`${match[1].toUpperCase()} ${match[2]}`);
      }

      const handlerCount =
        (content.match(/module\.exports|exports\.|export\s+default|export\s+async|async\s+function|function\s+/g) || []).length;

      rows.push({
        function: file.name.replace(/\.(js|mjs|cjs|ts|tsx)$/i, ""),
        file: file.path,
        type: file.path.includes("routes") ? "Route-backed function" : "Edge function",
        handlers: handlerCount,
        endpoints: endpointMatches.join(", ") || "Not detected",
        size: file.sizeHuman,
        modifiedAt: file.modifiedAt
      });
    }
  }

  return rows.sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || ""))).slice(0, 80);
}

function discoverTemplateFiles() {
  const locations = [
    "src/templates",
    "templates",
    "src/public/templates",
    "public/templates",
    "examples",
    "starter-templates",
    "starters"
  ];

  const rows = [];
  const seen = new Set();

  for (const location of locations) {
    const absolute = path.join(PROJECT_ROOT, location);
    const scan = walkFiles(absolute, {
      maxFiles: 1200,
      maxDepth: 5,
      includeRegex: /\.(html|md|json|js|mjs|cjs|ts|tsx|txt|yaml|yml)$/i
    });

    for (const file of scan.files) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);

      rows.push({
        template: file.name,
        file: file.path,
        extension: file.extension,
        size: file.sizeHuman,
        modifiedAt: file.modifiedAt
      });
    }
  }

  return rows.sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || ""))).slice(0, 80);
}

function parseLogs() {
  const candidates = [
    path.join(PROJECT_ROOT, "logs", "execution.log"),
    path.join(PROJECT_ROOT, "logs", "app.log"),
    path.join(PROJECT_ROOT, "logs", "error.log"),
    "/var/log/nginx/access.log",
    "/var/log/nginx/error.log"
  ];

  const found = candidates.find((file) => safeExists(file));

  const result = {
    source: found || "No execution log found",
    linesChecked: 0,
    statusCounts: {},
    methodCounts: {},
    topPaths: [],
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

    const lines = buffer.toString("utf8").split("\n").filter(Boolean).slice(-5000);
    const pathCounts = {};

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
  } catch (err) {
    result.error = err.message;
  }

  return result;
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

function sectionFunctions() {
  const rows = discoverFunctionFiles();
  const routeBacked = rows.filter((row) => row.type === "Route-backed function").length;

  return makeResponse(
    "functions",
    "Functions",
    "Live server-side function registry discovered from routes, API folders, and edge function folders.",
    [
      { label: "Functions Found", value: rows.length },
      { label: "Route-Backed", value: routeBacked },
      { label: "Edge Files", value: rows.length - routeBacked },
      { label: "Total Handlers", value: rows.reduce((sum, row) => sum + Number(row.handlers || 0), 0) }
    ],
    [
      {
        title: "Function Registry",
        columns: ["function", "type", "file", "handlers", "endpoints", "size", "modifiedAt"],
        rows
      }
    ],
    [
      "This panel scans live backend folders and route files without exposing source code.",
      "Endpoints are detected from Express route patterns when available."
    ]
  );
}

function sectionSecrets() {
  const keys = [
    "NODE_ENV",
    "PORT",
    "DATABASE_URL",
    "JWT_SECRET",
    "JWT_EXPIRES_IN",
    "SESSION_SECRET",
    "CORS_ORIGIN",
    "SMTP_HOST",
    "SMTP_USER",
    "SMTP_PASS",
    "SENDGRID_API_KEY",
    "STRIPE_SECRET_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "S3_BUCKET",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "CLOUDFLARE_API_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET"
  ];

  const rows = getEnvRows(keys);
  const configured = rows.filter((row) => row.status === "Configured").length;

  return makeResponse(
    "secrets",
    "Secrets",
    "Runtime environment and function secret manager status.",
    [
      { label: "Secrets Checked", value: rows.length },
      { label: "Configured", value: configured },
      { label: "Missing", value: rows.length - configured },
      { label: "Runtime", value: process.env.NODE_ENV || "unknown" }
    ],
    [
      {
        title: "Secret Configuration",
        columns: ["setting", "status", "value"],
        rows
      }
    ],
    [
      "Secret values are masked. This API only returns whether sensitive values are configured.",
      "Use the VPS environment or deployment secret store to add missing values."
    ]
  );
}

function sectionTemplates() {
  const rows = discoverTemplateFiles();
  const extensions = {};

  for (const row of rows) {
    extensions[row.extension] = (extensions[row.extension] || 0) + 1;
  }

  const extensionRows = Object.entries(extensions)
    .sort((a, b) => b[1] - a[1])
    .map(([extension, count]) => ({ extension, count }));

  return makeResponse(
    "templates",
    "Templates",
    "Starter template shell and reusable function template inventory.",
    [
      { label: "Templates Found", value: rows.length },
      { label: "Template Types", value: extensionRows.length },
      { label: "Latest Template", value: rows[0]?.template || "None" },
      { label: "Template Folders", value: "Scanned" }
    ],
    [
      {
        title: "Template Files",
        columns: ["template", "file", "extension", "size", "modifiedAt"],
        rows
      },
      {
        title: "Template Type Breakdown",
        columns: ["extension", "count"],
        rows: extensionRows
      }
    ],
    [
      "This panel detects reusable starter files and templates from common template folders.",
      "Template creation/editing can be added later as a protected write workflow."
    ]
  );
}

function sectionDeployments() {
  const pkg = getPackageInfo();
  const git = getGitInfo();
  const pm2Rows = getPm2Rows();

  const scriptRows = Object.entries(pkg.scripts || {}).map(([name, command]) => ({
    script: name,
    command
  }));

  return makeResponse(
    "deployments",
    "Deployments",
    "Function deployment history, git state, package scripts, and PM2 runtime status.",
    [
      { label: "Package Version", value: pkg.version },
      { label: "Git Branch", value: git.branch },
      { label: "Git Commit", value: git.commit },
      { label: "PM2 Apps", value: pm2Rows.length }
    ],
    [
      {
        title: "PM2 Runtime",
        columns: ["name", "status", "restarts", "cpu", "memory", "uptime"],
        rows: pm2Rows
      },
      {
        title: "Recent Git Deployments",
        columns: ["hash", "date", "message"],
        rows: git.recentCommits
      },
      {
        title: "Package Scripts",
        columns: ["script", "command"],
        rows: scriptRows
      }
    ],
    [
      "Deployment history is based on live git commits and PM2 process state.",
      "This panel is read-only and does not restart, deploy, or modify services."
    ],
    {
      package: pkg,
      git
    }
  );
}

function sectionExecutions() {
  const logs = parseLogs();
  const memory = process.memoryUsage();
  const uptimeSeconds = Math.round(process.uptime());

  const statusRows = Object.entries(logs.statusCounts).map(([status, count]) => ({ status, count }));
  const methodRows = Object.entries(logs.methodCounts).map(([method, count]) => ({ method, count }));

  return makeResponse(
    "executions",
    "Executions",
    "Function run history, runtime health, and recent execution log activity.",
    [
      { label: "Log Lines Checked", value: logs.linesChecked },
      { label: "Node Uptime", value: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m` },
      { label: "RSS Memory", value: humanBytes(memory.rss) },
      { label: "Heap Used", value: humanBytes(memory.heapUsed) }
    ],
    [
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
        title: "Top Execution Paths",
        columns: ["path", "requests"],
        rows: logs.topPaths
      },
      {
        title: "Recent Errors",
        columns: ["error"],
        rows: logs.recentErrors
      },
      {
        title: "Recent Log Lines",
        columns: ["log"],
        rows: logs.recentLines
      }
    ],
    [
      `Execution log source: ${logs.source}`,
      "This section samples the most recent available log data."
    ],
    {
      logSource: logs.source
    }
  );
}

function buildSection(section) {
  if (section === "functions") return sectionFunctions();
  if (section === "secrets") return sectionSecrets();
  if (section === "templates") return sectionTemplates();
  if (section === "deployments") return sectionDeployments();
  if (section === "executions") return sectionExecutions();

  return null;
}

function buildSummary() {
  const functions = discoverFunctionFiles();
  const templates = discoverTemplateFiles();
  const git = getGitInfo();
  const pm2Rows = getPm2Rows();

  return {
    success: true,
    title: "Edge Functions Console",
    generatedAt: nowIso(),
    sections: KNOWN_SECTIONS.map((section) => ({
      key: section,
      label: section.charAt(0).toUpperCase() + section.slice(1),
      endpoint: `/api/admin/edge-functions-console/section/${section}`
    })),
    metrics: [
      { label: "Functions", value: functions.length },
      { label: "Templates", value: templates.length },
      { label: "Git Branch", value: git.branch },
      { label: "Git Commit", value: git.commit },
      { label: "PM2 Apps", value: pm2Rows.length }
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
    return sendError(res, 404, "Unknown edge functions console section", {
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
    return sendError(res, 404, "Unknown edge functions console section", {
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
    return sendError(res, 404, "Unknown edge functions console section", {
      section,
      availableSections: KNOWN_SECTIONS
    });
  }

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="goodos-edge-functions-console-${section}-${Date.now()}.json"`);
  return res.send(JSON.stringify(data, null, 2));
});

router.get("/:sectionKey", (req, res) => {
  const section = cleanSectionKey(req.params.sectionKey);
  const data = buildSection(section);

  if (!data) {
    return sendError(res, 404, "Unknown edge functions console section", {
      section,
      availableSections: KNOWN_SECTIONS
    });
  }

  return res.json(data);
});

module.exports = router;
