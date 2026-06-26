const express = require("express");
const crypto = require("crypto");
const database = require("../config/database");

const router = express.Router();

function dbQuery(sql, params = []) {
  if (typeof database.query === "function") return database.query(sql, params);
  if (database.pool && typeof database.pool.query === "function") return database.pool.query(sql, params);
  if (typeof database.getPool === "function") return database.getPool().query(sql, params);
  if (database.default && typeof database.default.query === "function") return database.default.query(sql, params);
  throw new Error("Database query function not found");
}

function safeJson(value) {
  try {
    return JSON.stringify(value || {});
  } catch {
    return "{}";
  }
}

router.all("/", async (req, res) => {
  try {
    const id = `whrecv_${crypto.randomUUID().replace(/-/g, "")}`;

    await dbQuery(
      `
        INSERT INTO backend_webhook_test_receipts (
          id,
          method,
          path,
          headers,
          body,
          query,
          ip
        )
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)
      `,
      [
        id,
        req.method,
        req.originalUrl || req.path || "/webhook-test-receiver",
        safeJson(req.headers),
        safeJson(req.body),
        safeJson(req.query),
        req.ip || req.socket?.remoteAddress || null,
      ]
    );

    return res.status(200).json({
      success: true,
      message: "GoodAppBackEnd test receiver accepted webhook.",
      receiptId: id,
      receivedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Webhook test receiver failed:", error);
    return res.status(500).json({
      success: false,
      message: "Webhook test receiver failed.",
      detail: error.message,
    });
  }
});

module.exports = router;
