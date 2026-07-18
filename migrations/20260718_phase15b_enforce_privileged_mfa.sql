BEGIN;

UPDATE backend_identity_policies
SET
    mfa_mode = 'admin_required',
    metadata_json =
        COALESCE(
            metadata_json,
            '{}'::jsonb
        ) ||
        jsonb_build_object(
            'phase15bEnforced',
            true,
            'phase15bEnforcedAt',
            NOW()
        ),
    updated_at = NOW()
WHERE organization_id = 'org_goodos';

UPDATE users AS account
SET
    mfa_required = true,
    updated_at = NOW()
WHERE account.status = 'active'
  AND (
      lower(account.platform_role) IN (
          'owner',
          'admin',
          'super_admin',
          'superadmin'
      )
      OR EXISTS (
          SELECT 1
          FROM backend_organization_memberships
               AS membership
          JOIN backend_identity_policies
               AS policy
            ON policy.organization_id =
               membership.organization_id
          WHERE membership.user_id =
                account.id
            AND membership.status =
                'active'
            AND lower(membership.role) IN (
                'owner',
                'admin'
            )
            AND policy.mfa_mode IN (
                'admin_required',
                'required'
            )
      )
  );

CREATE OR REPLACE FUNCTION
    goodos_enforce_privileged_user_mfa()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF (
        NEW.status = 'active'
        AND lower(
            COALESCE(
                NEW.platform_role,
                ''
            )
        ) IN (
            'owner',
            'admin',
            'super_admin',
            'superadmin'
        )
    ) THEN
        NEW.mfa_required := true;
    END IF;

    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS
    goodos_users_privileged_mfa_trigger
ON users;

CREATE TRIGGER
    goodos_users_privileged_mfa_trigger
BEFORE INSERT OR UPDATE OF
    platform_role,
    status,
    mfa_required
ON users
FOR EACH ROW
EXECUTE FUNCTION
    goodos_enforce_privileged_user_mfa();

CREATE OR REPLACE FUNCTION
    goodos_enforce_membership_mfa()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF (
        NEW.status = 'active'
        AND lower(
            COALESCE(
                NEW.role,
                ''
            )
        ) IN (
            'owner',
            'admin'
        )
        AND EXISTS (
            SELECT 1
            FROM backend_identity_policies
            WHERE organization_id =
                  NEW.organization_id
              AND mfa_mode IN (
                  'admin_required',
                  'required'
              )
        )
    ) THEN
        UPDATE users
        SET
            mfa_required = true,
            updated_at = NOW()
        WHERE id = NEW.user_id;
    END IF;

    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS
    goodos_membership_privileged_mfa_trigger
ON backend_organization_memberships;

CREATE TRIGGER
    goodos_membership_privileged_mfa_trigger
AFTER INSERT OR UPDATE OF
    role,
    status,
    user_id,
    organization_id
ON backend_organization_memberships
FOR EACH ROW
EXECUTE FUNCTION
    goodos_enforce_membership_mfa();

CREATE OR REPLACE FUNCTION
    goodos_enforce_policy_mfa()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.mfa_mode IN (
        'admin_required',
        'required'
    ) THEN
        UPDATE users AS account
        SET
            mfa_required = true,
            updated_at = NOW()
        WHERE account.status = 'active'
          AND (
              lower(account.platform_role) IN (
                  'owner',
                  'admin',
                  'super_admin',
                  'superadmin'
              )
              OR EXISTS (
                  SELECT 1
                  FROM backend_organization_memberships
                       AS membership
                  WHERE membership.user_id =
                        account.id
                    AND membership.organization_id =
                        NEW.organization_id
                    AND membership.status =
                        'active'
                    AND lower(membership.role) IN (
                        'owner',
                        'admin'
                    )
              )
          );
    END IF;

    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS
    goodos_identity_policy_mfa_trigger
ON backend_identity_policies;

CREATE TRIGGER
    goodos_identity_policy_mfa_trigger
AFTER INSERT OR UPDATE OF mfa_mode
ON backend_identity_policies
FOR EACH ROW
EXECUTE FUNCTION
    goodos_enforce_policy_mfa();

COMMIT;
