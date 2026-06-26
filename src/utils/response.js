function success(res, data = {}, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    ...data
  });
}

function error(res, message = "Server error", statusCode = 500, details = null) {
  return res.status(statusCode).json({
    success: false,
    message,
    ...(details ? { details } : {})
  });
}

module.exports = {
  success,
  error
};
