const express = require("express");

const authRequired =
  require("../middleware/authRequired");

const {
  success,
  error,
} = require("../utils/response");

const billingService =
  require("../services/billing.service");

// GOODOS_BILLING_LIVE_ROUTES_V1

const router = express.Router();

router.use(authRequired);

function requestError(
  res,
  action,
  err
) {
  console.error(
    `Billing ${action} failed:`,
    err
  );

  return error(
    res,
    err.message ||
      `Billing ${action} failed.`,
    err.statusCode || 500
  );
}

router.get(
  "/health",
  async (req, res) => {
    try {
      const overview =
        await billingService
          .getBillingOverviewForUser(
            req.user.id
          );

      return success(res, {
        status: "ok",
        service:
          "GoodOS Billing",
        provider:
          overview.provider,
      });
    } catch (err) {
      return requestError(
        res,
        "health check",
        err
      );
    }
  }
);

router.get(
  "/overview",
  async (req, res) => {
    try {
      const overview =
        await billingService
          .getBillingOverviewForUser(
            req.user.id
          );

      return success(
        res,
        overview
      );
    } catch (err) {
      return requestError(
        res,
        "overview",
        err
      );
    }
  }
);

router.patch(
  "/customer",
  async (req, res) => {
    try {
      const customer =
        await billingService
          .updateBillingEmailForUser(
            req.user.id,
            req.body?.billingEmail,
            {
              ipAddress: req.ip,
            }
          );

      return success(res, {
        message:
          "Billing email updated successfully.",
        customer,
      });
    } catch (err) {
      return requestError(
        res,
        "customer update",
        err
      );
    }
  }
);

module.exports = router;
