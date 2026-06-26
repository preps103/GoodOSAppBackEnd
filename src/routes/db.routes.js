const express = require("express");
const { success, error } = require("../utils/response");
const { checkDatabaseHealth } = require("../config/database");

const router = express.Router();

router.get("/health", async (req, res) => {
  try {
    const db = await checkDatabaseHealth();

    return success(res, {
      service: "GoodAppBackEnd Database",
      status: "connected",
      database: db.database,
      user: db.user,
      timestamp: db.timestamp
    });
  } catch (err) {
    console.error("Database health check failed:", err);

    return error(
      res,
      "Database connection failed",
      500,
      process.env.NODE_ENV === "production" ? null : err.message
    );
  }
});

module.exports = router;
