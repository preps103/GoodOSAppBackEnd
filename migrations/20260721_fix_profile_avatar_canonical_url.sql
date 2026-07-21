BEGIN;

UPDATE users
SET
  avatar_url =
    'https://base.goodos.app/api/settings/avatars/' ||
    id::text ||
    CASE
      WHEN avatar_updated_at IS NULL THEN ''
      ELSE '?v=' ||
        (EXTRACT(EPOCH FROM avatar_updated_at) * 1000)::bigint::text
    END,
  updated_at = NOW()
WHERE
  avatar_file_name IS NOT NULL
  AND (
    avatar_url IS NULL
    OR avatar_url NOT LIKE
      'https://base.goodos.app/api/settings/avatars/%'
  );

COMMIT;
