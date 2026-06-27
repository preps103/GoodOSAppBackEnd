const express = require("express");
const path = require("path");
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


function developerPublicFile(relativePath) {
  return path.join(__dirname, "..", "public", relativePath);
}

router.get("/docs", (req, res) => {
  res.type("html").sendFile(developerPublicFile("developer/docs.html"));
});

router.get("/api-docs", (req, res) => {
  res.type("html").sendFile(developerPublicFile("developer/api-docs.html"));
});

router.get("/openapi.json", (req, res) => {
  res.type("json").sendFile(developerPublicFile("developer/openapi.json"));
});

router.get("/sdk/goodos.js", (req, res) => {
  res.type("application/javascript").sendFile(developerPublicFile("sdk/goodos.js"));
});

router.get("/sdk/goodos.d.ts", (req, res) => {
  res.type("text/plain").sendFile(developerPublicFile("sdk/goodos.d.ts"));
});

router.get("/postman/goodos-postman-collection.json", (req, res) => {
  res.type("json").sendFile(developerPublicFile("postman/goodos-postman-collection.json"));
});

router.get("/favicon.ico", (req, res) => res.status(204).end());

router.use("/", consoleRoutes);



// GoodOS public homepage and console routes - safe route fix 26B
router.get("/", (req, res) => {
  res.sendFile(require("path").join(__dirname, "../public/landing.html"));
});

router.get("/console", (req, res) => {
  res.sendFile(require("path").join(__dirname, "../public/console.html"));
});

router.get("/console.html", (req, res) => {
  res.redirect("/console");
});

module.exports = router;
