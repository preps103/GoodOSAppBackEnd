const crypto = require("crypto");
const database = require("../config/database");

function dbQuery(sql, params = []) {
  if (typeof database.query === "function") return database.query(sql, params);
  if (database.pool && typeof database.pool.query === "function") return database.pool.query(sql, params);
  if (typeof database.getPool === "function") return database.getPool().query(sql, params);
  if (database.default && typeof database.default.query === "function") return database.default.query(sql, params);
  throw new Error("Database query function not found");
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function masterKey() {
  const raw = process.env.GOODOS_SECRET_KEY || process.env.JWT_SECRET || "goodos-local-dev-secret-key";
  return crypto.createHash("sha256").update(String(raw)).digest();
}

function encryptValue(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptValue(encryptedValue) {
  const raw = Buffer.from(String(encryptedValue), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey(), iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function prefixValue(value) {
  const clean = String(value || "");
  if (!clean) return "";
  if (clean.length <= 8) return clean.slice(0, 2) + "***";
  return clean.slice(0, 6) + "***" + clean.slice(-2);
}

function normalizeKey(key) {
  return String(key || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
}

async function listSecrets() {
  const vaults = await dbQuery(`
    SELECT id, name, provider, status, description, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM backend_secret_vaults
    ORDER BY name ASC
  `);

  const secrets = await dbQuery(`
    SELECT
      id,
      vault_id AS "vaultId",
      secret_key AS "secretKey",
      display_name AS "displayName",
      category,
      provider,
      secret_ref AS "secretRef",
      current_version_id AS "currentVersionId",
      value_prefix AS "valuePrefix",
      status,
      description,
      rotated_at AS "rotatedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM backend_secrets
    ORDER BY category ASC, secret_key ASC
  `);

  const providers = await dbQuery(`
    SELECT
      id,
      provider_key AS "providerKey",
      provider_name AS "providerName",
      provider_type AS "providerType",
      status,
      secret_refs_json AS "secretRefs",
      config_json AS "config",
      last_verified_at AS "lastVerifiedAt",
      verification_status AS "verificationStatus",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM backend_provider_credentials
    ORDER BY provider_type ASC, provider_key ASC
  `);

  return {
    vaults: vaults.rows,
    secrets: secrets.rows,
    providers: providers.rows,
    counts: {
      vaults: vaults.rows.length,
      secrets: secrets.rows.length,
      providers: providers.rows.length,
      activeSecrets: secrets.rows.filter((item) => item.status === "active").length,
    },
  };
}

async function createOrRotateSecret(input = {}) {
  const secretKey = normalizeKey(input.secretKey || input.key);
  const rawValue = String(input.secretValue || input.value || "");

  if (!secretKey) {
    const error = new Error("Secret key is required.");
    error.statusCode = 400;
    throw error;
  }

  if (!rawValue) {
    const error = new Error("Secret value is required.");
    error.statusCode = 400;
    throw error;
  }

  const vaultId = input.vaultId || "vault_goodos_local";
  const category = String(input.category || "general").trim().toLowerCase();
  const displayName = String(input.displayName || secretKey).trim();
  const secretRef = `secret://${secretKey}`;
  const encryptedValue = encryptValue(rawValue);
  const valueHash = hashValue(rawValue);
  const valuePrefix = prefixValue(rawValue);

  const existing = await dbQuery(
    `SELECT * FROM backend_secrets WHERE secret_key = $1 AND environment_id = 'env_goodos_production' LIMIT 1`,
    [secretKey]
  );

  let secretId = existing.rows[0]?.id || randomId("secret");
  let versionNumber = 1;

  if (existing.rows[0]) {
    const versionResult = await dbQuery(
      `SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version FROM backend_secret_versions WHERE secret_id = $1`,
      [secretId]
    );
    versionNumber = Number(versionResult.rows[0]?.next_version || 1);
  }

  const versionId = randomId("secretver");

  await dbQuery(
    `
      INSERT INTO backend_secret_versions (
        id,
        secret_id,
        version_number,
        encrypted_value,
        value_hash,
        value_prefix,
        encryption_method,
        status,
        created_by,
        metadata_json
      )
      VALUES ($1,$2,$3,$4,$5,$6,'aes-256-gcm','active',(SELECT id FROM users ORDER BY created_at ASC LIMIT 1),$7::jsonb)
    `,
    [
      versionId,
      secretId,
      versionNumber,
      encryptedValue,
      valueHash,
      valuePrefix,
      JSON.stringify({ phase: "25A", rotated: Boolean(existing.rows[0]) }),
    ]
  );

  if (existing.rows[0]) {
    await dbQuery(
      `
        UPDATE backend_secret_versions
        SET status = 'rotated'
        WHERE secret_id = $1
          AND id <> $2
          AND status = 'active'
      `,
      [secretId, versionId]
    );

    await dbQuery(
      `
        UPDATE backend_secrets
        SET display_name = $2,
            category = $3,
            current_version_id = $4,
            value_prefix = $5,
            value_hash = $6,
            status = 'active',
            description = $7,
            rotated_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
      [
        secretId,
        displayName,
        category,
        versionId,
        valuePrefix,
        valueHash,
        input.description || null,
      ]
    );
  } else {
    await dbQuery(
      `
        INSERT INTO backend_secrets (
          id,
          vault_id,
          secret_key,
          display_name,
          category,
          provider,
          secret_ref,
          current_version_id,
          value_prefix,
          value_hash,
          status,
          description,
          metadata_json,
          organization_id,
          project_id,
          environment_id,
          created_by
        )
        VALUES ($1,$2,$3,$4,$5,'local_encrypted',$6,$7,$8,$9,'active',$10,$11::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at ASC LIMIT 1))
      `,
      [
        secretId,
        vaultId,
        secretKey,
        displayName,
        category,
        secretRef,
        versionId,
        valuePrefix,
        valueHash,
        input.description || null,
        JSON.stringify({ phase: "25A" }),
      ]
    );
  }

  await dbQuery(
    `
      INSERT INTO backend_secret_access_logs (
        id,
        secret_id,
        secret_ref,
        action,
        actor_type,
        actor_id,
        status,
        metadata_json,
        organization_id,
        project_id,
        environment_id
      )
      VALUES ($1,$2,$3,$4,'system',$5,'success',$6::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production')
    `,
    [
      randomId("secretlog"),
      secretId,
      secretRef,
      existing.rows[0] ? "secret.rotate" : "secret.create",
      input.actorId || "phase25a",
      JSON.stringify({ phase: "25A" }),
    ]
  );

  return {
    id: secretId,
    secretKey,
    secretRef,
    versionId,
    versionNumber,
    valuePrefix,
    warning: "Raw secret value was encrypted and will not be returned.",
  };
}

async function getSecretValue(secretKeyOrRef) {
  const normalized = String(secretKeyOrRef || "").startsWith("secret://")
    ? String(secretKeyOrRef || "").replace("secret://", "")
    : normalizeKey(secretKeyOrRef);

  const result = await dbQuery(
    `
      SELECT s.id, s.secret_key, s.secret_ref, v.encrypted_value
      FROM backend_secrets s
      JOIN backend_secret_versions v ON v.id = s.current_version_id
      WHERE s.secret_key = $1
        AND s.status = 'active'
        AND v.status = 'active'
      LIMIT 1
    `,
    [normalized]
  );

  const row = result.rows[0];
  if (!row) return null;

  return decryptValue(row.encrypted_value);
}

module.exports = {
  listSecrets,
  createOrRotateSecret,
  getSecretValue,
  encryptValue,
  decryptValue,
  normalizeKey,
};
