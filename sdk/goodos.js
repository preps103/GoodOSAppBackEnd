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

    dbTables() {
      return this.request("/db/tables");
    }

    dbRows(tableSlug, params = {}) {
      const search = new URLSearchParams();
      if (params.limit) search.set("limit", params.limit);
      if (params.offset) search.set("offset", params.offset);
      if (params.search) search.set("search", params.search);
      const query = search.toString();
      return this.request(`/db/${encodeURIComponent(tableSlug)}/rows${query ? `?${query}` : ""}`);
    }

    dbRow(tableSlug, id) {
      return this.request(`/db/${encodeURIComponent(tableSlug)}/rows/${encodeURIComponent(id)}`);
    }

    createDbRow(tableSlug, row = {}) {
      return this.request(`/db/${encodeURIComponent(tableSlug)}/rows`, {
        method: "POST",
        body: row,
      });
    }

    updateDbRow(tableSlug, id, row = {}) {
      return this.request(`/db/${encodeURIComponent(tableSlug)}/rows/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: row,
      });
    }

    deleteDbRow(tableSlug, id) {
      return this.request(`/db/${encodeURIComponent(tableSlug)}/rows/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    }

    storageBuckets() {
      return this.request("/storage/buckets");
    }

    storagePublicUrl(bucketName, objectKey, rootUrl = "https://backend.goodos.app") {
      const bucket = encodeURIComponent(bucketName);
      const key = String(objectKey || "").split("/").map(encodeURIComponent).join("/");
      return `${String(rootUrl).replace(/\/+$/, "")}/storage/public/${bucket}/${key}`;
    }

    storageFiles(params = {}) {
      const search = new URLSearchParams();
      if (params.bucket) search.set("bucket", params.bucket);
      const query = search.toString();
      return this.request(`/storage/files${query ? `?${query}` : ""}`);
    }

    realtimeChannels() {
      return this.request("/realtime/channels");
    }

    realtimeEvents(params = {}) {
      const search = new URLSearchParams();
      if (params.channel) search.set("channel", params.channel);
      if (params.limit) search.set("limit", params.limit);
      if (params.offset) search.set("offset", params.offset);
      const query = search.toString();
      return this.request(`/realtime/events${query ? `?${query}` : ""}`);
    }

    publishRealtimeEvent(channel = "system", event = {}) {
      return this.request("/realtime/events", {
        method: "POST",
        body: {
          channel,
          eventType: event.eventType || event.event_type || "realtime.sdk.message",
          message: event.message || "",
          payload: event.payload || {},
        },
      });
    }

    realtimeStreamUrl(channel = "system", rootUrl = "https://backend.goodos.app") {
      return `${String(rootUrl).replace(/\/+$/, "")}/api/v1/realtime/stream?channel=${encodeURIComponent(channel)}`;
    }

    realtimeWebSocketUrl(channel = "system", options = {}) {
      const rootUrl = options.rootUrl || "wss://backend.goodos.app";
      const apiKey = options.apiKey || this.apiKey || "";
      const search = new URLSearchParams();
      search.set("channel", channel);
      if (apiKey) search.set("api_key", apiKey);
      return `${String(rootUrl).replace(/\/+$/, "")}/api/v1/realtime/ws?${search.toString()}`;
    }

    connectRealtimeWebSocket(channel = "system", options = {}) {
      if (typeof WebSocket === "undefined") {
        throw new Error("WebSocket is not available in this environment.");
      }
      return new WebSocket(this.realtimeWebSocketUrl(channel, options));
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
