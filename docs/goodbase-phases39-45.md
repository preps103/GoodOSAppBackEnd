# Goodbase phases 39–45 production certification

Phases 39–45 are activation and proof gates. They are not certified merely
because a table, route, or UI card exists. `npm run certify:production` binds
evidence to the deployed commit and fails unless every required real provider,
backup, restore, client, region, failover, CDN, and replication check passes.

Use `npm run certify:production -- --report-only` to produce a truthful gap
report without weakening the release gate. The report never includes secret
values. Provider records remain `misconfigured` or `disabled` until a signed
health request succeeds against a real HTTPS controller.

The canonical service is `base.goodos.app`. The former hostname and SDK asset
are retirement-only aliases governed by
`docs/goodbase-deprecation-policy.md`.
