BEGIN;

-- Remove the legacy role- and policy-based enforcement installed by phase15b.
-- Existing per-user mfa_required values are deliberately preserved so this
-- migration does not erase an explicit preference for any other account.
DROP TRIGGER IF EXISTS
    goodos_users_privileged_mfa_trigger
ON users;

DROP TRIGGER IF EXISTS
    goodos_membership_privileged_mfa_trigger
ON backend_organization_memberships;

DROP TRIGGER IF EXISTS
    goodos_identity_policy_mfa_trigger
ON backend_identity_policies;

DROP FUNCTION IF EXISTS
    goodos_enforce_privileged_user_mfa();

DROP FUNCTION IF EXISTS
    goodos_enforce_membership_mfa();

DROP FUNCTION IF EXISTS
    goodos_enforce_policy_mfa();

UPDATE backend_identity_policies
SET
    mfa_mode = 'optional',
    metadata_json =
        COALESCE(
            metadata_json,
            '{}'::jsonb
        ) ||
        jsonb_build_object(
            'mfaOptInRestored',
            true,
            'mfaOptInRestoredAt',
            NOW()
        ),
    updated_at = NOW()
WHERE organization_id = 'org_goodos'
  AND mfa_mode IN (
      'admin_required',
      'required'
  );

COMMIT;
