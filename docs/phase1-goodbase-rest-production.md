# Goodbase Phase 1 — Automatic REST production readiness

## Scope

Phase 1 productionizes the existing PostgREST foundation without renaming the
legacy PostgreSQL roles or schemas. Internal `goodos_*` identifiers remain in
place for compatibility; the public product and hostname are Goodbase at
`https://base.goodos.app`.

## Included

- Goodbase public REST and health URLs
- JWT issuer and audience enforcement
- bounded URL, request-body, response-body, and upstream timeout controls
- readiness checks for PostgREST, API schema, roles, and control tables
- owner/admin publication inventory and publication controls
- explicit-column API views with `security_invoker`
- mandatory RLS before source tables can be published
- PostgREST schema-cache reload control
- request ledger without request bodies or query values
- Docker resource, process, and log-rotation limits
- repeatable provisioning and health verification
- Nginx primary-host and legacy-host migration template
- automated tests

## Public endpoints

- `GET /api/data-platform/health`
- `POST /api/data-platform/token`
- `/rest/v1/*`

## Owner/admin endpoints

- `GET /api/data-platform/readiness`
- `GET /api/data-platform/publications`
- `POST /api/data-platform/publications`
- `DELETE /api/data-platform/publications/:apiName`
- `POST /api/data-platform/schema-cache/reload`

## Publication contract

A source table is publishable only when:

1. its schema, table, API name, and columns pass strict identifier validation;
2. it is an ordinary or partitioned PostgreSQL table;
3. Row Level Security is enabled;
4. the operator explicitly lists every exposed column;
5. the requested operations are limited to SELECT, INSERT, UPDATE, and DELETE.

Goodbase creates a dedicated `goodos_api` view using `security_invoker` and
`security_barrier`. Anonymous access remains revoked.

## Deployment order

1. Run the repository tests.
2. Apply both data-plane migrations.
3. provision/reload the PostgREST service;
4. reload the backend with the Goodbase environment variables;
5. activate `base.goodos.app` in Nginx and issue its certificate;
6. verify local and public health;
7. keep `base.goodos.app` as a 308 compatibility alias during migration.

## Completion gate

Phase 1 is complete only after:

- PostgREST readiness passes;
- Goodbase backend health returns HTTP 200;
- the demo resource can be read with a valid session-bound data token;
- unauthenticated access fails;
- revoked-session access fails;
- a non-RLS source table cannot be published;
- request limits return the correct HTTP errors;
- request-ledger rows are created;
- the old hostname preserves methods through a 308 redirect;
- the full repository check suite passes.
