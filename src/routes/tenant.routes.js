"use strict";

const express =
  require("express");

const authRequired =
  require(
    "../middleware/authRequired"
  );

const tenantContext =
  require(
    "../middleware/tenantContext"
  );

const router =
  express.Router();

router.get(
  "/tenant-context",
  authRequired,
  tenantContext,
  (request, response) => {
    response.json({
      success: true,
      context:
        request.tenantContext,
    });
  }
);

router.get(
  "/organizations",
  authRequired,
  tenantContext,
  (request, response) => {
    response.json({
      success: true,
      organizations:
        request.tenantContext
          .organizations,
    });
  }
);

router.get(
  "/projects",
  authRequired,
  tenantContext,
  (request, response) => {
    response.json({
      success: true,

      organizationId:
        request.tenantContext
          .organizationId,

      projects:
        request.tenantContext
          .projects,
    });
  }
);

router.get(
  "/environments",
  authRequired,
  tenantContext,
  (request, response) => {
    response.json({
      success: true,

      organizationId:
        request.tenantContext
          .organizationId,

      projectId:
        request.tenantContext
          .projectId,

      environments:
        request.tenantContext
          .environments,
    });
  }
);

module.exports = router;
