BEGIN;

UPDATE app_memberships
SET
  status = 'removed',
  updated_at = NOW()
WHERE app_id = 'goodhub'
  AND status <> 'removed';

UPDATE backend_deployment_sites
SET
  status = 'retired',
  updated_at = NOW()
WHERE app_id = 'goodhub'
  AND status <> 'retired';

UPDATE apps
SET
  status = 'disabled',
  updated_at = NOW()
WHERE id = 'goodhub'
  AND status <> 'disabled';

COMMIT;
