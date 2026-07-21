# Goodbase Phase 2 — Automatic GraphQL

Endpoints:

- `POST /graphql/v1`
- `GET /api/data-platform/graphql/health`

Security defaults:

- Session-bound authentication required
- Anonymous access denied
- PostgreSQL grants and Row Level Security enforced
- Revoked and expired sessions denied
- Required MFA enforced by the shared data-plane boundary
- Introspection disabled
- Query depth, complexity, alias, payload, variable, and timeout limits
- GraphQL query text and variables excluded from audit records
