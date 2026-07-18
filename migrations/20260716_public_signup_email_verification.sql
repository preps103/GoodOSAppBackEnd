CREATE TABLE IF NOT EXISTS backend_email_verification_tokens (
    id text PRIMARY KEY,
    user_id uuid NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,
    token_hash text NOT NULL UNIQUE,
    status text NOT NULL DEFAULT 'active'
        CHECK (
            status IN (
                'active',
                'used',
                'expired',
                'revoked'
            )
        ),
    requested_ip text,
    user_agent text,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT NOW(),
    updated_at timestamp with time zone NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS
    idx_email_verification_tokens_user
ON backend_email_verification_tokens(user_id);

CREATE INDEX IF NOT EXISTS
    idx_email_verification_tokens_status_expiry
ON backend_email_verification_tokens(status, expires_at);
