#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const VERSION = "1.0.0";
const cwd = process.cwd();
const args = process.argv.slice(2);
const command = args[0] || "help";
const subcommand = args[1] || "";
const packageRoot = path.resolve(__dirname, "..");
const stateDir = path.join(cwd, ".goodbase");
const configFile = path.join(stateDir, "config.json");

function fail(message, code = 1) {
  process.stderr.write(`Goodbase: ${message}\n`);
  process.exit(code);
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
}

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJson(file, value, mode = 0o600) {
  ensureDirectory(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.chmodSync(file, mode);
}

function option(name, fallback = null) {
  const direct = args.find((value) => value.startsWith(`--${name}=`));
  if (direct) return direct.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : fallback;
}

function has(name) { return args.includes(`--${name}`); }

function run(binary, binaryArgs, options = {}) {
  const result = spawnSync(binary, binaryArgs, { stdio: "inherit", cwd: options.cwd || cwd, env: { ...process.env, ...(options.env || {}) } });
  if (result.error?.code === "ENOENT") fail(`${binary} is required but was not found.`);
  if (result.status !== 0) fail(`${binary} exited with status ${result.status}.`, result.status || 1);
}

function compose(actionArgs) {
  const file = path.join(stateDir, "compose.yaml");
  if (!fs.existsSync(file)) fail("Run `goodbase init` first.");
  run("docker", ["compose", "--project-directory", stateDir, "-f", file, ...actionArgs]);
}

function config() { return readJson(configFile, {}); }

async function api(endpoint, options = {}) {
  const current = config();
  const baseUrl = String(current.apiUrl || "https://base.goodos.app").replace(/\/+$/, "");
  const token = process.env.GOODBASE_ACCESS_TOKEN || current.accessToken;
  if (!token) fail("Authenticate with `goodbase login --token <token>` first.");
  const headers = { Accept: "application/json", Authorization: `Bearer ${token}`, ...(options.body ? { "Content-Type": "application/json" } : {}) };
  for (const [header, key] of [["X-GoodOS-Organization-ID","organizationId"],["X-GoodOS-Project-ID","projectId"],["X-GoodOS-Environment-ID","environmentId"]]) {
    if (current[key]) headers[header] = current[key];
  }
  const response = await fetch(`${baseUrl}${endpoint}`, { method: options.method || "GET", headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) fail(payload.message || `API request failed with status ${response.status}.`);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

function initialize() {
  ensureDirectory(stateDir);
  ensureDirectory(path.join(cwd, "migrations"));
  ensureDirectory(path.join(cwd, "functions"));
  for (const name of ["compose.yaml", "Dockerfile", "init.sql"]) {
    fs.copyFileSync(path.join(packageRoot, "deploy", "local", name), path.join(stateDir, name));
  }
  const current = config();
  writeJson(configFile, {
    version: 1,
    projectRef: current.projectRef || `local_${crypto.randomBytes(8).toString("hex")}`,
    apiUrl: current.apiUrl || "https://base.goodos.app",
    organizationId: current.organizationId || null,
    projectId: current.projectId || null,
    environmentId: current.environmentId || null
  });
  const envFile = path.join(stateDir, ".env");
  if (!fs.existsSync(envFile)) fs.writeFileSync(envFile, "POSTGRES_PASSWORD=goodbase_local_only\nGOODBASE_JWT_SECRET=local-development-secret-change-me\n", { mode: 0o600 });
  const seed = path.join(cwd, "seed.sql");
  if (!fs.existsSync(seed)) fs.writeFileSync(seed, "-- Goodbase local seed data\n", { mode: 0o640 });
  process.stdout.write(`Initialized Goodbase project ${config().projectRef || readJson(configFile).projectRef}.\n`);
}

function databaseUrl() {
  return process.env.DATABASE_URL || "postgres://postgres:goodbase_local_only@127.0.0.1:55432/postgres";
}

function migrationFiles() {
  const directory = path.join(cwd, "migrations");
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => /^\d+.*\.sql$/.test(name)).sort() : [];
}

function pushMigrations() {
  const files = migrationFiles();
  if (!files.length) return process.stdout.write("No migrations found.\n");
  const combined = [
    "\\set ON_ERROR_STOP on",
    "SELECT pg_advisory_lock(hashtext('goodbase_migrations'));",
    "CREATE TABLE IF NOT EXISTS goodbase_cli_migrations(file_name text primary key, checksum_sha256 text not null, applied_at timestamptz not null default now());"
  ];
  for (const name of files) {
    const sql = fs.readFileSync(path.join(cwd, "migrations", name), "utf8");
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");
    combined.push(`\\echo Applying ${name}`, "BEGIN;", sql, `INSERT INTO goodbase_cli_migrations(file_name,checksum_sha256) VALUES ('${name.replaceAll("'", "''")}','${checksum}') ON CONFLICT(file_name) DO UPDATE SET checksum_sha256=EXCLUDED.checksum_sha256,applied_at=NOW();`, "COMMIT;");
  }
  combined.push("SELECT pg_advisory_unlock(hashtext('goodbase_migrations'));", "");
  const file = path.join(stateDir, "migration-run.sql");
  ensureDirectory(stateDir);
  fs.writeFileSync(file, combined.join("\n"), { mode: 0o600 });
  try { run("psql", [databaseUrl(), "-f", file]); } finally { fs.rmSync(file, { force: true }); }
}

function generateTypes() {
  const output = option("output", path.join(cwd, "goodbase.types.ts"));
  const query = "COPY (SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position) TO STDOUT WITH CSV HEADER";
  const result = spawnSync("psql", [databaseUrl(), "-Atqc", query], { encoding: "utf8" });
  if (result.status !== 0) fail(result.stderr || "Type introspection failed.");
  const rows = result.stdout.trim().split("\n").slice(1).filter(Boolean).map((line) => line.split(","));
  const tables = new Map();
  for (const [table, column, type, nullable] of rows) {
    if (!tables.has(table)) tables.set(table, []);
    const ts = /int|numeric|double|real|decimal/.test(type) ? "number" : /bool/.test(type) ? "boolean" : /json/.test(type) ? "unknown" : "string";
    tables.get(table).push(`    ${JSON.stringify(column)}${nullable === "YES" ? "?" : ""}: ${ts};`);
  }
  const body = ["// Generated by Goodbase. Do not edit manually.", "export interface GoodbaseDatabase {"];
  for (const [table, columns] of tables) body.push(`  ${JSON.stringify(table)}: {`, ...columns, "  };");
  body.push("}", "");
  fs.writeFileSync(output, body.join("\n"));
  process.stdout.write(`Generated ${output}.\n`);
}

async function main() {
  if (["help", "--help", "-h"].includes(command)) {
    process.stdout.write(`Goodbase CLI ${VERSION}\n\nCommands:\n  login/logout/init/link/start/stop/status/reset\n  db diff|dump|push|pull|reset\n  migration new\n  seed\n  types generate\n  functions new|serve|deploy\n  secrets set|list\n  logs/deploy/projects list/branches create/backups list\n  domains list|add|verify\n  vectors collections|create|search\n  management operations|run\n  infrastructure status\n  production status|verify\n  recovery status|backup|restore\n  sdk list\n  sync collections|create\n  controllers list|probe\n  assurance status|run\n  imports analyze|apply\n  auth-providers list\n  attestation policies\n  messaging providers\n  product overview\n  analytics metrics\n  telemetry issues\n  config publish\n  experiments start|pause|stop\n  distribution provider-verify\n  cdn provider-verify\n  regions exercise\n  commerce spend-limit\n  public-status\n`);
    return;
  }
  if (["--version", "version"].includes(command)) return process.stdout.write(`${VERSION}\n`);
  if (command === "init") return initialize();
  if (command === "login") {
    const token = option("token"); if (!token) fail("Use --token or GOODBASE_ACCESS_TOKEN; interactive password collection is intentionally unsupported.");
    writeJson(configFile, { ...config(), accessToken: token }); return process.stdout.write("Goodbase credentials saved with owner-only permissions.\n");
  }
  if (command === "logout") { const current=config(); delete current.accessToken; writeJson(configFile,current); return process.stdout.write("Goodbase credentials removed.\n"); }
  if (command === "link") {
    writeJson(configFile, { ...config(), apiUrl: option("api-url",config().apiUrl||"https://base.goodos.app"), organizationId: option("organization",config().organizationId), projectId: option("project",config().projectId), environmentId: option("environment",config().environmentId) });
    return process.stdout.write("Goodbase project link updated.\n");
  }
  if (command === "start") return compose(["--env-file", path.join(stateDir,".env"), "up", "-d", "--wait"]);
  if (command === "stop") return compose(["--env-file", path.join(stateDir,".env"), "stop"]);
  if (command === "status") return compose(["--env-file", path.join(stateDir,".env"), "ps"]);
  if (command === "reset") { if (!has("yes")) fail("Reset deletes local volumes; repeat with --yes."); compose(["--env-file",path.join(stateDir,".env"),"down","--volumes"]); return compose(["--env-file",path.join(stateDir,".env"),"up","-d","--wait"]); }
  if (command === "migration" && subcommand === "new") {
    const name = String(args[2]||"migration").toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"");
    const file=path.join(cwd,"migrations",`${new Date().toISOString().replace(/\D/g,"").slice(0,14)}_${name}.sql`);ensureDirectory(path.dirname(file));fs.writeFileSync(file,"BEGIN;\n\n-- Write forward-only migration SQL here.\n\nCOMMIT;\n");return process.stdout.write(`${file}\n`);
  }
  if (command === "db" && subcommand === "push") return pushMigrations();
  if (command === "db" && subcommand === "dump") return run("pg_dump", [databaseUrl(), "--format=custom", `--file=${option("file","goodbase.dump")}`]);
  if (command === "db" && subcommand === "pull") return run("pg_dump", [databaseUrl(), "--schema-only", "--no-owner", `--file=${option("file","goodbase.schema.sql")}`]);
  if (command === "db" && subcommand === "diff") return run("pg_dump", [databaseUrl(), "--schema-only", "--no-owner", "--file=-"]);
  if (command === "db" && subcommand === "reset") { if(!has("yes"))fail("Database reset requires --yes."); return run("psql",[databaseUrl(),"-v","ON_ERROR_STOP=1","-c","DROP SCHEMA public CASCADE; CREATE SCHEMA public;"]); }
  if (command === "seed") return run("psql", [databaseUrl(), "-v", "ON_ERROR_STOP=1", "-f", option("file",path.join(cwd,"seed.sql"))]);
  if (command === "types" && subcommand === "generate") return generateTypes();
  if (command === "functions" && subcommand === "new") { const name=String(args[2]||"").replace(/[^a-zA-Z0-9_-]/g,"");if(!name)fail("Function name is required.");const dir=path.join(cwd,"functions",name);ensureDirectory(dir);fs.writeFileSync(path.join(dir,"index.ts"),'const input = JSON.parse(await new Response(Deno.stdin.readable).text());\nconsole.log(JSON.stringify({ success: true, input }));\n');return process.stdout.write(`${dir}\n`); }
  if (command === "functions" && subcommand === "serve") return run("deno",["run","--watch","--no-prompt",path.join(cwd,"functions",String(args[2]||""),"index.ts")]);
  if (command === "functions" && subcommand === "deploy") return api(`/api/goodbase/v1/platform/edge/functions/${encodeURIComponent(args[2]||"")}/versions`,{method:"POST",body:{source:fs.readFileSync(path.join(cwd,"functions",String(args[2]||""),"index.ts"),"utf8")}});
  if (command === "secrets" && subcommand === "set") { const pairs=args.slice(2).filter(v=>/^[A-Z][A-Z0-9_]*=/.test(v));if(!pairs.length)fail("Provide KEY=value pairs.");const file=path.join(stateDir,"secrets.json");const values=readJson(file,{});for(const pair of pairs){const at=pair.indexOf("=");values[pair.slice(0,at)]=pair.slice(at+1);}writeJson(file,values);return process.stdout.write(`Stored ${pairs.length} local secret(s).\n`); }
  if (command === "secrets" && subcommand === "list") return process.stdout.write(`${Object.keys(readJson(path.join(stateDir,"secrets.json"),{})).sort().join("\n")}\n`);
  if (command === "logs") {
    const parameters = new URLSearchParams();
    for (const key of ["query","service","severity","hours","limit","requestId","traceId"]) {
      const value = option(key); if (value) parameters.set(key, value);
    }
    return api(`/api/goodbase/v1/enterprise/logs${parameters.size ? `?${parameters}` : ""}`);
  }
  if (command === "deploy") return api("/api/releases",{method:"POST",body:{sourceRevision:option("revision"),environmentId:config().environmentId}});
  if (command === "projects" && subcommand === "list") return api("/api/goodbase/v1/platform/overview");
  if (command === "branches" && subcommand === "create") return api("/api/goodbase/v1/developer/previews",{method:"POST",body:{name:args[2],slug:option("slug",args[2]),sourceRevision:option("revision","working-tree"),pullRequestRef:option("pr")}});
  if (command === "backups" && subcommand === "list") return api("/api/goodbase/v1/platform/recovery");
  if (command === "domains" && subcommand === "list") return api("/api/goodbase/v1/enterprise/domains");
  if (command === "domains" && subcommand === "add") return api("/api/goodbase/v1/enterprise/domains",{method:"POST",body:{hostname:args[2],type:option("type","api"),targetHostname:option("target","base.goodos.app")}});
  if (command === "domains" && subcommand === "verify") return api(`/api/goodbase/v1/enterprise/domains/${encodeURIComponent(args[2]||"")}/verify`,{method:"POST",body:{}});
  if (command === "vectors" && subcommand === "collections") return api("/api/goodbase/v1/enterprise/search/collections");
  if (command === "vectors" && subcommand === "create") return api("/api/goodbase/v1/enterprise/search/collections",{method:"POST",body:{name:args[2],dimensions:Number(option("dimensions",1536)),distanceMetric:option("metric","cosine"),indexType:option("index","hnsw"),provider:option("provider"),model:option("model"),providerSecretRef:option("secret-ref")}});
  if (command === "vectors" && subcommand === "search") return api(`/api/goodbase/v1/enterprise/search/collections/${encodeURIComponent(args[2]||"")}/query`,{method:"POST",body:{mode:option("mode","keyword"),query:option("query","")}});
  if (command === "management" && subcommand === "operations") return api("/api/goodbase/v1/enterprise/management");
  if (command === "management" && subcommand === "run") return api("/api/goodbase/v1/enterprise/management/operations",{method:"POST",body:{type:args[2],idempotencyKey:option("idempotency-key",crypto.randomUUID()),parameters:readJson(option("parameters",""),{})}});
  if (command === "infrastructure" && subcommand === "status") return api("/api/goodbase/v1/enterprise/infrastructure");
  if (command === "production" && subcommand === "status") return api("/api/goodbase/v1/production/overview");
  if (command === "production" && subcommand === "verify") return api("/api/goodbase/v1/production/verification/runs",{method:"POST",body:{}});
  if (command === "recovery" && subcommand === "status") return api("/api/goodbase/v1/production/recovery");
  if (command === "recovery" && subcommand === "backup") return api("/api/goodbase/v1/production/recovery/backups",{method:"POST",body:{type:option("type","full")}});
  if (command === "recovery" && subcommand === "restore") return api("/api/goodbase/v1/production/recovery/restores",{method:"POST",body:{backupId:args[2],targetType:option("target","isolated_verification"),targetRef:option("target-ref"),pointInTime:option("point-in-time")}});
  if (command === "sdk" && subcommand === "list") return api("/api/goodbase/v1/production/sdks");
  if (command === "sync" && subcommand === "collections") return api("/api/goodbase/v1/production/sync/collections");
  if (command === "sync" && subcommand === "create") return api("/api/goodbase/v1/production/sync/collections",{method:"POST",body:{name:args[2],conflictPolicy:option("conflict-policy","reject"),retentionDays:Number(option("retention-days",30))}});
  if (command === "controllers" && subcommand === "list") return api("/api/goodbase/v1/production/controllers");
  if (command === "controllers" && subcommand === "probe") return api(`/api/goodbase/v1/production/controllers/${encodeURIComponent(args[2]||"")}/probe`,{method:"POST",body:{}});
  if (command === "assurance" && subcommand === "status") return api("/api/goodbase/v1/growth/assurance/overview");
  if (command === "assurance" && subcommand === "run") return api("/api/goodbase/v1/growth/assurance/runs",{method:"POST",body:{suiteId:option("suite","assurance_daily_security")}});
  if (command === "imports" && subcommand === "analyze") return api("/api/goodbase/v1/growth/imports/analyze",{method:"POST",body:{sourceType:option("source"),manifest:readJson(option("file",""),{})}});
  if (command === "imports" && subcommand === "apply") return api(`/api/goodbase/v1/growth/imports/${encodeURIComponent(args[2]||"")}/apply`,{method:"POST",body:{rollbackRef:option("rollback-ref")}});
  if (command === "auth-providers" && subcommand === "list") return api("/api/goodbase/v1/growth/auth/provider-configs");
  if (command === "attestation" && subcommand === "policies") return api("/api/goodbase/v1/growth/attestation/policies");
  if (command === "messaging" && subcommand === "providers") return api("/api/goodbase/v1/growth/messaging/providers");
  if (command === "product" && subcommand === "overview") return api("/api/goodbase/v1/product/overview");
  if (command === "analytics" && subcommand === "metrics") return api(`/api/goodbase/v1/product/analytics/metrics?days=${encodeURIComponent(option("days",30))}`);
  if (command === "telemetry" && subcommand === "issues") return api("/api/goodbase/v1/product/telemetry/issues");
  if (command === "config" && subcommand === "publish") return api(`/api/goodbase/v1/product/config/versions/${encodeURIComponent(args[2]||"")}/publish`,{method:"POST",body:{}});
  if (command === "experiments" && ["start","pause","stop"].includes(subcommand)) return api(`/api/goodbase/v1/product/experiments/${encodeURIComponent(args[2]||"")}/status`,{method:"POST",body:{status:subcommand==="start"?"running":subcommand==="pause"?"paused":"completed"}});
  if (command === "distribution" && subcommand === "provider-verify") return api(`/api/goodbase/v1/product/distribution/providers/${encodeURIComponent(args[2]||"")}/verify`,{method:"POST",body:{}});
  if (command === "cdn" && subcommand === "provider-verify") return api(`/api/goodbase/v1/product/cdn/providers/${encodeURIComponent(args[2]||"")}/verify`,{method:"POST",body:{}});
  if (command === "regions" && subcommand === "exercise") return api("/api/goodbase/v1/product/regions/exercises",{method:"POST",body:{exerciseType:option("type"),primaryRegionId:option("primary"),secondaryRegionId:option("secondary")}});
  if (command === "commerce" && subcommand === "spend-limit") return api("/api/goodbase/v1/product/commerce/spend-limit",{method:"PUT",body:{monthlyLimit:Number(option("monthly-limit")),warningPercent:Number(option("warning-percent",80)),hardStop:has("hard-stop")}});
  if (command === "public-status") return api("/api/goodbase/v1/product/status");
  fail(`Unknown command: ${args.join(" ")}`);
}

main().catch((error) => fail(error.message || String(error)));
