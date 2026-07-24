BEGIN;

DO $migration$
DECLARE
  source_app apps%ROWTYPE;
  target_count INTEGER;
  reference_column RECORD;
BEGIN
  SELECT *
  INTO source_app
  FROM apps
  WHERE id = 'goodbackend'
  FOR UPDATE;

  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM apps WHERE id = 'goodbase') THEN
      RETURN;
    END IF;

    RAISE EXCEPTION 'The GoodBase registry source row goodbackend was not found';
  END IF;

  SELECT COUNT(*)
  INTO target_count
  FROM apps
  WHERE id = 'goodbase';

  IF target_count > 0 THEN
    RAISE EXCEPTION 'The GoodBase registry target row goodbase already exists';
  END IF;

  INSERT INTO apps (
    id,
    name,
    domain,
    status,
    description,
    created_at,
    updated_at,
    organization_id,
    project_id,
    environment_id
  )
  VALUES (
    'goodbase',
    'GoodBase',
    'base.goodos.app',
    source_app.status,
    source_app.description,
    source_app.created_at,
    NOW(),
    source_app.organization_id,
    source_app.project_id,
    source_app.environment_id
  );

  FOR reference_column IN
    SELECT table_schema, table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'app_id'
    ORDER BY table_name
  LOOP
    EXECUTE format(
      'UPDATE %I.%I SET app_id = $1 WHERE app_id = $2',
      reference_column.table_schema,
      reference_column.table_name
    )
    USING 'goodbase', 'goodbackend';
  END LOOP;

  UPDATE backend_notifications
  SET
    metadata_json =
      CASE
        WHEN metadata_json ->> 'appId' = 'goodbackend'
        THEN jsonb_set(metadata_json, '{appId}', '"goodbase"'::jsonb)
        ELSE metadata_json
      END,
    payload_json =
      CASE
        WHEN payload_json ->> 'appId' = 'goodbackend'
        THEN jsonb_set(payload_json, '{appId}', '"goodbase"'::jsonb)
        ELSE payload_json
      END,
    updated_at = NOW()
  WHERE metadata_json ->> 'appId' = 'goodbackend'
     OR payload_json ->> 'appId' = 'goodbackend';

  UPDATE backend_notifications
  SET
    metadata_json =
      CASE
        WHEN metadata_json ->> 'app_id' = 'goodbackend'
        THEN jsonb_set(metadata_json, '{app_id}', '"goodbase"'::jsonb)
        ELSE metadata_json
      END,
    payload_json =
      CASE
        WHEN payload_json ->> 'app_id' = 'goodbackend'
        THEN jsonb_set(payload_json, '{app_id}', '"goodbase"'::jsonb)
        ELSE payload_json
      END,
    updated_at = NOW()
  WHERE metadata_json ->> 'app_id' = 'goodbackend'
     OR payload_json ->> 'app_id' = 'goodbackend';

  DELETE FROM apps
  WHERE id = 'goodbackend';
END
$migration$;

COMMIT;
