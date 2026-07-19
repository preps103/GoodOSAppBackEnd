BEGIN;

-- MFA enrollment is available to every user, but requiring MFA at sign-in is
-- an explicit account preference. Role or organization policy changes must
-- not silently turn that preference on.
UPDATE backend_identity_policies
SET
    mfa_mode = 'optional',
    metadata_json =
        COALESCE(
            metadata_json,
            '{}'::jsonb
        ) ||
        jsonb_build_object(
            'mfaSignInDefault',
            'optional',
            'mfaSignInDefaultUpdatedAt',
            NOW()
        ),
    updated_at = NOW()
WHERE organization_id = 'org_goodos';

COMMIT;
