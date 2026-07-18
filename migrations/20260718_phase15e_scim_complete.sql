BEGIN;

CREATE TABLE IF NOT EXISTS
    backend_scim_tokens (
        id TEXT PRIMARY KEY,

        organization_id TEXT NOT NULL,

        name TEXT NOT NULL,

        token_hash TEXT NOT NULL
            UNIQUE,

        token_prefix TEXT NOT NULL,

        status TEXT NOT NULL
            DEFAULT 'active'
            CHECK (
                status IN (
                    'active',
                    'revoked'
                )
            ),

        created_by UUID,

        last_used_at TIMESTAMPTZ,

        expires_at TIMESTAMPTZ,

        revoked_at TIMESTAMPTZ,

        created_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW(),

        updated_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW()
    );

CREATE INDEX IF NOT EXISTS
    idx_backend_scim_tokens_org_status
ON backend_scim_tokens (
    organization_id,
    status
);

CREATE TABLE IF NOT EXISTS
    backend_scim_resources (
        scim_id TEXT PRIMARY KEY,

        organization_id TEXT NOT NULL,

        resource_type TEXT NOT NULL
            CHECK (
                resource_type IN (
                    'User',
                    'Group'
                )
            ),

        external_id TEXT,

        local_id TEXT NOT NULL,

        active BOOLEAN NOT NULL
            DEFAULT TRUE,

        version BIGINT NOT NULL
            DEFAULT 1,

        metadata_json JSONB NOT NULL
            DEFAULT '{}'::jsonb,

        created_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW(),

        updated_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW(),

        UNIQUE (
            organization_id,
            resource_type,
            local_id
        )
    );

CREATE UNIQUE INDEX IF NOT EXISTS
    idx_backend_scim_resources_external
ON backend_scim_resources (
    organization_id,
    resource_type,
    external_id
)
WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS
    idx_backend_scim_resources_type
ON backend_scim_resources (
    organization_id,
    resource_type,
    active
);

CREATE TABLE IF NOT EXISTS
    backend_scim_groups (
        id TEXT PRIMARY KEY,

        organization_id TEXT NOT NULL,

        external_id TEXT,

        display_name TEXT NOT NULL,

        description TEXT,

        status TEXT NOT NULL
            DEFAULT 'active'
            CHECK (
                status IN (
                    'active',
                    'deleted'
                )
            ),

        version BIGINT NOT NULL
            DEFAULT 1,

        created_by UUID,

        created_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW(),

        updated_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW()
    );

CREATE UNIQUE INDEX IF NOT EXISTS
    idx_backend_scim_groups_external
ON backend_scim_groups (
    organization_id,
    external_id
)
WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS
    idx_backend_scim_groups_org_status
ON backend_scim_groups (
    organization_id,
    status
);

CREATE TABLE IF NOT EXISTS
    backend_scim_group_members (
        group_id TEXT NOT NULL
            REFERENCES
                backend_scim_groups(id)
            ON DELETE CASCADE,

        user_scim_id TEXT NOT NULL
            REFERENCES
                backend_scim_resources(scim_id)
            ON DELETE CASCADE,

        created_at TIMESTAMPTZ NOT NULL
            DEFAULT NOW(),

        PRIMARY KEY (
            group_id,
            user_scim_id
        )
    );

CREATE INDEX IF NOT EXISTS
    idx_backend_scim_group_members_user
ON backend_scim_group_members (
    user_scim_id
);

COMMIT;
