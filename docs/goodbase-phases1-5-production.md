# Goodbase Phases 1–5 production platform

The canonical service is **Goodbase** at `https://base.goodos.app`. The former
backend hostname is retired after cutover validation and is not part of the
final Nginx configuration.

## Delivered platform

1. **Automatic REST** — PostgREST 14.12, opt-in `goodos_api` views,
   `security_invoker`, bounded gateway requests, schema-cache reloads, OpenAPI,
   request audit records, and readiness checks.
2. **Automatic GraphQL** — `pg_graphql` 1.6.1 behind the Goodbase session
   boundary, with depth, complexity, alias, payload, timeout, introspection, and
   operation-ledger controls.
3. **JWT and RLS** — short-lived session-bound JWTs carry validated
   organization, project, and environment scope. PostgreSQL revalidates the
   claims against current memberships. RLS is forced on published source
   tables, and owner/admin actions never receive a bypass-RLS credential.
4. **Connection platform** — PgBouncer 1.25.2 provides TLS-only transaction and
   session endpoints. Per-project budgets are stored in
   `backend_connection_budgets`; the management API exposes health and bounded
   updates. Transaction mode supports protocol-level prepared statements.
5. **CDC Realtime** — Supabase Realtime 2.112.9 receives PostgreSQL logical
   changes from opt-in publications. Goodbase tracks publication scope, quotas,
   replication slots, lag, and retained WAL. Private clients authenticate with
   short-lived JWTs and must reconnect and resubscribe after disconnects.

## Management endpoints

All endpoints below require an active Goodbase owner or administrator session.

- `GET /api/data-platform/security/rls/audit`
- `POST /api/data-platform/security/rls/policies`
- `GET /api/data-platform/connections`
- `PUT /api/data-platform/connections/budgets/:id`
- `GET /api/data-platform/realtime`
- `POST /api/data-platform/realtime/publications`
- `POST /api/data-platform/token/service`

The RLS policy endpoint accepts only managed templates: `tenant`,
`tenant_admin`, `public_read`, and `service`. It does not accept arbitrary SQL.
Realtime publication identifiers and operations are similarly allow-listed.

## Client endpoints

- REST: `https://base.goodos.app/rest/v1`
- GraphQL: `https://base.goodos.app/graphql/v1`
- Realtime WebSocket: `wss://base.goodos.app/realtime/v1/websocket`
- Transaction pool: `base.goodos.app:6543`
- Session pool: `base.goodos.app:5433`

Direct database credentials are generated during provisioning, stored in
`/etc/goodos/data-platform.env` with mode `0600`, and never returned by the
management API. Database clients must use TLS verification and the downloaded
CA chain.

## Production activation

Run `scripts/provision-data-platform.sh` as root. Before changing
`wal_level`, the script creates a PostgreSQL custom-format backup under
`/var/backups/goodbase`. It then activates logical replication, applies all
Phase 1–5 migrations, rotates service credentials, starts the pinned containers,
and validates every local port plus backend readiness.

Logical replication is not a durable queue. Client code must tolerate duplicate
or missed events, reconnect with a fresh JWT, and re-establish subscriptions.
Use Goodbase durable jobs for workflows that require guaranteed processing.
