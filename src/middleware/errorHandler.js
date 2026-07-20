const { error } = require("../utils/response");

function statusCodeFor(err) {
  const candidate = Number(err?.statusCode || err?.status || 500);
  return candidate >= 400 && candidate <= 599 ? candidate : 500;
}

function publicMessageFor(err, statusCode) {
  if (statusCode >= 500) return "Internal server error";
  return String(err?.message || "Request failed");
}

function errorHandler(err, req, res, next) {
  const statusCode = statusCodeFor(err);
  const requestId = req.requestId || null;
  const traceId = req.traceId || null;

  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    event: "http.unhandled_error",
    statusCode,
    requestId,
    traceId,
    errorName: err?.name || "Error",
    message: err?.message || "Unhandled error",
    stack: process.env.NODE_ENV === "production" ? undefined : err?.stack,
  }));

  return error(
    res,
    publicMessageFor(err, statusCode),
    statusCode,
    { requestId, traceId }
  );
}

module.exports = errorHandler;
module.exports.publicMessageFor = publicMessageFor;
module.exports.statusCodeFor = statusCodeFor;
