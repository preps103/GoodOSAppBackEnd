# Goodbase home recovery nodes

Goodbase uses the existing encrypted production backup stream and physically
separate recovery nodes. A recovery node may be a desktop, laptop, or NAS. All
nodes use the same artifact format and independently prove that the backup can
be restored.

## Current backup contract

- PostgreSQL logical backup: daily, age-encrypted custom-format dump.
- PostgreSQL physical base backup: weekly, age-encrypted tar/gzip archive with
  a SHA-256 manifest.
- WAL archive: continuous, age-encrypted segments with plaintext SHA-256
  checksums.
- Off-site pull: every 15 minutes to the external recovery drive.
- Recovery verification: nightly on each online recovery node.

R2 is not required for this topology. A second laptop drive and the planned NAS
are additional recovery nodes, not new backup formats. They must never share a
writable backup directory over the network; each node pulls its own copy.

## Security rules

The age identity must not be stored on the external backup drive. Each recovery
node holds an owner-readable copy on its encrypted internal system disk or in a
non-interactive secret manager. The backup recipient is safe to store with the
artifacts. FileVault or equivalent full-disk encryption is required for desktop
and laptop recovery nodes.

## Restore verification

`scripts/goodbase-recovery-node.sh` performs nightly logical restore and archive-integrity checks. It explicitly sets a stable locale so macOS PostgreSQL cannot fail startup with a multithreaded locale initialization error.

`scripts/goodbase-physical-pitr-drill` is the separate physical recovery proof. It runs after the weekly base backup and:

1. Creates pre-target and post-target transactions in a dedicated production drill table.
2. Forces and verifies WAL archival.
3. Decrypts and verifies the newest physical base archive.
4. Replays individually checksum-verified encrypted WAL segments to the exact target timestamp.
5. Proves the pre-target transaction exists and the post-target transaction is absent.
6. Starts isolated PostgREST and Goodbase processes against the recovered cluster.
7. Tests readiness, Auth, REST, GraphQL, Storage, Realtime metadata, and worker metadata.
8. Records RPO, RTO, replay LSN, source checksum, and smoke results in both the database evidence ledger and a root-readable checksum sidecar.
9. Stops every disposable process and destroys the recovered cluster.

The home recovery controller performs these additional checks:

1. Verifies logical, base-backup, WAL, and off-site-copy freshness.
2. Verifies encrypted logical and base-backup SHA-256 sidecars.
3. Decrypts and parses the newest PostgreSQL dump.
4. Decrypts the newest WAL segment and verifies its plaintext checksum.
5. Decrypts the newest base archive and verifies PITR control files.
6. Creates a disposable PostgreSQL 16 cluster on the recovery node.
7. Restores the complete logical dump and runs database smoke checks.
8. Stops and removes the disposable cluster.
9. Writes checksum-protected RPO/RTO and restore evidence under `status/`.
10. Produces a local notification and nonzero result on any failure.

The script never connects to or modifies the production database.

## Additional nodes

On the laptop or NAS, install PostgreSQL 16 and age, copy the controller, escrow
the same age identity outside the backup destination with mode 600, set a unique
`GOODBASE_RECOVERY_NODE_ID`, and point `GOODBASE_RECOVERY_ROOT` at that node's
external disk. The NAS should run the controller from its native scheduler after
each pull. A host only counts as a production recovery region after it has an
independent application runtime, network ingress, monitoring, and tested traffic
promotion; backup storage alone is not a production region.
