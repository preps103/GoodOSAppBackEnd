/* GOODOS_ROLES_CONSOLE_V1 */

BEGIN;

CREATE TABLE backend_role_settings (
    organization_id TEXT PRIMARY KEY
        REFERENCES backend_organizations(id)
        ON DELETE CASCADE,

    default_role_id TEXT
        REFERENCES backend_roles(id)
        ON DELETE SET NULL,

    allow_self_service_requests BOOLEAN
        NOT NULL
        DEFAULT TRUE,

    require_request_reason BOOLEAN
        NOT NULL
        DEFAULT TRUE,

    metadata_json JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

    updated_by UUID
        REFERENCES users(id)
        ON DELETE SET NULL,

    created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

    updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()
);

CREATE TABLE backend_access_requests (
    id TEXT PRIMARY KEY,

    organization_id TEXT NOT NULL
        REFERENCES backend_organizations(id)
        ON DELETE CASCADE,

    requester_user_id UUID NOT NULL
        REFERENCES users(id)
        ON DELETE CASCADE,

    requested_role_id TEXT NOT NULL
        REFERENCES backend_roles(id)
        ON DELETE RESTRICT,

    scope_type TEXT NOT NULL
        DEFAULT 'organization'
        CHECK (
            scope_type IN (
                'organization',
                'team',
                'app'
            )
        ),

    scope_id TEXT NOT NULL,

    reason TEXT,

    status TEXT NOT NULL
        DEFAULT 'pending'
        CHECK (
            status IN (
                'pending',
                'approved',
                'denied',
                'cancelled'
            )
        ),

    reviewed_by UUID
        REFERENCES users(id)
        ON DELETE SET NULL,

    reviewed_at TIMESTAMPTZ,

    decision_note TEXT,

    metadata_json JSONB
        NOT NULL
        DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW(),

    updated_at TIMESTAMPTZ
        NOT NULL
        DEFAULT NOW()
);

CREATE INDEX backend_access_requests_org_status_idx
ON backend_access_requests (
    organization_id,
    status,
    created_at DESC
);

CREATE INDEX backend_access_requests_requester_idx
ON backend_access_requests (
    requester_user_id,
    created_at DESC
);

CREATE INDEX backend_access_requests_role_idx
ON backend_access_requests (
    requested_role_id,
    status
);

INSERT INTO backend_role_settings (
    organization_id,
    default_role_id
)
SELECT
    organization.id,
    (
        SELECT role.id
        FROM backend_roles role
        WHERE role.organization_id =
              organization.id
          AND role.name = 'viewer'
          AND role.status = 'active'
        LIMIT 1
    )
FROM backend_organizations organization
WHERE organization.status = 'active'
ON CONFLICT (
    organization_id
)
DO NOTHING;

COMMIT;
