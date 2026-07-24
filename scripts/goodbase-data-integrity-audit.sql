\set ON_ERROR_STOP on
\pset pager off
\pset null '(null)'

BEGIN;

CREATE TEMP TABLE goodbase_environment_scope_audit (
  table_name TEXT PRIMARY KEY,
  scope_policy TEXT NOT NULL,
  total_records BIGINT NOT NULL,
  unscoped_records BIGINT NOT NULL,
  missing_environment_records BIGINT NOT NULL,
  mismatched_project_records BIGINT NOT NULL,
  mismatched_organization_records BIGINT NOT NULL
);

DO $audit$
DECLARE
  item RECORD;
  has_project BOOLEAN;
  has_organization BOOLEAN;
  statement TEXT;
BEGIN
  FOR item IN
    SELECT columns.table_name
    FROM information_schema.columns
    JOIN information_schema.tables
      ON tables.table_schema = columns.table_schema
     AND tables.table_name = columns.table_name
     AND tables.table_type = 'BASE TABLE'
    WHERE columns.table_schema = 'public'
      AND columns.column_name = 'environment_id'
    ORDER BY columns.table_name
  LOOP
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = item.table_name
        AND column_name = 'project_id'
    ) INTO has_project;

    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = item.table_name
        AND column_name = 'organization_id'
    ) INTO has_organization;

    statement := format(
      $sql$
        INSERT INTO goodbase_environment_scope_audit
        SELECT
          %L,
          %L,
          COUNT(*)::bigint,
          COUNT(*) FILTER (WHERE records.environment_id IS NULL)::bigint,
          COUNT(*) FILTER (
            WHERE records.environment_id IS NOT NULL
              AND environments.id IS NULL
          )::bigint,
          %s,
          %s
        FROM %I AS records
        LEFT JOIN backend_project_environments AS environments
          ON environments.id = records.environment_id
      $sql$,
      item.table_name,
      CASE
        WHEN item.table_name IN (
          'backend_admin_audit_logs',
          'backend_event_outbox',
          'backend_events',
          'backend_mfa_factors',
          'sessions'
        ) THEN 'optional_global'
        ELSE 'required'
      END,
      CASE
        WHEN has_project THEN
          'COUNT(*) FILTER (
             WHERE records.environment_id IS NOT NULL
               AND environments.id IS NOT NULL
               AND records.project_id IS DISTINCT FROM environments.project_id
           )::bigint'
        ELSE '0::bigint'
      END,
      CASE
        WHEN has_organization THEN
          'COUNT(*) FILTER (
             WHERE records.environment_id IS NOT NULL
               AND environments.id IS NOT NULL
               AND records.organization_id IS DISTINCT FROM (
                 SELECT projects.organization_id
                 FROM backend_projects AS projects
                 WHERE projects.id = environments.project_id
               )
           )::bigint'
        ELSE '0::bigint'
      END,
      item.table_name
    );

    EXECUTE statement;
  END LOOP;
END
$audit$;

\echo '=== Environment scope integrity ==='
SELECT *
FROM goodbase_environment_scope_audit
WHERE unscoped_records > 0
  AND scope_policy = 'required'
   OR missing_environment_records > 0
   OR mismatched_project_records > 0
   OR mismatched_organization_records > 0
ORDER BY table_name;

\echo '=== Legitimate global records with optional environment scope ==='
SELECT *
FROM goodbase_environment_scope_audit
WHERE scope_policy = 'optional_global'
  AND unscoped_records > 0
ORDER BY table_name;

\echo '=== Environment scope summary ==='
SELECT
  COUNT(*) FILTER (WHERE scope_policy = 'required') AS tables_requiring_environment_scope,
  SUM(total_records) AS total_records,
  SUM(unscoped_records) FILTER (WHERE scope_policy = 'required') AS required_unscoped_records,
  SUM(unscoped_records) FILTER (WHERE scope_policy = 'optional_global') AS legitimate_global_records,
  SUM(missing_environment_records) AS missing_environment_records,
  SUM(mismatched_project_records) AS mismatched_project_records,
  SUM(mismatched_organization_records) AS mismatched_organization_records
FROM goodbase_environment_scope_audit;

\echo '=== Application registry and membership integrity ==='
SELECT
  (SELECT COUNT(*) FROM apps) AS applications,
  (SELECT COUNT(*) FROM apps WHERE environment_id IS NULL) AS unscoped_applications,
  (
    SELECT COUNT(*)
    FROM app_memberships AS memberships
    LEFT JOIN apps ON apps.id = memberships.app_id
    WHERE apps.id IS NULL
  ) AS memberships_without_application,
  (
    SELECT COUNT(*)
    FROM app_memberships AS memberships
    LEFT JOIN users ON users.id = memberships.user_id
    WHERE users.id IS NULL
  ) AS memberships_without_user;

\echo '=== Invalid or unvalidated foreign keys ==='
SELECT
  constraints.conrelid::regclass AS table_name,
  constraints.conname AS constraint_name,
  constraints.convalidated AS validated
FROM pg_constraint AS constraints
WHERE constraints.contype = 'f'
  AND constraints.connamespace = 'public'::regnamespace
  AND NOT constraints.convalidated
ORDER BY constraints.conrelid::regclass::text, constraints.conname;

\echo '=== Migration tracking tables ==='
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name ILIKE '%migration%'
ORDER BY table_name;

\echo '=== Recent governed migration ledger entries ==='
SELECT
  id,
  file_name,
  status,
  checksum_sha256,
  created_at,
  applied_at
FROM backend_migration_ledger
ORDER BY created_at DESC
LIMIT 10;

\echo '=== Recent local database backups ==='
SELECT
  id,
  status,
  size_bytes,
  checksum_sha256,
  created_at,
  completed_at
FROM backend_backups
ORDER BY created_at DESC
LIMIT 5;

\echo '=== Recent encrypted enterprise backups ==='
SELECT
  id,
  backup_type,
  status,
  size_bytes,
  checksum_sha256,
  created_at,
  completed_at
FROM backend_backup_inventory
ORDER BY created_at DESC
LIMIT 5;

\echo '=== Recent restore and PITR verification ==='
SELECT
  id,
  backup_inventory_id,
  verification_type,
  status,
  rpo_minutes,
  rto_minutes,
  created_at,
  completed_at
FROM backend_restore_verifications
ORDER BY created_at DESC
LIMIT 5;

ROLLBACK;
