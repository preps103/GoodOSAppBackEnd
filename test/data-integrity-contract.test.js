const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (relativePath) =>
  fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");

test("production data audit checks scope, relationships, migrations, and recoverability", () => {
  const audit = read("scripts/goodbase-data-integrity-audit.sql");

  assert.match(audit, /goodbase_environment_scope_audit/);
  assert.match(audit, /missing_environment_records/);
  assert.match(audit, /mismatched_project_records/);
  assert.match(audit, /mismatched_organization_records/);
  assert.match(audit, /memberships_without_application/);
  assert.match(audit, /memberships_without_user/);
  assert.match(audit, /backend_migration_ledger/);
  assert.match(audit, /backend_backup_inventory/);
  assert.match(audit, /backend_restore_verifications/);
});

test("job schedule migration inherits scope and prevents future unscoped schedules", () => {
  const migration = read(
    "migrations/20260724_job_schedule_environment_integrity.sql"
  );

  assert.match(
    migration,
    /UPDATE backend_job_schedules AS schedules[\s\S]*FROM backend_jobs AS jobs/
  );
  assert.match(
    migration,
    /ALTER TABLE backend_job_schedules[\s\S]*ALTER COLUMN environment_id SET NOT NULL/
  );
});
