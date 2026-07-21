# Goodbase Developer Handbook

Goodbase is the PostgreSQL backend platform at `https://base.goodos.app`. This handbook is the canonical starting point for application developers and operators. Never place service tokens in a browser or mobile application.

## Five-minute quickstart

1. Install the CLI with `npm install --global goodapp-backend` or run `npx goodbase` from this repository.
2. Run `goodbase init`, then `goodbase start` for the pinned local stack.
3. Link a project with a short-lived management token: `goodbase link --project <project-id>`.
4. Apply checked migrations with `goodbase db push`.
5. Generate types with `goodbase types generate` and initialize the client with the project URL and public key.

## Platform quickstarts

- **JavaScript/TypeScript:** use `/sdk/goodos.js`, persist user sessions in secure cookies, and use the generated database interfaces for typed REST and GraphQL operations.
- **React:** use `sdks/javascript/react.js`; keep the client in context and subscribe once per component lifecycle.
- **Next.js:** use `sdks/javascript/nextjs.js`; exchange sessions server-side and never serialize service credentials into client components.
- **Flutter/Dart:** use `sdks/dart/lib/goodbase.dart`; store refresh credentials in Keychain/Keystore-backed secure storage and enable the durable sync queue.
- **Swift:** use `sdks/swift/Sources/Goodbase/GoodbaseClient.swift`; integrate App Attest before registering an APNs device token.
- **Kotlin:** use `sdks/kotlin/src/main/kotlin/app/goodos/goodbase/GoodbaseClient.kt`; integrate Play Integrity before FCM registration.
- **Python:** use `sdks/python/goodbase/client.py` for server automation and management operations.
- **C#:** use `sdks/csharp/Goodbase/GoodbaseClient.cs`; cancellation tokens should be passed to all network work.

## Authentication

Password, email OTP, magic link, phone OTP, anonymous-upgrade, OAuth/OIDC, SAML, passkey, and SMS-MFA providers are represented by explicit provider records. A provider becomes enabled only after its signed runtime health check succeeds. MFA enrollment remains optional; MFA is required only for configured privileged actions or explicit user policy.

Consumer endpoints live under `/api/goodbase/v1/growth/auth`. Phone and account-upgrade challenges are single-use, rate-limited, hashed at rest, bounded by expiry and attempt count, and delivered only through a configured provider.

## REST and GraphQL

Automatic REST is available at `/rest/v1` and GraphQL at `/graphql/v1`. Both use the same short-lived session claims and PostgreSQL RLS boundaries. Tables must be explicitly published and forced-RLS is required. Use bounded pagination, explicit columns, cancellation, and idempotency keys for safe mutations.

## Row-level security

Every tenant-owned table must enforce organization, project, and environment scope. Application roles may not use `BYPASSRLS`. Test positive and negative boundaries for REST, GraphQL, Realtime, and service tokens before publishing a table.

## Realtime and offline synchronization

Realtime uses scoped publications, Broadcast, Presence, resumable cursors, and replay. The offline client stores web data in IndexedDB and mobile clients should use encrypted platform storage. Mutation queues are ordered and idempotent; conflict policies are reject, last-write-wins, or merge. Clear per-user caches on logout.

## Storage and functions

Storage supports signed access, resumable and multipart uploads, versioning, lifecycle policy, scanning, and transformations. Edge Functions run as immutable Deno versions inside the isolated runtime. Validate file signatures and size before upload and use short-lived function credentials.

## Queues and schedules

Queues use leases, visibility timeouts, retries, exponential backoff, idempotency, and dead letters. Schedules support SQL, HTTPS, queue, and Edge Function targets. Set a concurrency key and timeout for every production job.

## App attestation and messaging

Create an attestation policy for each app/platform, begin in audit mode, validate rejection metrics, then change to enforce mode. Debug attestations are rejected in production. APNs, FCM, and Web Push device registration requires a ready provider and obeys the policy’s attestation mode. Messaging supports devices, users, topics, segments, localization, scheduled campaigns, suppression, retries, and provider receipts.

## Backups and production operations

Full database backups, WAL archives, Storage objects, configuration, and encrypted secrets require off-server storage and a secondary copy. Restore verification must use an isolated database and record integrity and smoke-test evidence. Operators should review `docs/enterprise-operations.md`, `docs/runtime-health.md`, and the Phase 21–30 readiness evidence before release.

## CLI and Management API

Run `goodbase --help` for CLI commands. Management operations are scoped, hashed, audited, idempotent, and MFA-gated when destructive. The OpenAPI document at `/openapi.json` is canonical for client generation.

## Self-hosting and hardening

Use separate runtime roles, TLS-only pools, forced RLS, isolated workers, encrypted secret references, off-host logs/backups, two backend instances, liveness/readiness probes, and commit-bound release gates. Configure controllers through HTTPS with HMAC or mTLS. Never mark an operation successful before its controller returns verified evidence.

## Service limits and errors

Limits are enforced per tenant and component. A `429` response includes rate-limit headers. `401` means the credential is absent or invalid; `403` means the identity lacks scope; `409` indicates a version/idempotency conflict; `428` requires MFA; and `503` means a provider/controller is not configured or not healthy. Request IDs should accompany support reports.

## Troubleshooting

Check `/api/health/live`, `/api/health/ready`, `/api/data-platform/health`, then the relevant provider/controller health. Confirm the request’s organization, project and environment headers. For offline clients, inspect pending mutations and the last acknowledged sequence. Do not bypass security policy to resolve a connectivity problem.

## Migration paths

Use `node scripts/goodbase-import.js analyze --source <type> --file <manifest>` before applying anything. Supported sources are Supabase, Firebase Auth, Firestore, Firebase Storage, PostgreSQL, and environment-variable manifests. Analysis is non-destructive. Apply requires authenticated approval, a rollback reference, and an active infrastructure controller.
