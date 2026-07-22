"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { SourceMapConsumer } = require("source-map");
const database = require("../config/database");

const storageRoot = path.resolve(
  process.env.GOODBASE_SYMBOL_STORAGE_ROOT || "/var/lib/goodapp-backend/symbols"
);

function safeUuid(value) {
  const text = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(text)
    ? text
    : null;
}

function safeStoragePath(releaseId, checksum) {
  const target = path.resolve(storageRoot, releaseId, `${checksum}.map`);
  if (!target.startsWith(`${storageRoot}${path.sep}`)) throw new Error("Symbol storage path is invalid.");
  return target;
}

async function saveSourceMap({ scope, releaseId, contents }) {
  const normalizedReleaseId = safeUuid(releaseId);
  if (!normalizedReleaseId) throw Object.assign(new Error("A valid client release is required."), { statusCode: 400 });
  if (!Buffer.isBuffer(contents) || contents.length < 2 || contents.length > 20 * 1024 * 1024) {
    throw Object.assign(new Error("The source map must be between 2 bytes and 20 MB."), { statusCode: 400 });
  }

  let parsed;
  try { parsed = JSON.parse(contents.toString("utf8")); }
  catch { throw Object.assign(new Error("The uploaded source map is not valid JSON."), { statusCode: 400 }); }
  if (Number(parsed.version) !== 3 || typeof parsed.mappings !== "string") {
    throw Object.assign(new Error("Only Source Map v3 files are supported."), { statusCode: 400 });
  }

  const release = await database.query(
    `SELECT id FROM goodbase_client_releases
     WHERE id=$1 AND organization_id=$2 AND project_id=$3 AND environment_id=$4`,
    [normalizedReleaseId, scope.organizationId, scope.projectId, scope.environmentId]
  );
  if (!release.rows[0]) throw Object.assign(new Error("Client release not found."), { statusCode: 404 });

  const canonical = Buffer.from(JSON.stringify(parsed));
  const checksum = crypto.createHash("sha256").update(canonical).digest("hex");
  const target = safeStoragePath(normalizedReleaseId, checksum);
  await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
  const staging = `${target}.${process.pid}.uploading`;
  await fs.promises.writeFile(staging, canonical, { mode: 0o640, flag: "wx" });
  await fs.promises.rename(staging, target);

  const stored = await database.query(
    `INSERT INTO goodbase_symbol_files(release_id,symbol_type,checksum_sha256,storage_ref,status)
     VALUES($1,'sourcemap',$2,$3,'ready')
     ON CONFLICT(release_id,symbol_type,checksum_sha256)
     DO UPDATE SET storage_ref=EXCLUDED.storage_ref,status='ready'
     RETURNING id,release_id,symbol_type,checksum_sha256,status,created_at`,
    [normalizedReleaseId, checksum, target]
  );
  return stored.rows[0];
}

async function findRelease({ scope, appId, releaseId, releaseName }) {
  const normalizedReleaseId = safeUuid(releaseId);
  const result = await database.query(
    `SELECT id FROM goodbase_client_releases
     WHERE organization_id=$1 AND project_id=$2 AND environment_id=$3 AND app_id=$4
       AND (($5::uuid IS NOT NULL AND id=$5::uuid)
         OR ($5::uuid IS NULL AND (version=$6 OR version || '+' || build_number=$6)))
     ORDER BY released_at DESC LIMIT 1`,
    [scope.organizationId, scope.projectId, scope.environmentId, appId, normalizedReleaseId, String(releaseName || "").slice(0, 100)]
  );
  return result.rows[0]?.id || null;
}

async function symbolicateStack({ releaseId, stack }) {
  if (!releaseId || !stack) return { stack, symbolicated: false };
  const found = await database.query(
    `SELECT storage_ref FROM goodbase_symbol_files
     WHERE release_id=$1 AND symbol_type='sourcemap' AND status='ready'
     ORDER BY created_at DESC LIMIT 1`,
    [releaseId]
  );
  const storageRef = found.rows[0]?.storage_ref;
  if (!storageRef || !path.resolve(storageRef).startsWith(`${storageRoot}${path.sep}`)) {
    return { stack, symbolicated: false };
  }

  try {
    const raw = JSON.parse(await fs.promises.readFile(storageRef, "utf8"));
    const lines = String(stack).split("\n");
    let replacements = 0;
    const mapped = await SourceMapConsumer.with(raw, null, consumer => lines.map(line => {
      const match = line.match(/^(.*?)([^\s()]+):(\d+):(\d+)(\)?)$/);
      if (!match) return line;
      const original = consumer.originalPositionFor({ line: Number(match[3]), column: Number(match[4]) });
      if (!original.source || original.line == null || original.column == null) return line;
      replacements += 1;
      const name = original.name ? `${original.name} ` : "";
      return `${match[1]}${name}(${original.source}:${original.line}:${original.column})`;
    }));
    return { stack: mapped.join("\n"), symbolicated: replacements > 0 };
  } catch {
    return { stack, symbolicated: false };
  }
}

module.exports = { saveSourceMap, findRelease, symbolicateStack };
