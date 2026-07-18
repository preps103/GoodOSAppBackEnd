/* GOODOS_ENTERPRISE_FOUNDATION_V1 */

const crypto =
  require("crypto");

const {
  AsyncLocalStorage,
} = require("async_hooks");

const enterprise =
  require("../enterprise/enterprise-foundation.service");

const requestStorage =
  new AsyncLocalStorage();

const sensitiveKeys =
  /password|passphrase|token|secret|authorization|cookie|api[_-]?key|private[_-]?key|credential/i;

function cleanIdentifier(
  value,
  maximum
) {
  const text =
    String(
      value || ""
    ).trim();

  if (
    !text ||
    text.length > maximum ||
    !/^[a-zA-Z0-9._:-]+$/.test(
      text
    )
  ) {
    return null;
  }

  return text;
}

function randomHex(
  bytes
) {
  return crypto
    .randomBytes(bytes)
    .toString("hex");
}

function traceFromHeader(
  value
) {
  const match =
    String(value || "")
      .trim()
      .match(
        /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/i
      );

  if (!match) {
    return null;
  }

  return {
    traceId:
      match[1].toLowerCase(),
    parentSpanId:
      match[2].toLowerCase(),
  };
}

function redact(
  value,
  depth = 0
) {
  if (depth > 5) {
    return "[TRUNCATED]";
  }

  if (
    value === null ||
    value === undefined
  ) {
    return value;
  }

  if (
    typeof value ===
    "string"
  ) {
    return value.length > 2000
      ? `${value.slice(
          0,
          2000
        )}...[TRUNCATED]`
      : value;
  }

  if (
    typeof value !==
    "object"
  ) {
    return value;
  }

  if (
    Array.isArray(value)
  ) {
    return value
      .slice(0, 50)
      .map(item =>
        redact(
          item,
          depth + 1
        )
      );
  }

  const output = {};

  for (
    const [
      key,
      item,
    ]
    of Object.entries(value)
  ) {
    output[key] =
      sensitiveKeys.test(key)
        ? "[REDACTED]"
        : redact(
            item,
            depth + 1
          );
  }

  return output;
}

function logJson(
  level,
  event,
  fields = {}
) {
  const context =
    requestStorage.getStore() ||
    {};

  const payload = {
    timestamp:
      new Date()
        .toISOString(),

    level,
    event,

    service:
      "goodapp-backend",

    requestId:
      fields.requestId ||
      context.requestId ||
      null,

    traceId:
      fields.traceId ||
      context.traceId ||
      null,

    spanId:
      fields.spanId ||
      context.spanId ||
      null,

    ...redact(fields),
  };

  const serialized =
    JSON.stringify(payload);

  if (
    level === "error" ||
    level === "critical"
  ) {
    console.error(
      serialized
    );
  } else if (
    level === "warning"
  ) {
    console.warn(
      serialized
    );
  } else {
    console.log(
      serialized
    );
  }
}

function routeName(
  req
) {
  if (
    req.route &&
    req.route.path
  ) {
    return (
      `${req.baseUrl || ""}` +
      `${req.route.path}`
    );
  }

  return (
    req.originalUrl ||
    req.path ||
    "/unknown"
  ).split("?")[0];
}

function requestContextMiddleware(
  req,
  res,
  next
) {
  const requestId =
    cleanIdentifier(
      req.get(
        "x-request-id"
      ),
      128
    ) ||
    crypto.randomUUID();

  const incomingTrace =
    traceFromHeader(
      req.get(
        "traceparent"
      )
    );

  const traceId =
    incomingTrace?.traceId ||
    randomHex(16);

  const spanId =
    randomHex(8);

  const context = {
    requestId,
    traceId,
    spanId,
    parentSpanId:
      incomingTrace?.parentSpanId ||
      null,
  };

  req.requestId =
    requestId;

  req.traceId =
    traceId;

  req.spanId =
    spanId;

  res.setHeader(
    "x-request-id",
    requestId
  );

  res.setHeader(
    "x-trace-id",
    traceId
  );

  res.setHeader(
    "traceparent",
    `00-${traceId}-${spanId}-01`
  );

  requestStorage.run(
    context,
    next
  );
}

function structuredAccessLogMiddleware(
  req,
  res,
  next
) {
  const started =
    process.hrtime.bigint();

  res.once(
    "finish",
    () => {
      const durationMs =
        Number(
          process.hrtime.bigint() -
          started
        ) / 1e6;

      const route =
        routeName(req);

      const fields = {
        method:
          req.method,

        route,

        statusCode:
          res.statusCode,

        durationMs:
          Number(
            durationMs.toFixed(3)
          ),

        userId:
          req.user?.id ||
          null,

        organizationId:
          req.user
            ?.organizationId ||
          null,

        userAgent:
          String(
            req.get(
              "user-agent"
            ) || ""
          ).slice(0, 300),
      };

      logJson(
        res.statusCode >= 500
          ? "error"
          : res.statusCode >= 400
          ? "warning"
          : "info",
        "http.request",
        fields
      );

      enterprise.observeRequest({
        method:
          req.method,
        route,
        statusCode:
          res.statusCode,
        durationMs,
      });

      if (
        res.statusCode >= 500 ||
        durationMs >= 2500
      ) {
        void enterprise
          .recordOperationalEvent({
            severity:
              res.statusCode >= 500
                ? "error"
                : "warning",

            eventType:
              res.statusCode >= 500
                ? "http.server_error"
                : "http.slow_request",

            requestId:
              req.requestId,

            traceId:
              req.traceId,

            message:
              `${req.method} ${route} completed with HTTP ${res.statusCode}.`,

            metadata: {
              durationMs:
                Number(
                  durationMs.toFixed(3)
                ),

              statusCode:
                res.statusCode,
            },
          });
      }
    }
  );

  next();
}

function enterpriseErrorHandler(
  error,
  req,
  res,
  next
) {
  if (res.headersSent) {
    return next(error);
  }

  const statusCode =
    Number(
      error.statusCode ||
      error.status ||
      500
    );

  const safeStatus =
    statusCode >= 400 &&
    statusCode <= 599
      ? statusCode
      : 500;

  const publicMessage =
    safeStatus >= 500
      ? "An internal server error occurred."
      : error.message ||
        "The request could not be completed.";

  logJson(
    "error",
    "http.unhandled_error",
    {
      requestId:
        req.requestId,

      traceId:
        req.traceId,

      method:
        req.method,

      route:
        routeName(req),

      statusCode:
        safeStatus,

      errorName:
        error.name,

      errorCode:
        error.code ||
        null,

      message:
        error.message,

      stack:
        error.stack,
    }
  );

  void enterprise
    .recordOperationalEvent({
      severity:
        safeStatus >= 500
          ? "error"
          : "warning",

      eventType:
        "http.unhandled_error",

      requestId:
        req.requestId,

      traceId:
        req.traceId,

      message:
        error.message,

      metadata: {
        statusCode:
          safeStatus,

        method:
          req.method,

        route:
          routeName(req),

        errorCode:
          error.code ||
          null,
      },
    });

  return res
    .status(safeStatus)
    .json({
      success: false,

      message:
        publicMessage,

      code:
        error.code ||
        (
          safeStatus >= 500
            ? "INTERNAL_SERVER_ERROR"
            : "REQUEST_FAILED"
        ),

      requestId:
        req.requestId,

      traceId:
        req.traceId,
    });
}

module.exports = {
  requestStorage,
  redact,
  logJson,
  requestContextMiddleware,
  structuredAccessLogMiddleware,
  enterpriseErrorHandler,
};
