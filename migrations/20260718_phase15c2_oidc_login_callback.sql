BEGIN;

ALTER TABLE backend_oidc_transactions
ADD COLUMN IF NOT EXISTS
    completed_user_id UUID
    REFERENCES users(id)
    ON DELETE SET NULL;

ALTER TABLE backend_oidc_transactions
ADD COLUMN IF NOT EXISTS
    completed_session_id UUID
    REFERENCES sessions(id)
    ON DELETE SET NULL;

ALTER TABLE backend_oidc_transactions
ADD COLUMN IF NOT EXISTS
    failure_code TEXT;

CREATE INDEX IF NOT EXISTS
    idx_backend_oidc_transactions_provider_created
ON backend_oidc_transactions (
    provider_id,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS
    idx_backend_identity_bindings_provider_status
ON backend_identity_bindings (
    provider_id,
    status
);

CREATE INDEX IF NOT EXISTS
    idx_backend_identity_bindings_external_email
ON backend_identity_bindings (
    lower(external_email)
)
WHERE external_email IS NOT NULL;

COMMIT;
