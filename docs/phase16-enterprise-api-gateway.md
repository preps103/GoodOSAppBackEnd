# GoodOS Phase 16 — Enterprise API Gateway V2

## Public base URL

`https://backend.goodos.app/api/v2`

Authentication accepts either:

- `X-GoodOS-API-Key: <secret>`
- `Authorization: Bearer <secret>`

## Public endpoints

- `GET /health`
- `GET /whoami`
- `GET /apps`
- `GET /usage`
- `POST /echo`

## Management endpoint

`https://backend.goodos.app/api/api-gateway-v2`

Management requires an authenticated GoodOS owner or administrator with the existing privileged-MFA policy.

## Controls

- Service-account identity
- Per-key request rate
- Daily quotas
- Maximum body size
- IPv4 exact-address and CIDR allow/deny rules
- Mandatory idempotency for mutating requests
- Completed-response replay
- Payload mismatch protection
- Per-request IDs
- Request and response ledger
- API-key and service-account attribution
- Existing GoodOS API-key scope enforcement

## Idempotency

Mutating requests use:

`Idempotency-Key: <unique-client-generated-value>`

A completed identical request is replayed with:

`X-GoodOS-Idempotent-Replay: true`

Reuse with a different payload returns HTTP 409.

## Compatibility

The existing `/api/v1` public API remains available and unchanged.
