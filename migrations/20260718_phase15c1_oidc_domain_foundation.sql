BEGIN;

ALTER TABLE backend_identity_providers
ADD COLUMN IF NOT EXISTS
    metadata_json JSONB NOT NULL
    DEFAULT '{}'::jsonb;

ALTER TABLE backend_identity_providers
ADD COLUMN IF NOT EXISTS
    last_discovered_at TIMESTAMPTZ;

ALTER TABLE backend_identity_providers
ADD COLUMN IF NOT EXISTS
    activated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS
    backend_identity_domains (
        id TEXT PRIMARY KEY,

        organization_id TEXT NOT NULL,

        provider_id TEXT NOT NULL
            REFERENCES
                backend_identity_providers(id)
            ON DELETE CASCADE,

        domain TEXT NOT NULL,

        status TEXT NOT NULL
            DEFAULT 'pending'
            CHECK (
                status IN (
                    'pending',
                    'active',
                    'disabled',
                    'failed'
                )
            ),

        verification_method TEXT NOT NULL
            DEFAULT 'dns_txt',

        verification_record_name TEXT
            NOT NULL,

        verification_token_hash TEXT
            NOT NULL,

        verification_token_encrypted TEXT
            NOT NULL,

        verification_token_prefix TEXT,

        verification_expires_at TIMESTAMPTZ
            NOT NULL,

        verified_at TIMESTAMPTZ,

        last_checked_at TIMESTAMPTZ,

        created_by UUID,
        updated_by UUID,

        metadata_json JSONB NOT NULL
            DEFAULT '{}'::jsonb,

        project_id TEXT
            DEFAULT 'proj_goodos_platform',

        environment_id TEXT
            DEFAULT 'env_goodos_production',

        created_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW(),

        updated_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW(),

        UNIQUE (
            organization_id,
            domain
        )
    );

CREATE INDEX IF NOT EXISTS
    idx_backend_identity_domains_provider
ON backend_identity_domains (
    provider_id,
    status
);

CREATE INDEX IF NOT EXISTS
    idx_backend_identity_domains_org
ON backend_identity_domains (
    organization_id,
    status
);

CREATE TABLE IF NOT EXISTS
    backend_oidc_transactions (
        id TEXT PRIMARY KEY,

        organization_id TEXT NOT NULL,

        provider_id TEXT NOT NULL
            REFERENCES
                backend_identity_providers(id)
            ON DELETE CASCADE,

        state_hash TEXT NOT NULL,

        nonce_encrypted TEXT NOT NULL,

        code_verifier_encrypted TEXT
            NOT NULL,

        return_to TEXT,

        status TEXT NOT NULL
            DEFAULT 'pending'
            CHECK (
                status IN (
                    'pending',
                    'used',
                    'expired',
                    'failed'
                )
            ),

        ip_address TEXT,
        user_agent TEXT,

        expires_at TIMESTAMPTZ NOT NULL,

        used_at TIMESTAMPTZ,

        metadata_json JSONB NOT NULL
            DEFAULT '{}'::jsonb,

        created_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW(),

        updated_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW()
    );

CREATE UNIQUE INDEX IF NOT EXISTS
    idx_backend_oidc_transactions_state
ON backend_oidc_transactions (
    state_hash
);

CREATE INDEX IF NOT EXISTS
    idx_backend_oidc_transactions_expiry
ON backend_oidc_transactions (
    status,
    expires_at
);

COMMIT;
