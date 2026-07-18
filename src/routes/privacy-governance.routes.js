"use strict";

const crypto =
  require("crypto");

const fs =
  require("fs");

const path =
  require("path");

const express =
  require("express");

const authRequired =
  require("../middleware/authRequired");

const tenantContext =
  require("../middleware/tenantContext");

const {
  query,
} =
  require("../config/database");

const router =
  express.Router();

const EXPORT_ROOT =
  "/var/lib/goodos/privacy/exports";

function identifier(
  prefix
) {
  return (
    `${prefix}_` +
    crypto.randomUUID()
      .replaceAll("-", "")
  );
}

function actorId(
  request
) {
  return (
    request.user?.id ||
    request.auth?.userId ||
    request.auth?.sub ||
    null
  );
}

function requireActor(
  request,
  response
) {
  const userId =
    actorId(request);

  if (!userId) {
    response
      .status(401)
      .json({
        success: false,
        message:
          "Authenticated user identity is unavailable.",
      });

    return null;
  }

  return userId;
}

async function loadIdentity(
  request
) {
  if (
    request.privacyIdentity
  ) {
    return request
      .privacyIdentity;
  }

  const userId =
    actorId(request);

  const organizationId =
    request.tenantContext
      ?.organizationId;

  const result =
    await query(
      `
        SELECT
          account.id,
          account.platform_role
            AS "platformRole",
          account.status,
          membership.role
            AS "membershipRole"

        FROM users
             AS account

        JOIN backend_organization_memberships
             AS membership
          ON membership.user_id =
             account.id

        WHERE account.id =
              $1::uuid

          AND membership.organization_id =
              $2

          AND account.status =
              'active'

          AND membership.status =
              'active'

        LIMIT 1
      `,
      [
        userId,
        organizationId,
      ]
    );

  request.privacyIdentity =
    result.rows[0] ||
    null;

  return request
    .privacyIdentity;
}

async function privacyAdminRequired(
  request,
  response,
  next
) {
  try {
    const identity =
      await loadIdentity(
        request
      );

    const allowed =
      identity &&
      (
        [
          "owner",
          "admin",
        ].includes(
          identity.platformRole
        )
        ||
        [
          "owner",
          "admin",
        ].includes(
          identity.membershipRole
        )
      );

    if (!allowed) {
      return response
        .status(403)
        .json({
          success: false,
          code:
            "PRIVACY_ADMIN_REQUIRED",
          message:
            "Privacy administration requires owner or administrator access.",
        });
    }

    return next();
  } catch (error) {
    return next(error);
  }
}

router.use(
  authRequired,
  tenantContext
);


router.get(
  "/summary",
  async (
    request,
    response,
    next
  ) => {
    try {
      const userId =
        requireActor(
          request,
          response
        );

      if (!userId) return;

      const organizationId =
        request.tenantContext
          .organizationId;

      const [
        policy,
        classifications,
        requests,
        exports,
        closures,
        consents,
      ] =
        await Promise.all([
          query(
            `
              SELECT
                privacy_export_retention_days
                  AS "privacyExportRetentionDays",
                session_retention_days
                  AS "sessionRetentionDays",
                auth_token_retention_days
                  AS "authTokenRetentionDays",
                signed_url_retention_days
                  AS "signedUrlRetentionDays",
                metric_retention_days
                  AS "metricRetentionDays",
                operations_check_retention_days
                  AS "operationsCheckRetentionDays",
                request_retention_days
                  AS "requestRetentionDays",
                consent_retention_days
                  AS "consentRetentionDays",
                legal_hold_enabled
                  AS "legalHoldEnabled",
                final_owner_closure_block
                  AS "finalOwnerClosureBlock",
                automated_retention_enabled
                  AS "automatedRetentionEnabled",
                customer_content_auto_delete
                  AS "customerContentAutoDelete",
                updated_at
                  AS "updatedAt"

              FROM backend_data_governance_policies

              WHERE organization_id =
                    $1
            `,
            [
              organizationId,
            ]
          ),

          query(
            `
              SELECT
                classification,
                COUNT(*)::int
                  AS count

              FROM backend_data_classifications

              WHERE organization_id =
                    $1

              GROUP BY classification

              ORDER BY classification
            `,
            [
              organizationId,
            ]
          ),

          query(
            `
              SELECT
                status,
                COUNT(*)::int
                  AS count

              FROM backend_data_subject_requests

              WHERE organization_id =
                    $1

                AND user_id =
                    $2::uuid

              GROUP BY status
            `,
            [
              organizationId,
              userId,
            ]
          ),

          query(
            `
              SELECT
                status,
                COUNT(*)::int
                  AS count

              FROM backend_privacy_exports

              WHERE organization_id =
                    $1

                AND user_id =
                    $2::uuid

              GROUP BY status
            `,
            [
              organizationId,
              userId,
            ]
          ),

          query(
            `
              SELECT
                status,
                COUNT(*)::int
                  AS count

              FROM backend_account_closure_requests

              WHERE organization_id =
                    $1

                AND user_id =
                    $2::uuid

              GROUP BY status
            `,
            [
              organizationId,
              userId,
            ]
          ),

          query(
            `
              SELECT DISTINCT ON (
                purpose_key
              )
                purpose_key
                  AS "purposeKey",
                action,
                policy_version
                  AS "policyVersion",
                recorded_at
                  AS "recordedAt"

              FROM backend_consent_records

              WHERE organization_id =
                    $1

                AND user_id =
                    $2::uuid

              ORDER BY
                purpose_key,
                recorded_at DESC
            `,
            [
              organizationId,
              userId,
            ]
          ),
        ]);

      response.json({
        success: true,
        organizationId,
        policy:
          policy.rows[0] ||
          null,
        classifications:
          classifications.rows,
        requests:
          requests.rows,
        exports:
          exports.rows,
        accountClosures:
          closures.rows,
        currentConsents:
          consents.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);


router.get(
  "/requests",
  async (
    request,
    response,
    next
  ) => {
    try {
      const userId =
        requireActor(
          request,
          response
        );

      if (!userId) return;

      const result =
        await query(
          `
            SELECT
              id,
              request_type
                AS "requestType",
              status,
              subject_email
                AS "subjectEmail",
              description,
              due_at
                AS "dueAt",
              fulfilled_at
                AS "fulfilledAt",
              response_notes
                AS "responseNotes",
              submitted_at
                AS "submittedAt",
              updated_at
                AS "updatedAt"

            FROM backend_data_subject_requests

            WHERE organization_id =
                  $1

              AND user_id =
                  $2::uuid

            ORDER BY
              submitted_at DESC

            LIMIT 250
          `,
          [
            request.tenantContext
              .organizationId,
            userId,
          ]
        );

      response.json({
        success: true,
        requests:
          result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);


router.post(
  "/requests",
  async (
    request,
    response,
    next
  ) => {
    try {
      const userId =
        requireActor(
          request,
          response
        );

      if (!userId) return;

      const requestType =
        String(
          request.body
            ?.requestType ||
          ""
        )
        .trim();

      if (
        ![
          "access",
          "export",
          "correction",
          "deletion",
          "restriction",
          "objection",
        ].includes(
          requestType
        )
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Invalid data-subject request type.",
          });
      }

      const userResult =
        await query(
          `
            SELECT email
            FROM users
            WHERE id =
                  $1::uuid
          `,
          [
            userId,
          ]
        );

      const result =
        await query(
          `
            INSERT INTO backend_data_subject_requests (
              id,
              organization_id,
              project_id,
              environment_id,
              user_id,
              request_type,
              status,
              subject_email,
              description,
              metadata_json
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5::uuid,
              $6,
              'submitted',
              $7,
              $8,
              $9::jsonb
            )
            RETURNING
              id,
              request_type
                AS "requestType",
              status,
              due_at
                AS "dueAt",
              submitted_at
                AS "submittedAt"
          `,
          [
            identifier(
              "dsr"
            ),
            request.tenantContext
              .organizationId,
            request.tenantContext
              .projectId,
            request.tenantContext
              .environmentId,
            userId,
            requestType,
            userResult.rows[0]
              ?.email ||
              null,
            String(
              request.body
                ?.description ||
              ""
            )
            .trim()
            .slice(0, 10000) ||
              null,
            JSON.stringify(
              request.body
                ?.metadata ||
              {}
            ),
          ]
        );

      response
        .status(201)
        .json({
          success: true,
          request:
            result.rows[0],
        });
    } catch (error) {
      next(error);
    }
  }
);


router.get(
  "/consents",
  async (
    request,
    response,
    next
  ) => {
    try {
      const userId =
        requireActor(
          request,
          response
        );

      if (!userId) return;

      const result =
        await query(
          `
            SELECT
              id,
              purpose_key
                AS "purposeKey",
              action,
              policy_version
                AS "policyVersion",
              source,
              recorded_at
                AS "recordedAt"

            FROM backend_consent_records

            WHERE organization_id =
                  $1

              AND user_id =
                  $2::uuid

            ORDER BY
              recorded_at DESC

            LIMIT 250
          `,
          [
            request.tenantContext
              .organizationId,
            userId,
          ]
        );

      response.json({
        success: true,
        consents:
          result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);


router.post(
  "/consents",
  async (
    request,
    response,
    next
  ) => {
    try {
      const userId =
        requireActor(
          request,
          response
        );

      if (!userId) return;

      const purposeKey =
        String(
          request.body
            ?.purposeKey ||
          ""
        )
        .trim()
        .toLowerCase();

      const action =
        String(
          request.body?.action ||
          ""
        )
        .trim();

      const policyVersion =
        String(
          request.body
            ?.policyVersion ||
          "goodos-privacy-v1"
        )
        .trim()
        .slice(0, 200);

      if (
        !/^[a-z0-9._-]{3,150}$/
          .test(
            purposeKey
          )
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Consent purpose key is invalid.",
          });
      }

      if (
        ![
          "granted",
          "withdrawn",
        ].includes(action)
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Consent action must be granted or withdrawn.",
          });
      }

      const result =
        await query(
          `
            INSERT INTO backend_consent_records (
              id,
              organization_id,
              project_id,
              environment_id,
              user_id,
              purpose_key,
              action,
              policy_version,
              source,
              ip_address,
              user_agent,
              metadata_json
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5::uuid,
              $6,
              $7,
              $8,
              'account',
              $9,
              $10,
              $11::jsonb
            )
            RETURNING
              id,
              purpose_key
                AS "purposeKey",
              action,
              policy_version
                AS "policyVersion",
              recorded_at
                AS "recordedAt"
          `,
          [
            identifier(
              "consent"
            ),
            request.tenantContext
              .organizationId,
            request.tenantContext
              .projectId,
            request.tenantContext
              .environmentId,
            userId,
            purposeKey,
            action,
            policyVersion,
            request.ip ||
              null,
            request.get(
              "user-agent"
            ) ||
              null,
            JSON.stringify(
              request.body
                ?.metadata ||
              {}
            ),
          ]
        );

      response
        .status(201)
        .json({
          success: true,
          consent:
            result.rows[0],
        });
    } catch (error) {
      next(error);
    }
  }
);


router.get(
  "/exports",
  async (
    request,
    response,
    next
  ) => {
    try {
      const userId =
        requireActor(
          request,
          response
        );

      if (!userId) return;

      const result =
        await query(
          `
            SELECT
              id,
              request_id
                AS "requestId",
              status,
              format,
              file_name
                AS "fileName",
              size_bytes
                AS "sizeBytes",
              checksum_sha256
                AS "checksumSha256",
              expires_at
                AS "expiresAt",
              completed_at
                AS "completedAt",
              downloaded_at
                AS "downloadedAt",
              created_at
                AS "createdAt"

            FROM backend_privacy_exports

            WHERE organization_id =
                  $1

              AND user_id =
                  $2::uuid

            ORDER BY
              created_at DESC

            LIMIT 100
          `,
          [
            request.tenantContext
              .organizationId,
            userId,
          ]
        );

      response.json({
        success: true,
        exports:
          result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);


router.post(
  "/exports",
  async (
    request,
    response,
    next
  ) => {
    try {
      const userId =
        requireActor(
          request,
          response
        );

      if (!userId) return;

      const organizationId =
        request.tenantContext
          .organizationId;

      const policyResult =
        await query(
          `
            SELECT
              privacy_export_retention_days
                AS "retentionDays"

            FROM backend_data_governance_policies

            WHERE organization_id =
                  $1
          `,
          [
            organizationId,
          ]
        );

      const retentionDays =
        Number(
          policyResult.rows[0]
            ?.retentionDays ||
          30
        );

      const exportId =
        identifier(
          "privacy_export"
        );

      const fileName =
        `${exportId}.json`;

      const filePath =
        path.join(
          EXPORT_ROOT,
          fileName
        );

      fs.mkdirSync(
        EXPORT_ROOT,
        {
          recursive:
            true,
          mode:
            0o700,
        }
      );

      const [
        profile,
        appMemberships,
        organizationMemberships,
        projectMemberships,
        teamMemberships,
        preferences,
        sessions,
        authEvents,
        consentRecords,
        subjectRequests,
        closureRequests,
      ] =
        await Promise.all([
          query(
            `
              SELECT
                to_jsonb(account)
                  - ARRAY[
                      'password',
                      'password_hash',
                      'mfa_secret',
                      'totp_secret',
                      'recovery_codes',
                      'reset_token',
                      'verification_token'
                    ]::text[]
                  AS profile

              FROM users
                   AS account

              WHERE account.id =
                    $1::uuid
            `,
            [
              userId,
            ]
          ),

          query(
            `
              SELECT to_jsonb(membership)
                       AS record
              FROM app_memberships
                   AS membership
              WHERE membership.user_id =
                    $1::uuid
            `,
            [
              userId,
            ]
          ),

          query(
            `
              SELECT to_jsonb(membership)
                       AS record
              FROM backend_organization_memberships
                   AS membership
              WHERE membership.user_id =
                    $1::uuid
            `,
            [
              userId,
            ]
          ),

          query(
            `
              SELECT to_jsonb(membership)
                       AS record
              FROM backend_project_memberships
                   AS membership
              WHERE membership.user_id =
                    $1::uuid
            `,
            [
              userId,
            ]
          ),

          query(
            `
              SELECT to_jsonb(membership)
                       AS record
              FROM backend_team_memberships
                   AS membership
              WHERE membership.user_id =
                    $1::uuid
            `,
            [
              userId,
            ]
          ),

          query(
            `
              SELECT to_jsonb(preference)
                       AS record
              FROM backend_user_preferences
                   AS preference
              WHERE preference.user_id =
                    $1::uuid
            `,
            [
              userId,
            ]
          ),

          query(
            `
              SELECT
                to_jsonb(session_record)
                  - ARRAY[
                      'token',
                      'token_hash',
                      'session_token',
                      'refresh_token',
                      'refresh_token_hash'
                    ]::text[]
                  AS record

              FROM sessions
                   AS session_record

              WHERE session_record.user_id =
                    $1::uuid
            `,
            [
              userId,
            ]
          ),

          query(
            `
              SELECT to_jsonb(event_record)
                       AS record
              FROM backend_auth_audit_events
                   AS event_record
              WHERE event_record.user_id =
                    $1::uuid
              ORDER BY
                event_record.created_at DESC
              LIMIT 1000
            `,
            [
              userId,
            ]
          ),

          query(
            `
              SELECT to_jsonb(consent_record)
                       AS record
              FROM backend_consent_records
                   AS consent_record
              WHERE consent_record.user_id =
                    $1::uuid
              ORDER BY
                consent_record.recorded_at DESC
            `,
            [
              userId,
            ]
          ),

          query(
            `
              SELECT to_jsonb(request_record)
                       AS record
              FROM backend_data_subject_requests
                   AS request_record
              WHERE request_record.user_id =
                    $1::uuid
              ORDER BY
                request_record.created_at DESC
            `,
            [
              userId,
            ]
          ),

          query(
            `
              SELECT to_jsonb(closure_record)
                       AS record
              FROM backend_account_closure_requests
                   AS closure_record
              WHERE closure_record.user_id =
                    $1::uuid
              ORDER BY
                closure_record.created_at DESC
            `,
            [
              userId,
            ]
          ),
        ]);

      const payload = {
        schema:
          "goodos.privacy.export.v1",
        exportId,
        generatedAt:
          new Date()
            .toISOString(),
        organizationId,
        userId,
        profile:
          profile.rows[0]
            ?.profile ||
          null,
        memberships: {
          applications:
            appMemberships.rows.map(
              row => row.record
            ),
          organizations:
            organizationMemberships.rows.map(
              row => row.record
            ),
          projects:
            projectMemberships.rows.map(
              row => row.record
            ),
          teams:
            teamMemberships.rows.map(
              row => row.record
            ),
        },
        preferences:
          preferences.rows.map(
            row => row.record
          ),
        sessions:
          sessions.rows.map(
            row => row.record
          ),
        authenticationEvents:
          authEvents.rows.map(
            row => row.record
          ),
        consentHistory:
          consentRecords.rows.map(
            row => row.record
          ),
        dataSubjectRequests:
          subjectRequests.rows.map(
            row => row.record
          ),
        accountClosureRequests:
          closureRequests.rows.map(
            row => row.record
          ),
        excludedData: [
          "password hashes",
          "authentication secrets",
          "API-key secrets",
          "storage objects",
          "webhook secrets",
          "encryption keys",
        ],
      };

      const serialized =
        JSON.stringify(
          payload,
          null,
          2
        ) + "\n";

      fs.writeFileSync(
        filePath,
        serialized,
        {
          mode:
            0o600,
        }
      );

      const checksum =
        crypto
          .createHash("sha256")
          .update(
            serialized
          )
          .digest("hex");

      const stat =
        fs.statSync(
          filePath
        );

      const result =
        await query(
          `
            INSERT INTO backend_privacy_exports (
              id,
              organization_id,
              project_id,
              environment_id,
              user_id,
              request_id,
              status,
              format,
              file_name,
              file_path,
              size_bytes,
              checksum_sha256,
              expires_at,
              completed_at,
              metadata_json
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5::uuid,
              $6,
              'completed',
              'json',
              $7,
              $8,
              $9,
              $10,
              NOW() +
                make_interval(
                  days => $11
                ),
              NOW(),
              jsonb_build_object(
                'schema',
                'goodos.privacy.export.v1',
                'secretValuesExcluded',
                true
              )
            )
            RETURNING
              id,
              status,
              file_name
                AS "fileName",
              size_bytes
                AS "sizeBytes",
              checksum_sha256
                AS "checksumSha256",
              expires_at
                AS "expiresAt",
              completed_at
                AS "completedAt"
          `,
          [
            exportId,
            organizationId,
            request.tenantContext
              .projectId,
            request.tenantContext
              .environmentId,
            userId,
            request.body
              ?.requestId ||
              null,
            fileName,
            filePath,
            stat.size,
            checksum,
            retentionDays,
          ]
        );

      response
        .status(201)
        .json({
          success: true,
          export:
            result.rows[0],
        });
    } catch (error) {
      next(error);
    }
  }
);


router.get(
  "/exports/:exportId/download",
  async (
    request,
    response,
    next
  ) => {
    try {
      const userId =
        requireActor(
          request,
          response
        );

      if (!userId) return;

      const result =
        await query(
          `
            SELECT
              id,
              file_name
                AS "fileName",
              file_path
                AS "filePath"

            FROM backend_privacy_exports

            WHERE id =
                  $1

              AND organization_id =
                  $2

              AND user_id =
                  $3::uuid

              AND status =
                  'completed'

              AND expires_at >
                  NOW()

            LIMIT 1
          `,
          [
            request.params
              .exportId,
            request.tenantContext
              .organizationId,
            userId,
          ]
        );

      const exportRecord =
        result.rows[0];

      if (!exportRecord) {
        return response
          .status(404)
          .json({
            success: false,
            message:
              "Privacy export was not found or has expired.",
          });
      }

      const resolvedPath =
        path.resolve(
          exportRecord.filePath
        );

      const insideRoot =
        resolvedPath ===
          EXPORT_ROOT ||
        resolvedPath.startsWith(
          EXPORT_ROOT +
          path.sep
        );

      if (
        !insideRoot ||
        !fs.existsSync(
          resolvedPath
        )
      ) {
        return response
          .status(404)
          .json({
            success: false,
            message:
              "Privacy export file is unavailable.",
          });
      }

      await query(
        `
          UPDATE backend_privacy_exports

          SET
            downloaded_at =
              NOW(),

            updated_at =
              NOW()

          WHERE id =
                $1
        `,
        [
          exportRecord.id,
        ]
      );

      response.setHeader(
        "Content-Type",
        "application/json"
      );

      response.setHeader(
        "Content-Disposition",
        `attachment; filename="${exportRecord.fileName}"`
      );

      response.setHeader(
        "Cache-Control",
        "private, no-store"
      );

      return response.sendFile(
        resolvedPath
      );
    } catch (error) {
      next(error);
    }
  }
);


router.get(
  "/account-closure",
  async (
    request,
    response,
    next
  ) => {
    try {
      const userId =
        requireActor(
          request,
          response
        );

      if (!userId) return;

      const result =
        await query(
          `
            SELECT
              id,
              status,
              reason,
              identity_verified_at
                AS "identityVerifiedAt",
              reviewed_at
                AS "reviewedAt",
              review_notes
                AS "reviewNotes",
              requested_at
                AS "requestedAt",
              updated_at
                AS "updatedAt"

            FROM backend_account_closure_requests

            WHERE organization_id =
                  $1

              AND user_id =
                  $2::uuid

            ORDER BY
              requested_at DESC

            LIMIT 25
          `,
          [
            request.tenantContext
              .organizationId,
            userId,
          ]
        );

      response.json({
        success: true,
        accountClosureRequests:
          result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);


router.post(
  "/account-closure",
  async (
    request,
    response,
    next
  ) => {
    try {
      const userId =
        requireActor(
          request,
          response
        );

      if (!userId) return;

      const result =
        await query(
          `
            INSERT INTO backend_account_closure_requests (
              id,
              organization_id,
              project_id,
              environment_id,
              user_id,
              status,
              reason,
              requested_by,
              metadata_json
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5::uuid,
              'requested',
              $6,
              $5::uuid,
              jsonb_build_object(
                'closureExecution',
                'requires_explicit_administrative_approval'
              )
            )
            RETURNING
              id,
              status,
              requested_at
                AS "requestedAt"
          `,
          [
            identifier(
              "closure"
            ),
            request.tenantContext
              .organizationId,
            request.tenantContext
              .projectId,
            request.tenantContext
              .environmentId,
            userId,
            String(
              request.body
                ?.reason ||
              ""
            )
            .trim()
            .slice(0, 5000) ||
              null,
          ]
        );

      response
        .status(201)
        .json({
          success: true,
          accountClosureRequest:
            result.rows[0],
        });
    } catch (error) {
      next(error);
    }
  }
);


router.get(
  "/admin/legal-holds",
  privacyAdminRequired,
  async (
    request,
    response,
    next
  ) => {
    try {
      const result =
        await query(
          `
            SELECT
              id,
              scope_type
                AS "scopeType",
              scope_id
                AS "scopeId",
              title,
              reason,
              status,
              released_at
                AS "releasedAt",
              release_notes
                AS "releaseNotes",
              created_at
                AS "createdAt",
              updated_at
                AS "updatedAt"

            FROM backend_legal_holds

            WHERE organization_id =
                  $1

            ORDER BY
              created_at DESC
          `,
          [
            request.tenantContext
              .organizationId,
          ]
        );

      response.json({
        success: true,
        legalHolds:
          result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);


router.post(
  "/admin/legal-holds",
  privacyAdminRequired,
  async (
    request,
    response,
    next
  ) => {
    try {
      const scopeType =
        String(
          request.body
            ?.scopeType ||
          ""
        )
        .trim();

      const title =
        String(
          request.body?.title ||
          ""
        )
        .trim()
        .slice(0, 500);

      const reason =
        String(
          request.body?.reason ||
          ""
        )
        .trim()
        .slice(0, 10000);

      if (
        ![
          "organization",
          "user",
          "request",
          "table",
        ].includes(
          scopeType
        ) ||
        !title ||
        !reason
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Valid legal-hold scope, title, and reason are required.",
          });
      }

      const result =
        await query(
          `
            INSERT INTO backend_legal_holds (
              id,
              organization_id,
              project_id,
              environment_id,
              scope_type,
              scope_id,
              title,
              reason,
              status,
              created_by,
              metadata_json
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5,
              $6,
              $7,
              $8,
              'active',
              $9::uuid,
              $10::jsonb
            )
            RETURNING
              id,
              scope_type
                AS "scopeType",
              scope_id
                AS "scopeId",
              title,
              status,
              created_at
                AS "createdAt"
          `,
          [
            identifier(
              "hold"
            ),
            request.tenantContext
              .organizationId,
            request.tenantContext
              .projectId,
            request.tenantContext
              .environmentId,
            scopeType,
            String(
              request.body
                ?.scopeId ||
              ""
            )
            .trim()
            .slice(0, 500) ||
              null,
            title,
            reason,
            actorId(request),
            JSON.stringify(
              request.body
                ?.metadata ||
              {}
            ),
          ]
        );

      response
        .status(201)
        .json({
          success: true,
          legalHold:
            result.rows[0],
        });
    } catch (error) {
      if (
        error.code ===
        "23505"
      ) {
        return response
          .status(409)
          .json({
            success: false,
            message:
              "An active legal hold already exists for this scope.",
          });
      }

      next(error);
    }
  }
);


router.patch(
  "/admin/legal-holds/:holdId/release",
  privacyAdminRequired,
  async (
    request,
    response,
    next
  ) => {
    try {
      const result =
        await query(
          `
            UPDATE backend_legal_holds

            SET
              status =
                'released',

              released_by =
                $3::uuid,

              released_at =
                NOW(),

              release_notes =
                $4,

              updated_at =
                NOW()

            WHERE id =
                  $1

              AND organization_id =
                  $2

              AND status =
                  'active'

            RETURNING
              id,
              status,
              released_at
                AS "releasedAt",
              release_notes
                AS "releaseNotes"
          `,
          [
            request.params
              .holdId,
            request.tenantContext
              .organizationId,
            actorId(request),
            String(
              request.body
                ?.releaseNotes ||
              ""
            )
            .trim()
            .slice(0, 5000) ||
              null,
          ]
        );

      if (
        result.rowCount === 0
      ) {
        return response
          .status(404)
          .json({
            success: false,
            message:
              "Active legal hold was not found.",
          });
      }

      response.json({
        success: true,
        legalHold:
          result.rows[0],
      });
    } catch (error) {
      next(error);
    }
  }
);


router.patch(
  "/admin/requests/:requestId/status",
  privacyAdminRequired,
  async (
    request,
    response,
    next
  ) => {
    try {
      const status =
        String(
          request.body?.status ||
          ""
        )
        .trim();

      if (
        ![
          "submitted",
          "identity_verification",
          "in_review",
          "approved",
          "rejected",
          "fulfilled",
          "cancelled",
        ].includes(status)
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Invalid data-subject request status.",
          });
      }

      const result =
        await query(
          `
            UPDATE backend_data_subject_requests

            SET
              status =
                $3,

              assigned_to =
                COALESCE(
                  assigned_to,
                  $4::uuid
                ),

              identity_verified_at =
                CASE
                  WHEN $3 IN (
                    'in_review',
                    'approved',
                    'rejected',
                    'fulfilled'
                  )
                  THEN COALESCE(
                    identity_verified_at,
                    NOW()
                  )
                  ELSE identity_verified_at
                END,

              fulfilled_at =
                CASE
                  WHEN $3 =
                       'fulfilled'
                  THEN NOW()
                  ELSE fulfilled_at
                END,

              response_notes =
                $5,

              updated_at =
                NOW()

            WHERE id =
                  $1

              AND organization_id =
                  $2

            RETURNING
              id,
              request_type
                AS "requestType",
              status,
              fulfilled_at
                AS "fulfilledAt",
              updated_at
                AS "updatedAt"
          `,
          [
            request.params
              .requestId,
            request.tenantContext
              .organizationId,
            status,
            actorId(request),
            String(
              request.body
                ?.responseNotes ||
              ""
            )
            .trim()
            .slice(0, 10000) ||
              null,
          ]
        );

      if (
        result.rowCount === 0
      ) {
        return response
          .status(404)
          .json({
            success: false,
            message:
              "Data-subject request was not found.",
          });
      }

      response.json({
        success: true,
        request:
          result.rows[0],
      });
    } catch (error) {
      next(error);
    }
  }
);


router.patch(
  "/admin/account-closures/:closureId/status",
  privacyAdminRequired,
  async (
    request,
    response,
    next
  ) => {
    try {
      const status =
        String(
          request.body?.status ||
          ""
        )
        .trim();

      if (
        ![
          "requested",
          "identity_verification",
          "approved",
          "rejected",
          "cancelled",
        ].includes(status)
      ) {
        return response
          .status(400)
          .json({
            success: false,
            message:
              "Invalid account-closure status.",
          });
      }

      const result =
        await query(
          `
            UPDATE backend_account_closure_requests

            SET
              status =
                $3,

              identity_verified_at =
                CASE
                  WHEN $3 IN (
                    'approved',
                    'rejected'
                  )
                  THEN COALESCE(
                    identity_verified_at,
                    NOW()
                  )
                  ELSE identity_verified_at
                END,

              reviewed_by =
                $4::uuid,

              review_notes =
                $5,

              reviewed_at =
                NOW(),

              updated_at =
                NOW()

            WHERE id =
                  $1

              AND organization_id =
                  $2

            RETURNING
              id,
              status,
              reviewed_at
                AS "reviewedAt",
              review_notes
                AS "reviewNotes"
          `,
          [
            request.params
              .closureId,
            request.tenantContext
              .organizationId,
            status,
            actorId(request),
            String(
              request.body
                ?.reviewNotes ||
              ""
            )
            .trim()
            .slice(0, 5000) ||
              null,
          ]
        );

      if (
        result.rowCount === 0
      ) {
        return response
          .status(404)
          .json({
            success: false,
            message:
              "Account-closure request was not found.",
          });
      }

      response.json({
        success: true,
        accountClosureRequest:
          result.rows[0],
      });
    } catch (error) {
      if (
        error.code ===
        "23514"
      ) {
        return response
          .status(409)
          .json({
            success: false,
            message:
              error.message,
          });
      }

      next(error);
    }
  }
);


router.get(
  "/admin/retention-runs",
  privacyAdminRequired,
  async (
    request,
    response,
    next
  ) => {
    try {
      const result =
        await query(
          `
            SELECT
              id,
              status,
              dry_run
                AS "dryRun",
              legal_hold_count
                AS "legalHoldCount",
              rows_affected
                AS "rowsAffected",
              summary_json
                AS summary,
              error_message
                AS "errorMessage",
              started_at
                AS "startedAt",
              completed_at
                AS "completedAt"

            FROM backend_retention_runs

            WHERE organization_id =
                  $1

            ORDER BY
              started_at DESC

            LIMIT 100
          `,
          [
            request.tenantContext
              .organizationId,
          ]
        );

      response.json({
        success: true,
        retentionRuns:
          result.rows,
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports =
  router;
