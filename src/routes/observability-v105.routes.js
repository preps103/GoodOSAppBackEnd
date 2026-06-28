const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");

const router = express.Router();
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const SECTION_ALIASES = {
  storage: "storage",
  "storage-observability": "storage",
  realtime: "realtime",
  "realtime-observability": "realtime",
  "new-custom-report": "new-custom-report",
  "custom-report": "new-custom-report",
  "custom-reports": "new-custom-report",
  "new-report": "new-custom-report",
  reports: "new-custom-report",
  report: "new-custom-report"
};

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

function requireAuth(req, res, next) {
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

router.use(requireAuth);

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

function walkStats(startDir, options = {}) {
  const maxFiles = options.maxFiles || 2500;
  const maxDepth = options.maxDepth || 5;
  const includeRegex = options.includeRegex || null;
  const contentRegex = options.contentRegex || null;

  const result = {
    exists: safeExists(startDir),
    files: 0,
    folders: 0,
    bytes: 0,
    largestFiles: [],
    matchedFiles: [],
    truncated: false
  };

  if (!result.exists) return result;

  function walk(currentDir, depth) {
    if (result.files >= maxFiles) {
      result.truncated = true;
      return;
    }

    if (depth > maxDepth) return;

    for (const entry of safeReadDir(currentDir)) {
      if (result.files >= maxFiles) {
        result.truncated = true;
        return;
      }

      if (["node_modules", ".git", ".pm2", "dist", "build", ".next"].includes(entry.name)) continue;

      const full = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        result.folders += 1;
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (includeRegex && !includeRegex.test(entry.name)) continue;

        const stat = safeStat(full);
        const size = stat ? stat.size : 0;
        const content = contentRegex ? safeReadFile(full, 90000) : "";

        result.files += 1;
        result.bytes += size;

        const row = {
          file: rel(full),
          extension: path.extname(entry.name).toLowerCase() || "none",
          size: humanBytes(size),
          bytes: size,
          modifiedAt: stat ? stat.mtime.toISOString() : null
        };

        result.largestFiles.push(row);
        result.largestFiles.sort((a, b) => b.bytes - a.bytes);
        result.largestFiles = result.largestFiles.slice(0, 20);

        if (!contentRegex || contentRegex.test(content + " " + full)) {
          result.matchedFiles.push(row);
          result.matchedFiles = result.matchedFiles.slice(0, 80);
        }
      }
    }
  }

  walk(startDir, 0);
  return result;
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

function parseLogs(filterRegex = null) {
  const candidates = [
    path.join(PROJECT_ROOT, "logs", "app.log"),
    path.join(PROJECT_ROOT, "logs", "error.log"),
    path.join(PROJECT_ROOT, "logs", "access.log"),
    path.join(PROJECT_ROOT, "logs", "realtime.log"),
    path.join(PROJECT_ROOT, "logs", "storage.log"),
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
    const lines = tailFile(file)
      .split("\n")
      .filter(Boolean)
      .slice(-5000);

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
    console: "observability",
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

function storageSection() {
  const locations = ["src/public", "public", "uploads", "storage", "data", "backups", "logs"];
  const disk = getDiskInfo();

  const rows = locations.map((location) => {
    const stats = walkStats(path.join(PROJECT_ROOT, location), {
      maxFiles: 1500,
      maxDepth: 4
    });

    return {
      location,
      exists: stats.exists ? "Yes" : "No",
      files: stats.files,
      folders: stats.folders,
      size: humanBytes(stats.bytes),
      truncated: stats.truncated ? "Yes" : "No"
    };
  });

  const largestFiles = locations
    .flatMap((location) => {
      const stats = walkStats(path.join(PROJECT_ROOT, location), {
        maxFiles: 1500,
        maxDepth: 4
      });

      return stats.largestFiles || [];
    })
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 30)
    .map((file) => ({
      file: file.file,
      size: file.size,
      modifiedAt: file.modifiedAt
    }));

  return makeResponse(
    "storage",
    "Storage",
    "Storage observability, local object inventory, disk status, bucket-style folders, and recent large files.",
    [
      { label: "Storage Locations", value: rows.length },
      { label: "Tracked Files", value: rows.reduce((sum, row) => sum + Number(row.files || 0), 0) },
      { label: "Disk Used", value: disk.usedPercent },
      { label: "Disk Free", value: disk.available }
    ],
    [
      {
        title: "Disk",
        columns: ["name", "value"],
        rows: Object.entries(disk).map(([name, value]) => ({ name, value }))
      },
      {
        title: "Storage Locations",
        columns: ["location", "exists", "files", "folders", "size", "truncated"],
        rows
      },
      {
        title: "Largest Storage Files",
        columns: ["file", "size", "modifiedAt"],
        rows: largestFiles
      },
      {
        title: "Storage Environment",
        columns: ["setting", "status", "value"],
        rows: envRows(["S3_BUCKET", "S3_ENDPOINT", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_ENDPOINT", "CLOUDFLARE_R2_BUCKET"])
      }
    ],
    [
      "Storage observability is read-only and does not expose file contents.",
      "Secret values are masked."
    ],
    {
      disk
    }
  );
}

function realtimeSection() {
  const locations = ["src/realtime", "realtime", "src/socket", "socket", "src/sockets", "sockets", "src/events", "events", "src/channels", "channels", "src/routes", "src/services"];
  const rows = [];
  const seen = new Set();

  for (const location of locations) {
    const stats = walkStats(path.join(PROJECT_ROOT, location), {
      maxFiles: 1500,
      maxDepth: 5,
      includeRegex: /\.(js|mjs|cjs|ts|tsx)$/i,
      contentRegex: /realtime|socket|websocket|sse|eventsource|channel|presence|message|publish|subscribe|broadcast|emit\(|on\(/i
    });

    for (const file of stats.matchedFiles || []) {
      if (seen.has(file.file)) continue;
      seen.add(file.file);

      const content = safeReadFile(path.join(PROJECT_ROOT, file.file), 100000);
      const signalCount = (content.match(/emit\(|broadcast|publish|subscribe|presence|channel|message|socket|websocket|sse|EventSource/gi) || []).length;

      rows.push({
        file: file.file,
        extension: file.extension,
        realtimeSignals: signalCount,
        size: file.size,
        modifiedAt: file.modifiedAt
      });
    }
  }

  rows.sort((a, b) => Number(b.realtimeSignals || 0) - Number(a.realtimeSignals || 0));

  const logs = parseLogs(/realtime|socket|websocket|channel|presence|message|sse/i);

  return makeResponse(
    "realtime",
    "Realtime",
    "Realtime observability, channel/message source inventory, presence signals, and recent realtime log samples.",
    [
      { label: "Realtime Files", value: rows.length },
      { label: "Realtime Signals", value: rows.reduce((sum, row) => sum + Number(row.realtimeSignals || 0), 0) },
      { label: "Log Lines", value: logs.linesChecked },
      { label: "Recent Errors", value: logs.recentErrors.length }
    ],
    [
      {
        title: "Realtime Source Files",
        columns: ["file", "extension", "realtimeSignals", "size", "modifiedAt"],
        rows: rows.slice(0, 80)
      },
      {
        title: "Realtime Logs",
        columns: ["source", "log"],
        rows: logs.recentLines
      },
      {
        title: "Realtime Errors",
        columns: ["source", "error"],
        rows: logs.recentErrors
      },
      {
        title: "Realtime Environment",
        columns: ["setting", "status", "value"],
        rows: envRows(["REALTIME_ENABLED", "WEBSOCKET_ENABLED", "SSE_ENABLED", "REDIS_URL", "JWT_SECRET", "CORS_ORIGIN"])
      }
    ],
    [
      "Realtime observability is detected from source files, environment, and log signals.",
      "This panel is read-only and does not open sockets or publish messages."
    ],
    {
      logSource: logs.source
    }
  );
}

function customReportSection() {
  const git = getGitInfo();
  const disk = getDiskInfo();
  const logs = parseLogs();

  const reportFiles = [];
  const reportLocations = ["reports", "src/reports", "templates", "src/templates", "src/public", "public", "backups"];

  for (const location of reportLocations) {
    const stats = walkStats(path.join(PROJECT_ROOT, location), {
      maxFiles: 1200,
      maxDepth: 5,
      includeRegex: /\.(json|md|html|js|ts|csv|txt)$/i,
      contentRegex: /report|observability|dashboard|metric|chart|analytics|custom/i
    });

    for (const file of stats.matchedFiles || []) {
      reportFiles.push({
        file: file.file,
        extension: file.extension,
        size: file.size,
        modifiedAt: file.modifiedAt
      });
    }
  }

  const reportTemplates = [
    { report: "Service Health Report", dataSource: "PM2 + health endpoint + logs", status: "Ready to generate" },
    { report: "API Gateway Report", dataSource: "Nginx access logs + route inventory", status: "Ready to generate" },
    { report: "Database Performance Report", dataSource: "DB config + SQL/query files + logs", status: "Ready to generate" },
    { report: "Storage Report", dataSource: "Disk + storage directories + bucket env", status: "Ready to generate" },
    { report: "Realtime Report", dataSource: "Realtime source files + log samples", status: "Ready to generate" }
  ];

  return makeResponse(
    "new-custom-report",
    "New Custom Report",
    "Saved custom report builder shell with live observability sources, report templates, and export-ready JSON data.",
    [
      { label: "Report Templates", value: reportTemplates.length },
      { label: "Report Files", value: reportFiles.length },
      { label: "Log Sources", value: logs.sources.length },
      { label: "Git Commit", value: git.commit }
    ],
    [
      {
        title: "Available Report Templates",
        columns: ["report", "dataSource", "status"],
        rows: reportTemplates
      },
      {
        title: "Report / Template Files",
        columns: ["file", "extension", "size", "modifiedAt"],
        rows: reportFiles.slice(0, 80)
      },
      {
        title: "Live Build Context",
        columns: ["name", "value"],
        rows: [
          { name: "Git Branch", value: git.branch },
          { name: "Git Commit", value: git.commit },
          { name: "Last Commit", value: git.lastCommit },
          { name: "Modified Files", value: git.modifiedFiles },
          { name: "Disk Used", value: disk.usedPercent },
          { name: "Disk Free", value: disk.available },
          { name: "Log Lines Checked", value: logs.linesChecked }
        ]
      }
    ],
    [
      "Custom report generation is currently read-only and export-ready through Copy JSON.",
      "Write/save report actions can be added after permission rules are finalized."
    ]
  );
}

function buildSection(section) {
  if (section === "storage") return storageSection();
  if (section === "realtime") return realtimeSection();
  if (section === "new-custom-report") return customReportSection();
  return null;
}

router.get("/summary", (req, res) => {
  return res.json({
    success: true,
    console: "observability",
    title: "Observability Missing Cards V105",
    generatedAt: nowIso(),
    sections: [
      { key: "storage", label: "Storage", endpoint: "/api/admin/operate-console/observability/section/storage" },
      { key: "realtime", label: "Realtime", endpoint: "/api/admin/operate-console/observability/section/realtime" },
      { key: "new-custom-report", label: "New Custom Report", endpoint: "/api/admin/operate-console/observability/section/new-custom-report" }
    ]
  });
});

router.get("/section/:sectionKey", (req, res, next) => {
  const section = cleanKey(req.params.sectionKey);
  const data = buildSection(section);

  if (!data) return next();

  return res.json(data);
});

router.get("/sections/:sectionKey", (req, res, next) => {
  const section = cleanKey(req.params.sectionKey);
  const data = buildSection(section);

  if (!data) return next();

  return res.json(data);
});

router.get("/export/:sectionKey", (req, res, next) => {
  const section = cleanKey(req.params.sectionKey);
  const data = buildSection(section);

  if (!data) return next();

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="goodos-observability-${section}-${Date.now()}.json"`);
  return res.send(JSON.stringify(data, null, 2));
});

router.get("/:sectionKey", (req, res, next) => {
  const section = cleanKey(req.params.sectionKey);
  const data = buildSection(section);

  if (!data) return next();

  return res.json(data);
});

module.exports = router;
