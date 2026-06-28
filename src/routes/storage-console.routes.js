const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");

const router = express.Router();

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const SECTION_ALIASES = {
  files: "files",
  file: "files",
  objects: "files",
  object: "files",
  analytics: "analytics",
  stats: "analytics",
  metrics: "analytics",
  vectors: "vectors",
  vector: "vectors",
  embeddings: "vectors",
  s3: "s3",
  buckets: "s3",
  bucket: "s3",
  providers: "providers",
  provider: "providers",
  "cdn-buckets": "cdn-buckets",
  cdnbuckets: "cdn-buckets",
  cdnBuckets: "cdn-buckets",
  cdn: "cdn-buckets",
  "public-buckets": "public-buckets",
  publicbuckets: "public-buckets",
  publicBuckets: "public-buckets",
  public: "public-buckets",
  versions: "versions",
  version: "versions",
  backups: "versions"
};

const KNOWN_SECTIONS = [
  "files",
  "analytics",
  "vectors",
  "s3",
  "providers",
  "cdn-buckets",
  "public-buckets",
  "versions"
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

      if (typeof mod === "function") {
        return mod;
      }

      for (const name of names) {
        if (typeof mod?.[name] === "function") {
          return mod[name];
        }
      }
    } catch (_) {}
  }

  return null;
}

const existingAuthMiddleware = loadExistingAuthMiddleware();

function requireStorageConsoleAuth(req, res, next) {
  if (existingAuthMiddleware) {
    return existingAuthMiddleware(req, res, next);
  }

  const authHeader = String(req.headers.authorization || "");
  const hasBearer = /^Bearer\s+.+/i.test(authHeader);
  const hasSessionCookie = String(req.headers.cookie || "").includes("token") || String(req.headers.cookie || "").includes("session");

  if (!hasBearer && !hasSessionCookie) {
    return sendError(res, 401, "Authorization token required");
  }

  return next();
}

router.use(requireStorageConsoleAuth);

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

function isInsideProject(filePath) {
  const resolved = path.resolve(filePath);
  return resolved === PROJECT_ROOT || resolved.startsWith(PROJECT_ROOT + path.sep);
}

function walkStats(startDir, options = {}) {
  const maxFiles = options.maxFiles || 3000;
  const maxDepth = options.maxDepth || 5;

  const output = {
    path: relativePath(startDir),
    exists: safeExists(startDir),
    files: 0,
    folders: 0,
    bytes: 0,
    largestFiles: [],
    extensions: {},
    truncated: false
  };

  if (!output.exists) return output;

  function walk(currentDir, depth) {
    if (output.files >= maxFiles) {
      output.truncated = true;
      return;
    }

    if (depth > maxDepth) return;

    const entries = safeReadDir(currentDir);

    for (const entry of entries) {
      if (output.files >= maxFiles) {
        output.truncated = true;
        return;
      }

      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".pm2") continue;

      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        output.folders += 1;
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const stat = safeStat(fullPath);
        const size = stat ? stat.size : 0;
        const ext = path.extname(entry.name).toLowerCase() || "no extension";

        output.files += 1;
        output.bytes += size;
        output.extensions[ext] = (output.extensions[ext] || 0) + 1;

        output.largestFiles.push({
          path: relativePath(fullPath),
          size,
          sizeHuman: humanBytes(size),
          modifiedAt: stat ? stat.mtime.toISOString() : null
        });

        output.largestFiles.sort((a, b) => b.size - a.size);
        output.largestFiles = output.largestFiles.slice(0, 20);
      }
    }
  }

  walk(startDir, 0);
  return output;
}

function getDirectoryRows(paths) {
  return paths.map((item) => {
    const absolute = path.resolve(PROJECT_ROOT, item);
    const stats = walkStats(absolute, { maxFiles: 1200, maxDepth: 4 });

    return {
      location: item,
      exists: stats.exists ? "Yes" : "No",
      files: stats.files,
      folders: stats.folders,
      size: humanBytes(stats.bytes),
      truncated: stats.truncated ? "Yes" : "No"
    };
  });
}

function getDiskInfo() {
  const df = run("df -Pk . | tail -1", { timeout: 3000 });

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
    filesystem: parts[0] || "Unknown",
    size: humanBytes(Number(parts[1] || 0) * 1024),
    used: humanBytes(Number(parts[2] || 0) * 1024),
    available: humanBytes(Number(parts[3] || 0) * 1024),
    usedPercent: parts[4] || "Unknown"
  };
}

function getPackageInfo() {
  const packagePath = path.join(PROJECT_ROOT, "package.json");

  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    return {
      name: pkg.name || "GoodAppBackEnd",
      version: pkg.version || "unknown",
      scripts: Object.keys(pkg.scripts || {}).join(", ") || "none"
    };
  } catch (_) {
    return {
      name: "GoodAppBackEnd",
      version: "unknown",
      scripts: "package.json unavailable"
    };
  }
}

function parseNginxAccessLog() {
  const candidates = [
    "/var/log/nginx/access.log",
    "/var/log/nginx/backend.goodos.app.access.log",
    path.join(PROJECT_ROOT, "logs", "access.log")
  ];

  const found = candidates.find((file) => safeExists(file));
  const result = {
    source: found || "No access log found",
    linesChecked: 0,
    statusCounts: {},
    methodCounts: {},
    topPaths: [],
    recentErrors: []
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
          result.recentErrors.unshift(line.slice(0, 260));
        }
      }
    }

    result.topPaths = Object.entries(pathCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([requestPath, count]) => ({ path: requestPath, requests: count }));
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

function envValue(name) {
  return process.env[name] || "";
}

function maskEnv(name, value) {
  if (!value) return "Not configured";

  if (/SECRET|TOKEN|KEY|PASSWORD|PASS|PRIVATE|CREDENTIAL/i.test(name)) {
    return "Configured";
  }

  if (value.length > 90) {
    return value.slice(0, 42) + "..." + value.slice(-12);
  }

  return value;
}

function getEnvRows(keys) {
  return keys.map((key) => ({
    setting: key,
    status: envValue(key) ? "Configured" : "Missing",
    value: maskEnv(key, envValue(key))
  }));
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

function getBackupRows() {
  const backupDir = path.join(PROJECT_ROOT, "backups");

  return safeReadDir(backupDir)
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const fullPath = path.join(backupDir, entry.name);
      const stat = safeStat(fullPath);
      const stats = walkStats(fullPath, { maxFiles: 800, maxDepth: 2 });

      return {
        backup: entry.name,
        files: stats.files,
        size: humanBytes(stats.bytes),
        modifiedAt: stat ? stat.mtime.toISOString() : null
      };
    })
    .sort((a, b) => String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || "")))
    .slice(0, 15);
}

function getPublicBucketRows() {
  const roots = ["src/public", "public", "uploads", "storage", "data"];

  const rows = [];

  for (const root of roots) {
    const absolute = path.join(PROJECT_ROOT, root);
    if (!safeExists(absolute)) continue;

    const entries = safeReadDir(absolute).filter((entry) => entry.isDirectory());

    for (const entry of entries) {
      const fullPath = path.join(absolute, entry.name);
      const stats = walkStats(fullPath, { maxFiles: 1000, maxDepth: 3 });

      rows.push({
        bucket: `${root}/${entry.name}`,
        objects: stats.files,
        folders: stats.folders,
        size: humanBytes(stats.bytes),
        publicRoute: root.includes("public") ? `/${entry.name}/` : "Internal/local"
      });
    }
  }

  return rows.sort((a, b) => Number(b.objects || 0) - Number(a.objects || 0)).slice(0, 20);
}

function getProviderRows() {
  const rows = [
    {
      provider: "Local filesystem",
      status: "Active",
      role: "Primary project storage",
      details: PROJECT_ROOT
    },
    {
      provider: "S3 / AWS",
      status: envValue("AWS_ACCESS_KEY_ID") || envValue("S3_BUCKET") ? "Configured" : "Not configured",
      role: "S3-compatible object storage",
      details: maskEnv("S3_BUCKET", envValue("S3_BUCKET") || envValue("AWS_BUCKET") || "")
    },
    {
      provider: "Cloudflare R2",
      status: envValue("R2_ACCESS_KEY_ID") || envValue("CLOUDFLARE_R2_BUCKET") ? "Configured" : "Not configured",
      role: "S3-compatible CDN object storage",
      details: maskEnv("CLOUDFLARE_R2_BUCKET", envValue("CLOUDFLARE_R2_BUCKET") || envValue("R2_BUCKET") || "")
    },
    {
      provider: "Wasabi",
      status: envValue("WASABI_ACCESS_KEY_ID") || envValue("WASABI_BUCKET") ? "Configured" : "Not configured",
      role: "S3-compatible backup storage",
      details: maskEnv("WASABI_BUCKET", envValue("WASABI_BUCKET") || "")
    },
    {
      provider: "MinIO",
      status: envValue("MINIO_ENDPOINT") || envValue("MINIO_BUCKET") ? "Configured" : "Not configured",
      role: "Self-hosted S3-compatible storage",
      details: maskEnv("MINIO_ENDPOINT", envValue("MINIO_ENDPOINT") || "")
    }
  ];

  return rows;
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

function sectionFiles() {
  const storageLocations = [
    "src/public",
    "public",
    "uploads",
    "storage",
    "data",
    "backups"
  ];

  const rows = getDirectoryRows(storageLocations);
  const totals = rows.reduce(
    (acc, row) => {
      acc.files += Number(row.files || 0);
      acc.folders += Number(row.folders || 0);
      return acc;
    },
    { files: 0, folders: 0 }
  );

  const largestFiles = storageLocations
    .flatMap((location) => {
      const absolute = path.join(PROJECT_ROOT, location);
      const stats = walkStats(absolute, { maxFiles: 1200, maxDepth: 4 });
      return stats.largestFiles || [];
    })
    .sort((a, b) => b.size - a.size)
    .slice(0, 20)
    .map((file) => ({
      file: file.path,
      size: file.sizeHuman,
      modifiedAt: file.modifiedAt
    }));

  return makeResponse(
    "files",
    "Files",
    "Bucket browser and local object inventory.",
    [
      { label: "Tracked Files", value: totals.files },
      { label: "Tracked Folders", value: totals.folders },
      { label: "Disk Used", value: getDiskInfo().used },
      { label: "Disk Free", value: getDiskInfo().available }
    ],
    [
      {
        title: "Storage Locations",
        columns: ["location", "exists", "files", "folders", "size", "truncated"],
        rows
      },
      {
        title: "Largest Objects",
        columns: ["file", "size", "modifiedAt"],
        rows: largestFiles
      }
    ],
    [
      "This panel reads the live project filesystem and shows local object locations without exposing file contents.",
      "Upload/write actions are intentionally not enabled here until provider rules and permission checks are finalized."
    ],
    {
      disk: getDiskInfo()
    }
  );
}

function sectionAnalytics() {
  const logs = parseNginxAccessLog();
  const memory = process.memoryUsage();
  const uptimeSeconds = Math.round(process.uptime());

  const statusRows = Object.entries(logs.statusCounts).map(([status, count]) => ({
    status,
    count
  }));

  const methodRows = Object.entries(logs.methodCounts).map(([method, count]) => ({
    method,
    count
  }));

  return makeResponse(
    "analytics",
    "Analytics",
    "Storage traffic, API activity, and runtime performance.",
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
        title: "Top Requested Paths",
        columns: ["path", "requests"],
        rows: logs.topPaths
      },
      {
        title: "Recent 4xx/5xx Lines",
        columns: ["error"],
        rows: logs.recentErrors.map((error) => ({ error }))
      }
    ],
    [
      `Analytics source: ${logs.source}`,
      "Nginx logs are sampled from the latest available access log data."
    ],
    {
      logSource: logs.source
    }
  );
}

function sectionVectors() {
  const vectorLocations = [
    "vectors",
    "vector_store",
    "storage/vectors",
    "data/vectors",
    "uploads/vectors",
    "src/vectors"
  ];

  const rows = getDirectoryRows(vectorLocations);
  const vectorFiles = [];

  for (const location of vectorLocations) {
    const absolute = path.join(PROJECT_ROOT, location);
    const stats = walkStats(absolute, { maxFiles: 1200, maxDepth: 5 });

    for (const file of stats.largestFiles || []) {
      if (/\.(json|jsonl|sqlite|sqlite3|db|bin|index|faiss|parquet|npy)$/i.test(file.path)) {
        vectorFiles.push({
          file: file.path,
          size: file.sizeHuman,
          modifiedAt: file.modifiedAt
        });
      }
    }
  }

  return makeResponse(
    "vectors",
    "Vectors",
    "Vector storage inventory and embedding index readiness.",
    [
      { label: "Vector Locations", value: rows.filter((row) => row.exists === "Yes").length },
      { label: "Vector Files", value: rows.reduce((sum, row) => sum + Number(row.files || 0), 0) },
      { label: "Vector Folders", value: rows.reduce((sum, row) => sum + Number(row.folders || 0), 0) },
      { label: "Index Candidates", value: vectorFiles.length }
    ],
    [
      {
        title: "Vector Locations",
        columns: ["location", "exists", "files", "folders", "size", "truncated"],
        rows
      },
      {
        title: "Index Candidate Files",
        columns: ["file", "size", "modifiedAt"],
        rows: vectorFiles.slice(0, 20)
      }
    ],
    [
      "This section detects local vector/index storage paths and common embedding file extensions.",
      "Provider-backed vector databases can be connected later through the provider configuration layer."
    ]
  );
}

function sectionS3() {
  const keys = [
    "AWS_REGION",
    "AWS_BUCKET",
    "S3_BUCKET",
    "S3_ENDPOINT",
    "S3_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "CLOUDFLARE_R2_BUCKET",
    "R2_BUCKET",
    "R2_ENDPOINT",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "WASABI_BUCKET",
    "WASABI_ACCESS_KEY_ID",
    "WASABI_SECRET_ACCESS_KEY",
    "MINIO_ENDPOINT",
    "MINIO_BUCKET",
    "MINIO_ACCESS_KEY",
    "MINIO_SECRET_KEY"
  ];

  const rows = getEnvRows(keys);
  const configured = rows.filter((row) => row.status === "Configured").length;

  return makeResponse(
    "s3",
    "S3",
    "S3-compatible access and bucket configuration.",
    [
      { label: "Config Keys Checked", value: rows.length },
      { label: "Configured Keys", value: configured },
      { label: "Missing Keys", value: rows.length - configured },
      { label: "S3 Ready", value: configured >= 3 ? "Likely" : "Needs Config" }
    ],
    [
      {
        title: "S3-Compatible Environment",
        columns: ["setting", "status", "value"],
        rows
      }
    ],
    [
      "Secret values are masked and never returned by this API.",
      "A bucket can be considered live after endpoint, bucket, region, and credentials are configured."
    ]
  );
}

function sectionProviders() {
  const rows = getProviderRows();
  const active = rows.filter((row) => row.status === "Active" || row.status === "Configured").length;

  return makeResponse(
    "providers",
    "Providers",
    "Local and S3-compatible provider configuration.",
    [
      { label: "Providers Checked", value: rows.length },
      { label: "Active/Configured", value: active },
      { label: "Local Storage", value: "Active" },
      { label: "External Providers", value: rows.length - 1 }
    ],
    [
      {
        title: "Storage Providers",
        columns: ["provider", "status", "role", "details"],
        rows
      }
    ],
    [
      "Local filesystem is always available as the baseline provider.",
      "External providers become active when the required environment variables are configured."
    ]
  );
}

function sectionCdnBuckets() {
  const rows = getPublicBucketRows();
  const cdnEnv = getEnvRows([
    "CDN_URL",
    "PUBLIC_CDN_URL",
    "CLOUDFLARE_ZONE_ID",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "R2_PUBLIC_URL",
    "ASSET_BASE_URL"
  ]);

  return makeResponse(
    "cdn-buckets",
    "CDN Buckets",
    "CDN routing, public asset origins, and cache-ready buckets.",
    [
      { label: "Public Origins", value: rows.length },
      { label: "CDN Settings", value: cdnEnv.filter((row) => row.status === "Configured").length },
      { label: "Public Objects", value: rows.reduce((sum, row) => sum + Number(row.objects || 0), 0) },
      { label: "CDN Status", value: cdnEnv.some((row) => row.status === "Configured") ? "Configured" : "Local Only" }
    ],
    [
      {
        title: "CDN Environment",
        columns: ["setting", "status", "value"],
        rows: cdnEnv
      },
      {
        title: "Public Origins",
        columns: ["bucket", "objects", "folders", "size", "publicRoute"],
        rows
      }
    ],
    [
      "This panel shows which public folders can be routed through a CDN.",
      "Cloudflare/R2 secrets are masked and only configuration status is displayed."
    ]
  );
}

function sectionPublicBuckets() {
  const rows = getPublicBucketRows();

  return makeResponse(
    "public-buckets",
    "Public Buckets",
    "Public object routing and web-accessible asset groups.",
    [
      { label: "Public Buckets", value: rows.length },
      { label: "Public Objects", value: rows.reduce((sum, row) => sum + Number(row.objects || 0), 0) },
      { label: "Total Folders", value: rows.reduce((sum, row) => sum + Number(row.folders || 0), 0) },
      { label: "Largest Bucket", value: rows[0]?.bucket || "None" }
    ],
    [
      {
        title: "Public Bucket Inventory",
        columns: ["bucket", "objects", "folders", "size", "publicRoute"],
        rows
      }
    ],
    [
      "Public buckets are detected from public/static folders and mapped to their likely web routes.",
      "This does not expose file contents; it only returns inventory counts and routes."
    ]
  );
}

function sectionVersions() {
  const pkg = getPackageInfo();
  const git = getGitInfo();
  const backups = getBackupRows();

  return makeResponse(
    "versions",
    "Versions",
    "Code version, git state, package version, and backup history.",
    [
      { label: "Package", value: pkg.name },
      { label: "Version", value: pkg.version },
      { label: "Git Branch", value: git.branch },
      { label: "Modified Files", value: git.modifiedFiles }
    ],
    [
      {
        title: "Current Build",
        columns: ["name", "value"],
        rows: [
          { name: "Package", value: pkg.name },
          { name: "Package Version", value: pkg.version },
          { name: "Git Branch", value: git.branch },
          { name: "Git Commit", value: git.commit },
          { name: "Last Commit", value: git.lastCommit },
          { name: "Modified Files", value: git.modifiedFiles },
          { name: "Scripts", value: pkg.scripts }
        ]
      },
      {
        title: "Recent Commits",
        columns: ["hash", "date", "message"],
        rows: git.recentCommits
      },
      {
        title: "Recent Backups",
        columns: ["backup", "files", "size", "modifiedAt"],
        rows: backups
      }
    ],
    [
      "This section reads live git/package state from the backend project folder.",
      "Backups are pulled from the project backups directory."
    ],
    {
      git,
      package: pkg
    }
  );
}

function buildSection(section) {
  if (section === "files") return sectionFiles();
  if (section === "analytics") return sectionAnalytics();
  if (section === "vectors") return sectionVectors();
  if (section === "s3") return sectionS3();
  if (section === "providers") return sectionProviders();
  if (section === "cdn-buckets") return sectionCdnBuckets();
  if (section === "public-buckets") return sectionPublicBuckets();
  if (section === "versions") return sectionVersions();

  return null;
}

function buildSummary() {
  const disk = getDiskInfo();
  const publicRows = getPublicBucketRows();
  const providers = getProviderRows();
  const git = getGitInfo();

  return {
    success: true,
    title: "Storage Console",
    generatedAt: nowIso(),
    sections: KNOWN_SECTIONS.map((section) => ({
      key: section,
      label: section
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" "),
      endpoint: `/api/admin/storage-console/section/${section}`
    })),
    metrics: [
      { label: "Disk Used", value: disk.used },
      { label: "Disk Free", value: disk.available },
      { label: "Public Buckets", value: publicRows.length },
      { label: "Configured Providers", value: providers.filter((row) => row.status === "Active" || row.status === "Configured").length },
      { label: "Git Branch", value: git.branch },
      { label: "Git Commit", value: git.commit }
    ],
    disk
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
    return sendError(res, 404, "Unknown storage console section", {
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
    return sendError(res, 404, "Unknown storage console section", {
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
    return sendError(res, 404, "Unknown storage console section", {
      section,
      availableSections: KNOWN_SECTIONS
    });
  }

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="goodos-storage-console-${section}-${Date.now()}.json"`);
  return res.send(JSON.stringify(data, null, 2));
});

router.get("/:sectionKey", (req, res) => {
  const section = cleanSectionKey(req.params.sectionKey);
  const data = buildSection(section);

  if (!data) {
    return sendError(res, 404, "Unknown storage console section", {
      section,
      availableSections: KNOWN_SECTIONS
    });
  }

  return res.json(data);
});

module.exports = router;
