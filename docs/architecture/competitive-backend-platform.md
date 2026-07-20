# GoodOS Competitive Backend Platform

## Decision

GoodOS will remain the product, identity, governance, billing, deployment, and operator control plane. Mature open-source data-plane runtimes will provide protocol-heavy capabilities where a custom implementation would be less secure, less compatible, or harder to operate.

The platform is opt-in and deny-by-default. Creating a table never makes it public. A table becomes client-accessible only after explicit schema publication, database grants, Row Level Security, and an audited GoodOS control-plane change.

## Target architecture

| Capability | Runtime | GoodOS responsibility |
| --- | --- | --- |
| Automatic REST | PostgREST 14.x | Project/schema publication, RLS policy tooling, tokens, gateway, quotas, audit, health |
| Automatic GraphQL | `pg_graphql` | Extension lifecycle, opt-in schema exposure, GraphQL gateway, limits, audit |
| Client authorization | PostgreSQL roles and RLS | GoodOS sessions, short-lived data tokens, membership lookup, policy templates |
| Database changes | Supabase Realtime on logical replication | Tenant provisioning, publications, quotas, authorization, lag monitoring |
| Durable queues | `pgmq` | Queue lifecycle, policies, worker orchestration, DLQ dashboards |
| Database pooling | PgBouncer initially, Supavisor when multi-project routing is required | Connection budgets, tenant routing, metrics |
| Object storage | S3-compatible object store plus TUS and imgproxy | Buckets, policies, signing, lifecycle, CDN, audit |
| Functions | Isolated Deno/WASM runtime | Build/deploy, secrets, per-function CPU/memory/time limits, logs |
| Observability | OpenTelemetry, Prometheus-compatible metrics, centralized logs | SLOs, alerting, release gates, cost and usage attribution |

## Security invariants

1. Browser and mobile clients never receive a database owner, service-role, or bypass-RLS credential.
2. Public schemas are not exposed wholesale. GoodOS publishes reviewed objects into a dedicated API schema.
3. Published views use PostgreSQL `security_invoker` so source-table RLS remains authoritative.
4. Authenticated data tokens are short-lived, session-bound, revocable, and identify the database role explicitly.
5. PostgREST runs under a dedicated authenticator role and may impersonate only the anonymous and authenticated roles.
6. Anonymous access has no object grants unless an operator explicitly creates them.
7. Every management action is audited; every runtime has health, latency, saturation, and error metrics.
8. New tables, functions, GraphQL objects, and Realtime publications default to disabled.
9. Production components are version-pinned and deployed with rollback metadata.

## Delivery sequence

### Release A — Data plane

- PostgreSQL API/auth schemas and least-privilege roles
- PostgREST automatic REST behind the GoodOS session gateway
- session-bound five-minute data tokens
- RLS policy and secure-view publication workflow
- OpenAPI discovery, health checks, logs, quotas, and integration tests

### Release B — GraphQL and change data capture

- `pg_graphql` 1.6.x installed and explicitly enabled
- GraphQL endpoint, depth/complexity controls, persisted-query support
- PostgreSQL `wal_level=logical` maintenance change
- Supabase Realtime with a dedicated metadata database and replication user
- per-project publications, lag monitoring, filters, quotas, and reconnect tests

### Release C — Data protection

- encrypted off-host scheduled backups
- automatic restore verification and evidence retention
- WAL archive with restore-to-timestamp drills
- streaming read replica and rehearsed failover
- published RPO/RTO SLOs and quarterly disaster-recovery exercise

### Release D — Developer platform

- `goodos` CLI for login, link, start, stop, reset, migrate, seed, types, deploy, logs, secrets, and status
- reproducible local Compose stack pinned to production-compatible versions
- schema-derived TypeScript, Swift, Kotlin, Dart, and Python models
- per-pull-request preview project with isolated database, auth, storage, functions, and URLs

### Release E — Runtime and storage

- Deno/WASM function workers isolated from the control plane
- CPU, memory, duration, concurrency, egress, and regional policies
- `pgmq` queues with leases, visibility timeouts, retries, DLQs, and idempotency keys
- TUS resumable uploads, multipart S3, imgproxy transformations, signed variants, CDN purge

### Release F — Client, mobile, growth, and quality

- complete auth providers, magic links, phone OTP, anonymous upgrade, device/app attestation
- offline-first SDK cache and deterministic conflict strategy
- Web Push, APNs, FCM, topics, receipts, and preferences
- Remote Config, experimentation, analytics, crash reporting, and client performance
- application distribution and external device-lab integrations
- extensions marketplace and managed vector/embedding workflows

## Shared GoodOS application shell

The supplied GoodOS header is the canonical top bar across applications. It will ship as a versioned shared package instead of duplicated HTML and CSS.

Required regions:

- GoodOS product mark and application/workspace switcher
- centered universal search with keyboard shortcut
- theme, notifications, and help controls
- authenticated avatar, display name, role, presence, and account menu
- responsive compact/mobile variants

The ADA assistant is part of the shell contract. Its position and behavior stay consistent with goodos.app, while design tokens allow each application to inherit its native accent, surface, border, shadow, focus, and hover treatment. Accessibility includes keyboard operation, visible focus, reduced-motion support, labels, contrast checks, and safe-area spacing.

## Definition of competitive readiness

A feature is not marked complete because a table, screen, or route exists. It requires production runtime behavior, authorization tests, observability, recovery procedures, documented limits, SDK support, operator controls, and a successful failure-mode exercise.
