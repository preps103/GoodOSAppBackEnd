BEGIN;

CREATE TABLE backend_teams (
  id TEXT PRIMARY KEY,

  organization_id TEXT NOT NULL
    REFERENCES backend_organizations(id)
    ON DELETE CASCADE,

  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,

  status TEXT NOT NULL DEFAULT 'active'
    CHECK (
      status IN (
        'active',
        'archived'
      )
    ),

  created_by UUID
    REFERENCES users(id)
    ON DELETE SET NULL,

  metadata_json JSONB NOT NULL
    DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL
    DEFAULT NOW(),

  updated_at TIMESTAMPTZ NOT NULL
    DEFAULT NOW(),

  UNIQUE (
    organization_id,
    slug
  )
);

CREATE INDEX idx_backend_teams_organization
  ON backend_teams(organization_id);

CREATE INDEX idx_backend_teams_status
  ON backend_teams(status);


CREATE TABLE backend_team_memberships (
  id TEXT PRIMARY KEY,

  team_id TEXT NOT NULL
    REFERENCES backend_teams(id)
    ON DELETE CASCADE,

  user_id UUID NOT NULL
    REFERENCES users(id)
    ON DELETE CASCADE,

  role_id TEXT
    REFERENCES backend_roles(id)
    ON DELETE SET NULL,

  status TEXT NOT NULL DEFAULT 'active'
    CHECK (
      status IN (
        'active',
        'suspended',
        'removed'
      )
    ),

  added_by UUID
    REFERENCES users(id)
    ON DELETE SET NULL,

  metadata_json JSONB NOT NULL
    DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL
    DEFAULT NOW(),

  updated_at TIMESTAMPTZ NOT NULL
    DEFAULT NOW(),

  UNIQUE (
    team_id,
    user_id
  )
);

CREATE INDEX idx_backend_team_memberships_team
  ON backend_team_memberships(team_id);

CREATE INDEX idx_backend_team_memberships_user
  ON backend_team_memberships(user_id);

CREATE INDEX idx_backend_team_memberships_status
  ON backend_team_memberships(status);


CREATE TRIGGER set_backend_teams_updated_at
BEFORE UPDATE ON backend_teams
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


CREATE TRIGGER set_backend_team_memberships_updated_at
BEFORE UPDATE ON backend_team_memberships
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();


INSERT INTO backend_permissions (
  id,
  name,
  category,
  description,
  status,
  metadata_json
)
VALUES
(
  'perm_team_read',
  'team:read',
  'teams',
  'View GoodOS teams, members, roles, invitations, and team activity.',
  'active',
  '{"phase":"teams_v1"}'::jsonb
),
(
  'perm_team_manage',
  'team:manage',
  'teams',
  'Create and manage teams, memberships, roles, and invitations.',
  'active',
  '{"phase":"teams_v1"}'::jsonb
);


INSERT INTO backend_role_permissions (
  id,
  role_id,
  permission_id,
  status
)
SELECT
  'rp_' || role.id || '_perm_team_read',
  role.id,
  'perm_team_read',
  'active'
FROM backend_roles role
WHERE role.status = 'active';


INSERT INTO backend_role_permissions (
  id,
  role_id,
  permission_id,
  status
)
SELECT
  'rp_' || role.id || '_perm_team_manage',
  role.id,
  'perm_team_manage',
  'active'
FROM backend_roles role
WHERE role.status = 'active'
  AND role.name IN (
    'owner',
    'admin',
    'manager'
  );

COMMIT;
