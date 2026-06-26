const { error } = require("../utils/response");

function errorHandler(err, req, res, next) {
  console.error("Global Error:", err);

  return error(
    res,
    err.message || "Internal server error",
    err.statusCode || 500
  );
}

module.exports = errorHandler;
