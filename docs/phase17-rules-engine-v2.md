# GoodOS Phase 17 — Central Rules Engine V2

## Management base URL

`https://backend.goodos.app/api/policy-engine-v2`

## Management endpoints

- `GET /health`
- `GET /overview`
- `GET /rule-sets`
- `GET /rules`
- `POST /rules`
- `PATCH /rules/:ruleId`
- `POST /rules/:ruleId/publish`
- `POST /rules/:ruleId/disable`
- `POST /simulate`
- `GET /evaluations`
- `PUT /settings`

Management endpoints require an authenticated GoodOS owner or administrator.

## Supported conditions

- Required scopes
- Any matching scope
- Denied scopes
- API-key IDs
- Service-account IDs
- HTTP methods
- Request-path wildcards
- Source IPv4 addresses and CIDRs
- Required HTTP headers
- Context attributes

## Evaluation behavior

- Lower numerical priority executes first.
- Deny rules win priority ties.
- Rule sets support enforce and monitor modes.
- Rules support start and end dates.
- Rules support deterministic percentage rollouts.
- Rules are edited as drafts.
- Publishing creates an immutable revision snapshot and checksum.
- Enforced and simulated decisions are written to the evaluation ledger.
- API Gateway V2 requests are centrally evaluated after gateway authentication
  and before endpoint handlers.

## Safety state

- Existing Rules Engine V1 tables and routes remain available.
- Existing API Gateway V1 and V2 endpoints remain available.
- GoodID remains the default identity provider.
- Local break-glass login remains enabled.
- Privileged MFA remains required.
- Mandatory SSO remains disabled.
