BEGIN;

DO $$
DECLARE
    constraint_definition TEXT;
    allowed_values TEXT[];
    allowed_expression TEXT;
BEGIN
    SELECT
        pg_get_constraintdef(oid)
    INTO constraint_definition
    FROM pg_constraint
    WHERE conrelid =
          'backend_identity_providers'::regclass
      AND conname =
          'backend_identity_provider_status_check';

    IF constraint_definition IS NULL THEN
        RAISE EXCEPTION
            'backend_identity_provider_status_check was not found';
    END IF;

    SELECT
        array_agg(
            DISTINCT value
            ORDER BY value
        )
    INTO allowed_values
    FROM (
        SELECT
            matches[1] AS value
        FROM regexp_matches(
            constraint_definition,
            '''([^'']+)''',
            'g'
        ) AS matches

        UNION ALL

        SELECT 'active'

        UNION ALL

        SELECT 'disabled'
    ) AS preserved_values
    WHERE value IS NOT NULL
      AND btrim(value) <> '';

    SELECT
        string_agg(
            quote_literal(value),
            ', '
            ORDER BY value
        )
    INTO allowed_expression
    FROM unnest(
        allowed_values
    ) AS allowed(value);

    ALTER TABLE
        backend_identity_providers
    DROP CONSTRAINT
        backend_identity_provider_status_check;

    EXECUTE format(
        'ALTER TABLE backend_identity_providers
         ADD CONSTRAINT backend_identity_provider_status_check
         CHECK (status IN (%s))
         NOT VALID',
        allowed_expression
    );

    ALTER TABLE
        backend_identity_providers
    VALIDATE CONSTRAINT
        backend_identity_provider_status_check;
END
$$;

COMMIT;
