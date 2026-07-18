/* GOODOS_SETTINGS_LIVE_V1 */

BEGIN;

CREATE TABLE backend_user_preferences (
    user_id UUID PRIMARY KEY
        REFERENCES users(id)
        ON DELETE CASCADE,

    theme TEXT NOT NULL DEFAULT 'system'
        CHECK (
            theme IN (
                'system',
                'light',
                'dark'
            )
        ),

    accent TEXT NOT NULL DEFAULT 'indigo'
        CHECK (
            accent IN (
                'indigo',
                'emerald',
                'rose',
                'blue',
                'amber',
                'cyan',
                'zinc'
            )
        ),

    reduced_motion BOOLEAN NOT NULL DEFAULT false,
    compact_mode BOOLEAN NOT NULL DEFAULT false,

    language TEXT NOT NULL DEFAULT 'en-US',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    date_format TEXT NOT NULL DEFAULT 'MM/DD/YYYY',
    time_format TEXT NOT NULL DEFAULT '12h',

    email_notifications BOOLEAN NOT NULL DEFAULT true,
    push_notifications BOOLEAN NOT NULL DEFAULT false,
    security_notifications BOOLEAN NOT NULL DEFAULT true,
    billing_notifications BOOLEAN NOT NULL DEFAULT true,
    system_notifications BOOLEAN NOT NULL DEFAULT true,

    digest_frequency TEXT NOT NULL DEFAULT 'instant'
        CHECK (
            digest_frequency IN (
                'instant',
                'daily',
                'weekly',
                'off'
            )
        ),

    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX
    backend_user_preferences_updated_at_idx
ON backend_user_preferences (
    updated_at DESC
);

CREATE TABLE backend_workspace_settings (
    organization_id TEXT PRIMARY KEY
        REFERENCES backend_organizations(id)
        ON DELETE CASCADE,

    description TEXT,

    visibility TEXT NOT NULL DEFAULT 'private'
        CHECK (
            visibility IN (
                'private',
                'organization'
            )
        ),

    member_join_policy TEXT NOT NULL DEFAULT 'invite_only'
        CHECK (
            member_join_policy IN (
                'invite_only',
                'request'
            )
        ),

    default_role TEXT NOT NULL DEFAULT 'viewer'
        CHECK (
            default_role IN (
                'viewer',
                'user',
                'developer',
                'manager'
            )
        ),

    support_email TEXT,

    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE backend_settings_export_requests (
    id TEXT PRIMARY KEY,

    user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    organization_id TEXT
        REFERENCES backend_organizations(id)
        ON DELETE SET NULL,

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
            status IN (
                'pending',
                'processing',
                'completed',
                'failed'
            )
        ),

    format TEXT NOT NULL DEFAULT 'json'
        CHECK (
            format IN (
                'json'
            )
        ),

    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,

    metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX
    backend_settings_export_user_idx
ON backend_settings_export_requests (
    user_id,
    requested_at DESC
);

INSERT INTO backend_user_preferences (
    user_id
)
SELECT
    id
FROM users
WHERE status = 'active'
ON CONFLICT (
    user_id
)
DO NOTHING;

INSERT INTO backend_workspace_settings (
    organization_id,
    description,
    visibility,
    member_join_policy,
    default_role
)
SELECT
    id,
    'Primary production workspace for GoodOS applications.',
    'private',
    'invite_only',
    'viewer'
FROM backend_organizations
WHERE status = 'active'
ON CONFLICT (
    organization_id
)
DO NOTHING;

COMMIT;
