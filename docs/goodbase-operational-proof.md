# Goodbase operational proof program

Goodbase does not certify a capability from source code, a database row, or a dashboard card. The production certification report measures twelve operational requirements against the exact deployed Git commit and stores an immutable SHA-256-addressed report in the evidence directory and database.

The twelve requirements cover release gates, real controllers, recovery, published SDKs, offline clients, a second region, CDN, device distribution, telemetry, hosting, external CI, and commercial/compliance proof. Missing providers remain `blocked`.

Production runs set `GOODBASE_EVIDENCE_DIR=/var/lib/goodbase/evidence` and `GOODBASE_RELEASE_COMMIT` to the full deployed commit. Security, load, chaos, CI, and certification reports are stored separately. Public consumers may read evidence type, result, checksum, and verification time at `/api/goodbase/v1/experience/evidence/releases/:commit`; full report payloads and server paths remain private.

Chaos testing is prohibited against production. It must run through an authenticated non-production controller, and only a passed, commit-bound staging report satisfies certification.
