# GoodOS Runtime Health Contract

GoodAppBackEnd exposes separate probes for process liveness and traffic readiness.

| Probe | Purpose | HTTP behavior |
| --- | --- | --- |
| `GET /health` | Backward-compatible process summary | `200` while the process can answer HTTP |
| `GET /health/live` | Liveness probe for process supervision | `200` while the process is alive |
| `GET /health/ready` | Readiness probe for load balancers and deployments | `200` only when the instance can serve traffic; otherwise `503` |
| `GET /api/health/*` | Compatibility aliases for the same probes | Same behavior as `/health/*` |

Readiness requires the runtime to be accepting traffic, PostgreSQL to accept a query, and the local automatic REST data plane to respond. Worker heartbeat health is reported as a non-critical dependency by default. Set `GOODOS_WORKER_REQUIRED=true` only for a deployment in which every request-serving instance must also have a current background worker.

On `SIGTERM` or `SIGINT`, the process enters draining state before closing the HTTP listener. Readiness then returns `503`, idle connections and WebSocket clients are closed, metrics are flushed, and the database pool is ended. The default drain deadline is eight seconds and may be configured with `GRACEFUL_SHUTDOWN_TIMEOUT_MS` without exceeding the process manager's kill timeout.

The HTTP listener also enforces finite request, header, keep-alive, header-count, and per-socket request limits. Unexpected `5xx` exceptions are correlated in server logs by request and trace identifiers, while API responses receive a generic error message so infrastructure details are not disclosed.
