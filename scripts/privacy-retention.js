"use strict";

const crypto =
  require("crypto");

const fs =
  require("fs");

const path =
  require("path");

const database =
  require("../src/config/database");

const {
  query,
} = database;

const EXPORT_ROOT =
  "/var/lib/goodos/privacy/exports";

const dryRun =
  process.env
    .GOODOS_RETENTION_DRY_RUN ===
  "1";

function identifier(
  prefix
) {
  return (
    `${prefix}_` +
    crypto.randomUUID()
      .replaceAll("-", "")
  );
}

async function tableHasColumns(
  tableName,
  columns
) {
  const result =
    await query(
      `
        SELECT column_name

        FROM information_schema.columns

        WHERE table_schema =
              'public'

          AND table_name =
              $1

          AND column_name =
              ANY($2::text[])
      `,
      [
        tableName,
        columns,
      ]
    );

  const found =
    new Set(
      result.rows.map(
        row =>
          row.column_name
      )
    );

  return columns.every(
    column =>
      found.has(column)
  );
}

async function processRule(
  rule
) {
  const available =
    await tableHasColumns(
      rule.table,
      rule.requiredColumns
    );

  if (!available) {
    return {
      table:
        rule.table,
      status:
        "skipped",
      reason:
        "required_columns_missing",
      rows:
        0,
    };
  }

  const countResult =
    await query(
      `
        SELECT COUNT(*)::int
                 AS count

        FROM ${rule.table}

        WHERE ${rule.where}
      `,
      rule.parameters
    );

  const matchingRows =
    Number(
      countResult.rows[0]
        ?.count || 0
    );

  if (
    !dryRun &&
    matchingRows > 0
  ) {
    await query(
      `
        DELETE FROM ${rule.table}

        WHERE ${rule.where}
      `,
      rule.parameters
    );
  }

  return {
    table:
      rule.table,
    status:
      dryRun
        ? "dry_run"
        : "completed",
    rows:
      matchingRows,
  };
}

async function expirePrivacyExports(
  policy
) {
  const result =
    await query(
      `
        SELECT
          id,
          file_path
            AS "filePath"

        FROM backend_privacy_exports

        WHERE status =
              'completed'

          AND expires_at <=
              NOW()
      `
    );

  let affected =
    0;

  for (const row of result.rows) {
    if (!dryRun) {
      const resolved =
        row.filePath
          ? path.resolve(
              row.filePath
            )
          : null;

      const insideRoot =
        resolved &&
        (
          resolved ===
            EXPORT_ROOT
          ||
          resolved.startsWith(
            EXPORT_ROOT +
            path.sep
          )
        );

      if (
        insideRoot &&
        fs.existsSync(resolved)
      ) {
        fs.unlinkSync(resolved);
      }

      await query(
        `
          UPDATE backend_privacy_exports

          SET
            status =
              'expired',

            file_deleted_at =
              NOW(),

            updated_at =
              NOW()

          WHERE id =
                $1
        `,
        [
          row.id,
        ]
      );
    }

    affected++;
  }

  return {
    table:
      "backend_privacy_exports",
    status:
      dryRun
        ? "dry_run"
        : "completed",
    rows:
      affected,
    retentionDays:
      policy.privacyExportRetentionDays,
  };
}

async function main() {
  const policyResult =
    await query(
      `
        SELECT
          organization_id
            AS "organizationId",

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

          legal_hold_enabled
            AS "legalHoldEnabled",

          automated_retention_enabled
            AS "automatedRetentionEnabled"

        FROM backend_data_governance_policies

        ORDER BY created_at ASC

        LIMIT 1
      `
    );

  const policy =
    policyResult.rows[0];

  if (!policy) {
    throw new Error(
      "Phase 9 data-governance policy is missing."
    );
  }

  const tenantResult =
    await query(
      `
        SELECT
          project.id
            AS "projectId",

          environment.id
            AS "environmentId"

        FROM backend_projects
             AS project

        JOIN backend_project_environments
             AS environment
          ON environment.project_id =
             project.id

        WHERE project.organization_id =
              $1

          AND environment.type =
              'production'

          AND environment.status =
              'active'

        ORDER BY
          project.created_at ASC,
          environment.created_at ASC

        LIMIT 1
      `,
      [
        policy.organizationId,
      ]
    );

  const tenant =
    tenantResult.rows[0];

  if (
    !tenant?.projectId ||
    !tenant?.environmentId
  ) {
    throw new Error(
      "Retention tenant context is incomplete."
    );
  }

  const runId =
    identifier(
      "retention"
    );

  await query(
    `
      INSERT INTO backend_retention_runs (
        id,
        organization_id,
        project_id,
        environment_id,
        status,
        dry_run
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        'running',
        $5
      )
    `,
    [
      runId,
      policy.organizationId,
      tenant.projectId,
      tenant.environmentId,
      dryRun,
    ]
  );

  try {
    if (
      !policy
        .automatedRetentionEnabled
    ) {
      await query(
        `
          UPDATE backend_retention_runs

          SET
            status =
              'blocked',

            summary_json =
              jsonb_build_object(
                'reason',
                'automated_retention_disabled'
              ),

            completed_at =
              NOW()

          WHERE id =
                $1
        `,
        [
          runId,
        ]
      );

      console.log(
        JSON.stringify({
          success:
            true,
          status:
            "blocked",
          reason:
            "automated_retention_disabled",
          runId,
        })
      );

      return;
    }

    const holdResult =
      await query(
        `
          SELECT COUNT(*)::int
                   AS count

          FROM backend_legal_holds

          WHERE organization_id =
                $1

            AND status =
                'active'
        `,
        [
          policy.organizationId,
        ]
      );

    const legalHoldCount =
      Number(
        holdResult.rows[0]
          ?.count || 0
      );

    if (
      policy.legalHoldEnabled &&
      legalHoldCount > 0
    ) {
      await query(
        `
          UPDATE backend_retention_runs

          SET
            status =
              'blocked',

            legal_hold_count =
              $2,

            summary_json =
              jsonb_build_object(
                'reason',
                'active_legal_hold'
              ),

            completed_at =
              NOW()

          WHERE id =
                $1
        `,
        [
          runId,
          legalHoldCount,
        ]
      );

      console.log(
        JSON.stringify({
          success:
            true,
          status:
            "blocked",
          reason:
            "active_legal_hold",
          legalHoldCount,
          runId,
        })
      );

      return;
    }

    const rules = [
      {
        table:
          "sessions",
        requiredColumns: [
          "expires_at",
          "revoked_at",
        ],
        where: `
          (
            revoked_at IS NOT NULL
            OR expires_at <= NOW()
          )
          AND COALESCE(
                revoked_at,
                expires_at
              ) <
              NOW() -
              make_interval(
                days => $1
              )
        `,
        parameters: [
          Number(
            policy.sessionRetentionDays
          ),
        ],
      },
      {
        table:
          "backend_auth_refresh_tokens",
        requiredColumns: [
          "expires_at",
          "revoked_at",
        ],
        where: `
          (
            revoked_at IS NOT NULL
            OR expires_at <= NOW()
          )
          AND COALESCE(
                revoked_at,
                expires_at
              ) <
              NOW() -
              make_interval(
                days => $1
              )
        `,
        parameters: [
          Number(
            policy.sessionRetentionDays
          ),
        ],
      },
      {
        table:
          "backend_mfa_challenges",
        requiredColumns: [
          "expires_at",
        ],
        where: `
          expires_at <
          NOW() -
          make_interval(
            days => $1
          )
        `,
        parameters: [
          Number(
            policy.authTokenRetentionDays
          ),
        ],
      },
      {
        table:
          "backend_password_reset_tokens",
        requiredColumns: [
          "expires_at",
        ],
        where: `
          expires_at <
          NOW() -
          make_interval(
            days => $1
          )
        `,
        parameters: [
          Number(
            policy.authTokenRetentionDays
          ),
        ],
      },
      {
        table:
          "backend_email_verification_tokens",
        requiredColumns: [
          "expires_at",
        ],
        where: `
          expires_at <
          NOW() -
          make_interval(
            days => $1
          )
        `,
        parameters: [
          Number(
            policy.authTokenRetentionDays
          ),
        ],
      },
      {
        table:
          "backend_storage_signed_urls",
        requiredColumns: [
          "expires_at",
          "revoked_at",
        ],
        where: `
          (
            revoked_at IS NOT NULL
            OR expires_at <= NOW()
          )
          AND COALESCE(
                revoked_at,
                expires_at
              ) <
              NOW() -
              make_interval(
                days => $1
              )
        `,
        parameters: [
          Number(
            policy.signedUrlRetentionDays
          ),
        ],
      },
      {
        table:
          "backend_operations_checks",
        requiredColumns: [
          "checked_at",
        ],
        where: `
          checked_at <
          NOW() -
          make_interval(
            days => $1
          )
        `,
        parameters: [
          Number(
            policy.operationsCheckRetentionDays
          ),
        ],
      },
      {
        table:
          "backend_metric_buckets",
        requiredColumns: [
          "minute_start",
        ],
        where: `
          minute_start <
          NOW() -
          make_interval(
            days => $1
          )
        `,
        parameters: [
          Number(
            policy.metricRetentionDays
          ),
        ],
      },
      {
        table:
          "backend_data_subject_requests",
        requiredColumns: [
          "status",
          "updated_at",
        ],
        where: `
          status IN (
            'rejected',
            'fulfilled',
            'cancelled'
          )
          AND updated_at <
              NOW() -
              make_interval(
                days => $1
              )
        `,
        parameters: [
          Number(
            policy.requestRetentionDays
          ),
        ],
      },
      {
        table:
          "backend_account_closure_requests",
        requiredColumns: [
          "status",
          "updated_at",
        ],
        where: `
          status IN (
            'rejected',
            'cancelled'
          )
          AND updated_at <
              NOW() -
              make_interval(
                days => $1
              )
        `,
        parameters: [
          Number(
            policy.requestRetentionDays
          ),
        ],
      },
    ];

    const results = [];

    for (const rule of rules) {
      results.push(
        await processRule(
          rule
        )
      );
    }

    results.push(
      await expirePrivacyExports(
        policy
      )
    );

    const rowsAffected =
      results.reduce(
        (
          total,
          result
        ) =>
          total +
          Number(
            result.rows || 0
          ),
        0
      );

    await query(
      `
        UPDATE backend_retention_runs

        SET
          status =
            'completed',

          rows_affected =
            $2,

          summary_json =
            $3::jsonb,

          completed_at =
            NOW()

        WHERE id =
              $1
      `,
      [
        runId,
        rowsAffected,
        JSON.stringify({
          dryRun,
          results,
          customerContentDeleted:
            false,
          auditEvidenceDeleted:
            false,
          releaseEvidenceDeleted:
            false,
          backupEvidenceDeleted:
            false,
        }),
      ]
    );

    console.log(
      JSON.stringify(
        {
          success:
            true,
          status:
            "completed",
          runId,
          dryRun,
          rowsAffected,
          results,
        },
        null,
        2
      )
    );
  } catch (error) {
    await query(
      `
        UPDATE backend_retention_runs

        SET
          status =
            'failed',

          error_message =
            $2,

          completed_at =
            NOW()

        WHERE id =
              $1
      `,
      [
        runId,
        error.message,
      ]
    ).catch(() => {});

    throw error;
  }
}

main()
  .catch(error => {
    console.error(
      "GoodOS privacy retention failed:",
      error
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    if (
      database.pool &&
      typeof database.pool.end ===
        "function"
    ) {
      await database.pool.end();
    }
  });
