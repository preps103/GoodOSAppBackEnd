# GoodOS Enterprise Operations Standard

This standard turns the nine enterprise workstreams into measurable production controls. The authenticated owner/admin endpoint `GET /api/enterprise/readiness-program` reports live file and database evidence for every control.

## 1. Automated testing and release gates

Every change must pass locked dependency installation, JavaScript syntax checks, the Node test suite, OpenAPI validation, and production release governance. Production changes require a known rollback path and must preserve unrelated working-tree changes.

## 2. API architecture

Public APIs remain versioned under `/api/v1` and `/api/v2`. `docs/openapi.json` is the canonical contract and must exactly match the published developer copy. Breaking changes require a new API version and a migration window.

## 3. Enterprise identity and security

OIDC, SCIM, MFA, roles, sessions, API credentials, and secrets use least privilege. MFA enrollment does not make sign-in MFA mandatory unless the account or organization explicitly opts in. Privileged operations require an active owner or administrator membership.

## 4. Reliability and scaling

Backends expose health and dependency readiness separately. Jobs must be idempotent, use worker locks, record runs, and tolerate retries. Deployments use rolling restarts and verify both backend instances before completion.

## 5. Database and data governance

Organization, project, and environment context must be resolved before tenant-scoped data access. Retention automation supports dry runs, legal holds, data exports, and auditable deletion workflows.

## 6. Observability and operations

Requests carry request and trace identifiers. Logs redact credential-like fields. Metrics, dependency checks, SLO measurements, incidents, and operational events are retained according to policy and checked continuously.

## 7. Backups and disaster recovery

Database backups are checksummed and inventoried. Restore verification uses an isolated temporary database and records evidence. Target RPO is 24 hours and target RTO is 4 hours until a stricter approved policy is configured. A restore test should run at least monthly and after material schema changes.

## 8. Billing and usage

Meter events are immutable inputs. Quotas, daily aggregates, subscriptions, invoices, and plan entitlements must reconcile to those events. Administrative adjustments require audit evidence.

## 9. Compliance and enterprise controls

Authentication, administrative changes, approvals, consent, legal holds, privacy requests, and release decisions create attributable audit records. Evidence must avoid passwords, tokens, secret values, and private keys.

## Incident and recovery sequence

1. Identify the affected service and preserve request/trace identifiers.
2. Check `/health` and `/api/enterprise/ready` on both backend instances.
3. Review dependency status, SLOs, worker heartbeat, queue depth, disk, and the latest verified backup.
4. Contain the issue without deleting evidence.
5. Roll back only through the recorded release path.
6. Verify public health, authenticated core workflows, jobs, certificates, backups, and error rates.
7. Record the timeline, root cause, corrective action, and follow-up owner.
