BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS
    idx_backend_mfa_one_active_totp_per_user
ON backend_mfa_factors (
    user_id
)
WHERE status = 'active'
  AND type = 'totp';

CREATE INDEX IF NOT EXISTS
    idx_sessions_active_user_assurance
ON sessions (
    user_id,
    mfa_verified,
    auth_level,
    expires_at
)
WHERE revoked_at IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname =
            'backend_mfa_active_secret_required'
    ) THEN
        ALTER TABLE backend_mfa_factors
        ADD CONSTRAINT
            backend_mfa_active_secret_required
        CHECK (
            status <> 'active'
            OR secret_encrypted IS NOT NULL
        )
        NOT VALID;
    END IF;
END
$$;

ALTER TABLE backend_mfa_factors
VALIDATE CONSTRAINT
    backend_mfa_active_secret_required;

COMMIT;
