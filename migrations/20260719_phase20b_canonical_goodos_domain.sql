BEGIN;

UPDATE apps
SET
    domain = 'goodos.app',
    updated_at = NOW()
WHERE id = 'goodos';

UPDATE backend_deployment_sites
SET
    domain = 'goodos.app',
    health_url = 'https://goodos.app',
    process_name = COALESCE(
        NULLIF(process_name, ''),
        'goodos'
    ),
    updated_at = NOW()
WHERE app_id = 'goodos';

COMMIT;
