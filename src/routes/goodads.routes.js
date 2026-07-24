"use strict";

const express = require("express");
const authRequired = require("../middleware/authRequired");
const tenantContext = require("../middleware/tenantContext");
const { success, error } = require("../utils/response");
const service = require("../services/goodads.service");

const router = express.Router();

function requireGoodAdsAccess(req, res, next) {
  const role = String(req.user?.platformRole || req.user?.role || "").toLowerCase();
  const entitled = (req.apps || []).some((app) => {
    const id = String(app.id || app.appId || app.slug || "").toLowerCase();
    const domain = String(app.domain || "").toLowerCase();
    const membership = String(app.membershipStatus || app.membership_status || "active").toLowerCase();
    const status = String(app.appStatus || app.status || "active").toLowerCase();
    return (id === "goodads" || id === "ads" || domain === "ads.goodos.app") && membership === "active" && status === "active";
  });
  if (!entitled && role !== "owner" && role !== "admin") {
    return error(res, "Active GoodAds access is required.", 403);
  }
  return next();
}

function handle(res, label, operation) {
  return Promise.resolve(operation)
    .then((data) => success(res, { data }))
    .catch((requestError) => {
      console.error(`GoodAds ${label} failed:`, requestError.message);
      return res.status(requestError.statusCode || 500).json({
        success: false,
        code: requestError.code || "GOODADS_REQUEST_FAILED",
        message: requestError.message || "The GoodAds request could not be completed.",
      });
    });
}

router.use(authRequired, tenantContext, requireGoodAdsAccess);

router.get("/dashboard", (req, res) => handle(res, "dashboard", service.dashboard(req.tenantContext)));
router.get("/workspace", (req, res) => handle(res, "workspace", service.workspace(req.tenantContext)));
router.get("/workspace/brand", (req, res) => handle(res, "brand", service.listResources({ type: "brand", context: req.tenantContext, limit: 1 })));
router.get("/connections/:platform/authorize", (req, res) => res.status(501).json({
  success: false,
  code: "GOODADS_PROVIDER_NOT_CONFIGURED",
  message: `${req.params.platform} OAuth credentials are not configured in GoodBase.`,
}));

function registerResource(path, type) {
  router.get(`/${path}`, (req, res) => handle(res, `${type}.list`, service.listResources({
    type,
    context: req.tenantContext,
    limit: req.query.limit,
    offset: req.query.offset,
    status: req.query.status,
  })));
  router.post(`/${path}`, (req, res) => handle(res, `${type}.create`, service.upsertResource({
    type,
    payload: req.body,
    context: req.tenantContext,
    userId: req.user.id,
  })));
  router.get(`/${path}/:id`, (req, res) => handle(res, `${type}.get`, service.getResource({
    type,
    id: req.params.id,
    context: req.tenantContext,
  })));
  router.put(`/${path}/:id`, (req, res) => handle(res, `${type}.update`, service.upsertResource({
    type,
    id: req.params.id,
    payload: req.body,
    context: req.tenantContext,
    userId: req.user.id,
  })));
  router.patch(`/${path}/:id`, (req, res) => handle(res, `${type}.patch`, service.upsertResource({
    type,
    id: req.params.id,
    payload: req.body,
    context: req.tenantContext,
    userId: req.user.id,
  })));
  router.delete(`/${path}/:id`, (req, res) => handle(res, `${type}.archive`, service.archiveResource({
    type,
    id: req.params.id,
    context: req.tenantContext,
    userId: req.user.id,
  })));
}

[
  ["campaigns", "campaigns"],
  ["content", "content"],
  ["approvals", "approvals"],
  ["calendar", "calendar"],
  ["connections", "connections"],
  ["publishing/jobs", "publishing_jobs"],
  ["analytics", "analytics"],
  ["media", "media"],
  ["link-hubs", "link_hubs"],
  ["automations", "automations"],
  ["notifications", "notifications"],
  ["email-campaigns", "email_campaigns"],
  ["designs", "designs"],
  ["flyers", "flyers"],
  ["business-cards", "business_cards"],
  ["qr-codes", "qr_codes"],
  ["videos", "videos"],
  ["audit-events", "audit_events"],
].forEach(([path, type]) => registerResource(path, type));

router.post("/campaigns/:id/launch", (req, res) => handle(res, "campaign.launch", service.transitionResource({
  type: "campaigns",
  id: req.params.id,
  nextStatus: "active",
  context: req.tenantContext,
  userId: req.user.id,
  eventType: "campaigns.launched",
})));

module.exports = router;
