(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GoodOS = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  class GoodOSError extends Error {
    constructor(message, response, payload) {
      super(message);
      this.name = "GoodOSError";
      this.response = response;
      this.status = response ? response.status : 0;
      this.payload = payload || null;
    }
  }

  class GoodOSClient {
    constructor(options = {}) {
      this.apiKey = options.apiKey || "";
      this.baseUrl = String(options.baseUrl || "https://backend.goodos.app/api/v1").replace(/\/+$/, "");
      this.defaultHeaders = options.headers || {};
    }

    setApiKey(apiKey) {
      this.apiKey = apiKey || "";
      return this;
    }

    headers(extra = {}) {
      const headers = {
        Accept: "application/json",
        ...this.defaultHeaders,
        ...extra,
      };

      if (this.apiKey) headers["X-GoodOS-API-Key"] = this.apiKey;
      return headers;
    }

    async request(path, options = {}) {
      const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
      const method = options.method || "GET";
      const body = options.body;

      const response = await fetch(url, {
        method,
        headers: this.headers({
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(options.headers || {}),
        }),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      const payload = await response.json().catch(() => null);

      if (!response.ok || (payload && payload.success === false)) {
        const message = payload && payload.message ? payload.message : `GoodOS request failed with status ${response.status}`;
        throw new GoodOSError(message, response, payload);
      }

      return payload;
    }

    health() {
      return this.request("/health");
    }

    apps() {
      return this.request("/apps");
    }

    storageBuckets() {
      return this.request("/storage/buckets");
    }

    storageFiles(params = {}) {
      const search = new URLSearchParams();
      if (params.bucket) search.set("bucket", params.bucket);
      const query = search.toString();
      return this.request(`/storage/files${query ? `?${query}` : ""}`);
    }

    callFunction(slug, input = {}, options = {}) {
      const method = String(options.method || "POST").toUpperCase();

      if (method === "GET") {
        const search = new URLSearchParams(input || {});
        const query = search.toString();
        return this.request(`/functions/${encodeURIComponent(slug)}${query ? `?${query}` : ""}`);
      }

      return this.request(`/functions/${encodeURIComponent(slug)}`, {
        method: "POST",
        body: input || {},
      });
    }
  }

  return {
    GoodOSClient,
    GoodOSError,
    createClient(options) {
      return new GoodOSClient(options);
    },
  };
});
