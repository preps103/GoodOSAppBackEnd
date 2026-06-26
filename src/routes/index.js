const express = require("express");
const env = require("../config/env");
const { success } = require("../utils/response");

const healthRoutes = require("./health.routes");
const appsRoutes = require("./apps.routes");
const dbRoutes = require("./db.routes");
const authRoutes = require("./auth.routes");
const adminRoutes = require("./admin.routes");
const consoleRoutes = require("./console.routes");
const publicApiRoutes = require("./public-api.routes");
const storageRoutes = require("./storage.routes");
const webhookTestRoutes = require("./webhook-test.routes");

const router = express.Router();

router.get("/api", (req, res) => {
  return success(res, {
    message: "GoodAppBackEnd API is running",
    service: env.serviceName,
  });
});

router.use("/health", healthRoutes);
router.use("/api/apps", appsRoutes);
router.use("/api/db", dbRoutes);
router.use("/api/auth", authRoutes);
router.use("/api/admin", adminRoutes);
router.use("/api/v1", publicApiRoutes);
router.use("/storage", storageRoutes);
router.use("/webhook-test-receiver", webhookTestRoutes);

router.get("/favicon.ico", (req, res) => res.status(204).end());

router.use("/", consoleRoutes);

module.exports = router;
