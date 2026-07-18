BEGIN;

CREATE TABLE IF NOT EXISTS
    backend_service_accounts (
        id TEXT PRIMARY KEY,

        organization_id TEXT NOT NULL,

        name TEXT NOT NULL,

        description TEXT,

        status TEXT NOT NULL
            DEFAULT 'active'
            CHECK (
                status IN (
                    'active',
                    'disabled'
                )
            ),

        created_by UUID,

        last_used_at TIMESTAMPTZ,

        metadata_json JSONB NOT NULL
            DEFAULT '{}'::jsonb,

        created_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW(),

        updated_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW(),

        UNIQUE (
            organization_id,
            name
        )
    );

CREATE INDEX IF NOT EXISTS
    idx_backend_service_accounts_org_status
ON backend_service_accounts (
    organization_id,
    status
);

ALTER TABLE backend_api_keys
ADD COLUMN IF NOT EXISTS
    service_account_id TEXT;

CREATE INDEX IF NOT EXISTS
    idx_backend_api_keys_service_account
ON backend_api_keys (
    service_account_id
);

CREATE TABLE IF NOT EXISTS
    backend_api_gateway_policies (
        id TEXT PRIMARY KEY,

        organization_id TEXT NOT NULL,

        api_key_id TEXT NOT NULL
            UNIQUE,

        service_account_id TEXT,

        requests_per_minute INTEGER NOT NULL
            DEFAULT 120
            CHECK (
                requests_per_minute
                BETWEEN 1 AND 100000
            ),

        burst_limit INTEGER NOT NULL
            DEFAULT 30
            CHECK (
                burst_limit
                BETWEEN 1 AND 100000
            ),

        daily_quota INTEGER NOT NULL
            DEFAULT 10000
            CHECK (
                daily_quota
                BETWEEN 1 AND 100000000
            ),

        max_body_bytes INTEGER NOT NULL
            DEFAULT 1048576
            CHECK (
                max_body_bytes
                BETWEEN 1024 AND 10485760
            ),

        require_idempotency BOOLEAN NOT NULL
            DEFAULT FALSE,

        allowed_cidrs TEXT[] NOT NULL
            DEFAULT ARRAY['*']::TEXT[],

        denied_cidrs TEXT[] NOT NULL
            DEFAULT ARRAY[]::TEXT[],

        status TEXT NOT NULL
            DEFAULT 'active'
            CHECK (
                status IN (
                    'active',
                    'disabled'
                )
            ),

        created_by UUID,

        metadata_json JSONB NOT NULL
            DEFAULT '{}'::jsonb,

        created_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW(),

        updated_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW()
    );

CREATE INDEX IF NOT EXISTS
    idx_backend_api_gateway_policies_org
ON backend_api_gateway_policies (
    organization_id,
    status
);

CREATE INDEX IF NOT EXISTS
    idx_backend_api_gateway_policies_service
ON backend_api_gateway_policies (
    service_account_id
);

CREATE TABLE IF NOT EXISTS
    backend_api_gateway_windows (
        api_key_id TEXT NOT NULL,

        window_start TIMESTAMPTZ NOT NULL,

        request_count INTEGER NOT NULL
            DEFAULT 0,

        updated_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW(),

        PRIMARY KEY (
            api_key_id,
            window_start
        )
    );

CREATE INDEX IF NOT EXISTS
    idx_backend_api_gateway_windows_cleanup
ON backend_api_gateway_windows (
    window_start
);

CREATE TABLE IF NOT EXISTS
    backend_api_gateway_daily_usage (
        api_key_id TEXT NOT NULL,

        usage_date DATE NOT NULL,

        request_count INTEGER NOT NULL
            DEFAULT 0,

        updated_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW(),

        PRIMARY KEY (
            api_key_id,
            usage_date
        )
    );

CREATE INDEX IF NOT EXISTS
    idx_backend_api_gateway_daily_cleanup
ON backend_api_gateway_daily_usage (
    usage_date
);

CREATE TABLE IF NOT EXISTS
    backend_api_idempotency_records (
        id TEXT PRIMARY KEY,

        api_key_id TEXT NOT NULL,

        idempotency_key TEXT NOT NULL,

        request_hash TEXT NOT NULL,

        request_method TEXT NOT NULL,

        request_path TEXT NOT NULL,

        status TEXT NOT NULL
            DEFAULT 'processing'
            CHECK (
                status IN (
                    'processing',
                    'completed',
                    'failed'
                )
            ),

        response_status INTEGER,

        response_headers JSONB NOT NULL
            DEFAULT '{}'::jsonb,

        response_body JSONB,

        expires_at TIMESTAMPTZ NOT NULL,

        created_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW(),

        updated_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW(),

        UNIQUE (
            api_key_id,
            idempotency_key
        )
    );

CREATE INDEX IF NOT EXISTS
    idx_backend_api_idempotency_expiry
ON backend_api_idempotency_records (
    expires_at
);

CREATE TABLE IF NOT EXISTS
    backend_api_gateway_request_logs (
        id TEXT PRIMARY KEY,

        request_id TEXT NOT NULL,

        organization_id TEXT,

        api_key_id TEXT,

        service_account_id TEXT,

        method TEXT NOT NULL,

        path TEXT NOT NULL,

        status_code INTEGER,

        duration_ms INTEGER,

        source_ip TEXT,

        user_agent TEXT,

        idempotency_key TEXT,

        idempotent_replay BOOLEAN NOT NULL
            DEFAULT FALSE,

        rate_limit INTEGER,

        rate_limit_remaining INTEGER,

        daily_quota INTEGER,

        daily_remaining INTEGER,

        request_bytes INTEGER NOT NULL
            DEFAULT 0,

        response_bytes INTEGER NOT NULL
            DEFAULT 0,

        metadata_json JSONB NOT NULL
            DEFAULT '{}'::jsonb,

        created_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW()
    );

CREATE INDEX IF NOT EXISTS
    idx_backend_api_gateway_logs_key_time
ON backend_api_gateway_request_logs (
    api_key_id,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS
    idx_backend_api_gateway_logs_org_time
ON backend_api_gateway_request_logs (
    organization_id,
    created_at DESC
);

CREATE INDEX IF NOT EXISTS
    idx_backend_api_gateway_logs_request
ON backend_api_gateway_request_logs (
    request_id
);

COMMIT;
