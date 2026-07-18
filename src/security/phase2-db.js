"use strict";

const { Pool } = require("pg");

let database = null;

function unwrap(candidate) {
  if (
    candidate &&
    typeof candidate.query === "function"
  ) {
    return candidate;
  }

  if (
    candidate?.pool &&
    typeof candidate.pool.query === "function"
  ) {
    return candidate.pool;
  }

  if (
    candidate?.db &&
    typeof candidate.db.query === "function"
  ) {
    return candidate.db;
  }

  if (
    candidate?.default &&
    typeof candidate.default.query === "function"
  ) {
    return candidate.default;
  }

  return null;
}

function resolveDatabase() {
  if (database) {
    return database;
  }

  const candidates = [
    "../db",
    "../db/pool",
    "../config/database",
    "../config/db",
    "../database",
    "../database/pool",
    "../lib/db",
    "../utils/db"
  ];

  for (const path of candidates) {
    try {
      const resolved = unwrap(require(path));

      if (resolved) {
        database = resolved;
        return database;
      }
    } catch {
      // Continue to the next known project location.
    }
  }

  database = new Pool(
    process.env.DATABASE_URL
      ? {
          connectionString: process.env.DATABASE_URL,
          application_name:
            "goodos-phase2-security"
        }
      : {
          host:
            process.env.DB_HOST ||
            process.env.PGHOST ||
            "127.0.0.1",
          port: Number(
            process.env.DB_PORT ||
            process.env.PGPORT ||
            5432
          ),
          user:
            process.env.DB_USER ||
            process.env.PGUSER,
          password:
            process.env.DB_PASSWORD ||
            process.env.PGPASSWORD,
          database:
            process.env.DB_NAME ||
            process.env.PGDATABASE ||
            "goodos_backend",
          application_name:
            "goodos-phase2-security"
        }
  );

  return database;
}

async function query(text, values = []) {
  return resolveDatabase().query(text, values);
}

async function transaction(callback) {
  const target = resolveDatabase();

  if (typeof target.connect === "function") {
    const client = await target.connect();

    try {
      await client.query("BEGIN");

      const result = await callback(client);

      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  await target.query("BEGIN");

  try {
    const result = await callback(target);

    await target.query("COMMIT");
    return result;
  } catch (error) {
    await target.query("ROLLBACK");
    throw error;
  }
}

module.exports = {
  query,
  transaction
};
