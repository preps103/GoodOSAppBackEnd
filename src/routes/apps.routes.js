const express = require("express");
const { success, error } = require("../utils/response");
const { getAllApps, getAppById } = require("../services/apps.service");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const apps = await getAllApps();

    return success(res, {
      source: "database",
      count: apps.length,
      apps
    });
  } catch (err) {
    console.error("Failed to load apps:", err);

    return error(res, "Failed to load app registry", 500);
  }
});

router.get("/:id", async (req, res) => {
  try {
    const app = await getAppById(req.params.id);

    if (!app) {
      return error(res, "App not found", 404);
    }

    return success(res, {
      source: "database",
      app
    });
  } catch (err) {
    console.error("Failed to load app:", err);

    return error(res, "Failed to load app", 500);
  }
});

module.exports = router;
