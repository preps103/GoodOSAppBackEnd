"""Official dependency-free Goodbase Python client foundation."""

import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


class GoodbaseError(Exception):
    def __init__(self, message, status=None, code=None, request_id=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.request_id = request_id


class GoodbaseClient:
    def __init__(self, url="https://base.goodos.app", access_token=None, timeout=30):
        self.url = url.rstrip("/")
        self.access_token = access_token
        self.timeout = timeout

    def request(self, path, method="GET", body=None, retries=2, headers=None):
        payload = None if body is None else json.dumps(body).encode("utf-8")
        request_id = str(uuid.uuid4())
        request_headers = {"Accept": "application/json", "X-Request-ID": request_id, **(headers or {})}
        if payload is not None:
            request_headers["Content-Type"] = "application/json"
        if self.access_token:
            request_headers["Authorization"] = "Bearer " + self.access_token
        for attempt in range(retries + 1):
            try:
                request = urllib.request.Request(self.url + path, data=payload, method=method, headers=request_headers)
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    return json.loads(response.read() or b"{}")
            except urllib.error.HTTPError as error:
                detail = json.loads(error.read() or b"{}")
                if error.code not in (429, 502, 503, 504) or attempt == retries:
                    raise GoodbaseError(detail.get("message", str(error)), error.code, detail.get("code"), error.headers.get("x-request-id")) from error
            except urllib.error.URLError as error:
                if attempt == retries:
                    raise GoodbaseError(str(error), request_id=request_id) from error
            time.sleep(min(2 ** attempt * 0.25, 4))

    def rest(self, table, query=""):
        return self.request("/rest/v1/" + urllib.parse.quote(table) + ("?" + query if query else ""))

    def graphql(self, query, variables=None):
        return self.request("/graphql/v1", "POST", {"query": query, "variables": variables or {}})

    def function(self, name, payload=None):
        return self.request("/api/v1/functions/" + urllib.parse.quote(name), "POST", payload or {})

    def sync_changes(self, collection_id, cursor=0, limit=500):
        return self.request(f"/api/goodbase/v1/production/sync/collections/{collection_id}/changes?cursor={cursor}&limit={limit}")

    def sync_mutations(self, collection_id, device_id, mutations):
        return self.request(f"/api/goodbase/v1/production/sync/collections/{collection_id}/mutations", "POST", {"deviceId": device_id, "mutations": mutations})
