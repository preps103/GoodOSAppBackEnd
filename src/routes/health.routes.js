const express = require("express");
const env = require("../config/env");
const { success } = require("../utils/response");

const router = express.Router();

router.get("/", (req, res) => {
  return success(res, {
    service: env.serviceName,
    status: "ok",
    environment: env.nodeEnv,
    version: env.version
  });
});

module.exports = router;
