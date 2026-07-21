"use strict";

function createGoodbaseServerClient(createClient, request, options) {
  options = options || {};
  const authorization = request.headers.get("authorization");
  const cookie = request.headers.get("cookie");
  return createClient({
    baseUrl: options.baseUrl || "https://base.goodos.app/api/v1",
    headers: {
      ...(authorization ? { Authorization:authorization } : {}),
      ...(cookie ? { Cookie:cookie } : {}),
      "X-Goodbase-SSR": "1"
    }
  });
}

module.exports = { createGoodbaseServerClient };
