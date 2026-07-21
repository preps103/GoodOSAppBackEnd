# Goodbase Phases 16–20

## Phase 16 — Observability and Logs Explorer

The enterprise API exposes a unified, bounded log stream across operational, API gateway, automatic REST, and GraphQL records. It supports request and trace correlation, service/severity/time filtering, bounded regular expressions, saved queries, external drains, retention policy, redaction policy, SLO state, and error-budget inputs.

## Phase 17 — Management API

The versioned enterprise API supports SHA-256-hashed personal management tokens, explicit scopes, immutable idempotency keys, auditable lifecycle operations, and automation integration records. Operations are dispatched only when the production infrastructure controller URL and token are configured. Destructive operations require MFA or an MFA-created token carrying the privileged scope.

## Phase 18 — Custom Domains

Domains use real DNS TXT ownership proof, certificate lifecycle state, activation state, immutable events, health checks, and MFA-gated activation. Certificate issuance and Nginx/CDN activation are delegated to the configured domain controller; Goodbase does not fabricate success when no controller is configured.

## Phase 19 — Vector and Search Platform

Collections support bounded dimensions, cosine/inner-product/Euclidean scoring, keyword search through a PostgreSQL GIN index, semantic search, hybrid ranking, metadata, external IDs, retryable embedding jobs, and dead-letter state. Provider credentials are referenced, never stored. External embedding generation runs only through the configured embedding gateway.

## Phase 20 — Regional Infrastructure

The control plane models regions, service nodes, resource limits, capacity policies, failover plans and events, service limits, and incidents. The reconciler detects stale nodes and safely dispatches failover work through the infrastructure controller. The initial production region remains `us-west`; recovery regions remain planned until infrastructure is actually provisioned.

## Production controller configuration

These integrations intentionally remain inactive until both variables in a pair are configured:

- `GOODBASE_INFRA_CONTROLLER_URL` and `GOODBASE_INFRA_CONTROLLER_TOKEN`
- `GOODBASE_DOMAIN_CONTROLLER_URL` and `GOODBASE_DOMAIN_CONTROLLER_TOKEN`
- `GOODBASE_EMBEDDING_GATEWAY_URL` and `GOODBASE_EMBEDDING_GATEWAY_TOKEN`

This prevents control-plane records from being reported as provisioned infrastructure when no external runtime has performed the work.
