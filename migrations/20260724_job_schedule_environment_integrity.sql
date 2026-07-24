BEGIN;

UPDATE backend_job_schedules AS schedules
SET
  organization_id = jobs.organization_id,
  project_id = jobs.project_id,
  environment_id = jobs.environment_id,
  updated_at = NOW()
FROM backend_jobs AS jobs
WHERE jobs.id = schedules.job_id
  AND schedules.environment_id IS NULL
  AND jobs.organization_id IS NOT NULL
  AND jobs.project_id IS NOT NULL
  AND jobs.environment_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM backend_job_schedules
    WHERE organization_id IS NULL
       OR project_id IS NULL
       OR environment_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Job-schedule environment backfill is incomplete';
  END IF;
END
$$;

ALTER TABLE backend_job_schedules
  ALTER COLUMN organization_id SET NOT NULL,
  ALTER COLUMN project_id SET NOT NULL,
  ALTER COLUMN environment_id SET NOT NULL;

COMMIT;
