"use strict";

const crypto = require("crypto");
const fs = require("fs");
const {
  execFileSync,
} = require("child_process");

const {
  query,
} = require("../src/config/database");

const jobService =
  require("../src/services/job.service");

function identifier(
  prefix
) {
  return (
    `${prefix}_` +
    crypto.randomUUID()
      .replaceAll("-", "")
  );
}

async function fetchJson(
  url,
  timeoutMs = 10000
) {
  const startedAt =
    Date.now();

  const response =
    await fetch(url, {
      signal:
        AbortSignal.timeout(
          timeoutMs
        ),
      headers: {
        "User-Agent":
          "GoodOS-Operations-Check/1.0",
      },
    });

  const body =
    await response.json();

  if (!response.ok) {
    throw new Error(
      `${url} returned HTTP ${response.status}`
    );
  }

  return {
    body,
    durationMs:
      Date.now() - startedAt,
  };
}

function diskUsagePercent(
  targetPath
) {
  const stats =
    fs.statfsSync(targetPath);

  const total =
    Number(stats.blocks);

  const available =
    Number(stats.bavail);

  if (!total) {
    return 0;
  }

  return (
    (
      total - available
    ) /
    total
  ) * 100;
}

function timerActive(
  unitName
) {
  try {
    execFileSync(
      "systemctl",
      [
        "is-active",
        "--quiet",
        unitName,
      ],
      {
        stdio:
          "ignore",
        timeout:
          5000,
      }
    );

    return true;
  } catch {
    return false;
  }
}

async function main() {
  const policyResult =
    await query(
      `
        SELECT
          organization_id
            AS "organizationId",

          backup_warning_hours
            AS "backupWarningHours",

          backup_critical_hours
            AS "backupCriticalHours",

          worker_heartbeat_max_seconds
            AS "workerHeartbeatMaxSeconds",

          disk_warning_percent
            AS "diskWarningPercent",

          disk_critical_percent
            AS "diskCriticalPercent",

          error_rate_warning_percent
            AS "errorRateWarningPercent",

          error_rate_critical_percent
            AS "errorRateCriticalPercent",

          operations_check_retention_days
            AS "operationsCheckRetentionDays",

          incident_auto_create
            AS "incidentAutoCreate"

        FROM backend_operations_policies

        ORDER BY created_at ASC

        LIMIT 1
      `
    );

  const policy =
    policyResult.rows[0];

  if (!policy) {
    throw new Error(
      "Phase 7 operations policy is missing."
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

        LEFT JOIN LATERAL (
          SELECT id
          FROM backend_project_environments
          WHERE project_id =
                project.id
            AND type =
                'production'
            AND status =
                'active'
          ORDER BY created_at ASC
          LIMIT 1
        ) AS environment
          ON true

        WHERE project.organization_id =
              $1

        ORDER BY project.created_at ASC

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
      "Operations tenant context is incomplete."
    );
  }

  const checks = [];

  try {
    const health =
      await fetchJson(
        "http://127.0.0.1:8001/health"
      );

    const readiness =
      await fetchJson(
        "http://127.0.0.1:8001/api/enterprise/ready"
      );

    const healthy =
      health.body?.status === "ok" &&
      readiness.body?.status === "ready";

    checks.push({
      checkKey:
        "backend_readiness",
      category:
        "availability",
      status:
        healthy
          ? "healthy"
          : "critical",
      message:
        healthy
          ? "Backend health and enterprise readiness passed."
          : "Backend health or enterprise readiness failed.",
      durationMs:
        health.durationMs +
        readiness.durationMs,
      evidence: {
        health:
          health.body?.status,
        readiness:
          readiness.body?.status,
      },
    });
  } catch (error) {
    checks.push({
      checkKey:
        "backend_readiness",
      category:
        "availability",
      status:
        "critical",
      message:
        error.message,
      evidence: {
        error:
          error.message,
      },
    });
  }

  try {
    const fleet =
      await fetchJson(
        "http://127.0.0.1:3000/api/system-health?refresh=1",
        30000
      );

    const summary =
      fleet.body?.summary || {};

    const total =
      Number(
        summary.total || 0
      );

    const live =
      Number(
        summary.live || 0
      );

    const degraded =
      Number(
        summary.degraded || 0
      );

    const offline =
      Number(
        summary.offline || 0
      );

    let status =
      "healthy";

    if (
      total < 1 ||
      offline > 0 ||
      live !== total
    ) {
      status =
        "critical";
    } else if (
      degraded > 0
    ) {
      status =
        "warning";
    }

    checks.push({
      checkKey:
        "application_fleet",
      category:
        "availability",
      status,
      message:
        `${live} of ${total} registered applications are live.`,
      durationMs:
        fleet.durationMs,
      evidence: {
        total,
        live,
        degraded,
        offline,
        source:
          fleet.body?.source,
      },
    });
  } catch (error) {
    checks.push({
      checkKey:
        "application_fleet",
      category:
        "availability",
      status:
        "critical",
      message:
        error.message,
      evidence: {
        error:
          error.message,
      },
    });
  }

  try {
    const snapshot =
      await jobService
        .getJobsSnapshot();

    const counts =
      snapshot.counts || {};

    const healthy =
      Number(
        counts.onlineWorkers || 0
      ) >= 1 &&
      Number(
        counts.failedRuns || 0
      ) === 0;

    checks.push({
      checkKey:
        "worker_heartbeat",
      category:
        "jobs",
      status:
        healthy
          ? "healthy"
          : "critical",
      message:
        healthy
          ? "Dedicated worker and scheduled jobs are healthy."
          : "Worker or scheduled job health is degraded.",
      evidence:
        counts,
    });
  } catch (error) {
    checks.push({
      checkKey:
        "worker_heartbeat",
      category:
        "jobs",
      status:
        "critical",
      message:
        error.message,
      evidence: {
        error:
          error.message,
      },
    });
  }

  const backupResult =
    await query(
      `
        SELECT MAX(completed_at)
                 AS "completedAt"

        FROM (
          SELECT
            COALESCE(
              verified_at,
              created_at
            ) AS completed_at

          FROM backend_database_backups

          WHERE status =
                'completed'

          UNION ALL

          SELECT
            COALESCE(
              completed_at,
              created_at
            ) AS completed_at

          FROM backend_backup_inventory

          WHERE status =
                'completed'
        ) AS completed_backups
      `
    );

  const completedAt =
    backupResult.rows[0]
      ?.completedAt || null;

  let backupAgeHours =
    null;

  let backupStatus =
    "critical";

  if (completedAt) {
    backupAgeHours =
      (
        Date.now() -
        new Date(
          completedAt
        ).getTime()
      ) /
      3600000;

    backupStatus =
      backupAgeHours >=
      Number(
        policy.backupCriticalHours
      )
        ? "critical"
        : backupAgeHours >=
          Number(
            policy.backupWarningHours
          )
          ? "warning"
          : "healthy";
  }

  checks.push({
    checkKey:
      "backup_freshness",
    category:
      "recovery",
    status:
      backupStatus,
    message:
      completedAt
        ? `Latest completed backup is ${backupAgeHours.toFixed(2)} hours old.`
        : "No completed backup record was found.",
    evidence: {
      completedAt,
      backupAgeHours,
      warningHours:
        policy.backupWarningHours,
      criticalHours:
        policy.backupCriticalHours,
    },
  });

  const diskPercent =
    diskUsagePercent("/");

  const diskStatus =
    diskPercent >=
    Number(
      policy.diskCriticalPercent
    )
      ? "critical"
      : diskPercent >=
        Number(
          policy.diskWarningPercent
        )
        ? "warning"
        : "healthy";

  checks.push({
    checkKey:
      "disk_capacity",
    category:
      "capacity",
    status:
      diskStatus,
    message:
      `Root filesystem utilization is ${diskPercent.toFixed(2)}%.`,
    evidence: {
      diskPercent,
      warningPercent:
        policy.diskWarningPercent,
      criticalPercent:
        policy.diskCriticalPercent,
    },
  });

  const metricResult =
    await query(
      `
        SELECT
          COALESCE(
            SUM(request_count),
            0
          )::bigint
            AS "requestCount",

          COALESCE(
            SUM(error_count),
            0
          )::bigint
            AS "errorCount"

        FROM backend_metric_buckets

        WHERE minute_start >=
              NOW() -
              INTERVAL '15 minutes'
      `
    );

  const requestCount =
    Number(
      metricResult.rows[0]
        ?.requestCount || 0
    );

  const errorCount =
    Number(
      metricResult.rows[0]
        ?.errorCount || 0
    );

  const errorRate =
    requestCount > 0
      ? (
          errorCount /
          requestCount
        ) * 100
      : 0;

  let errorStatus =
    "healthy";

  if (
    requestCount >= 20 &&
    errorRate >=
      Number(
        policy.errorRateCriticalPercent
      )
  ) {
    errorStatus =
      "critical";
  } else if (
    requestCount >= 20 &&
    errorRate >=
      Number(
        policy.errorRateWarningPercent
      )
  ) {
    errorStatus =
      "warning";
  }

  checks.push({
    checkKey:
      "http_error_rate",
    category:
      "performance",
    status:
      errorStatus,
    message:
      `HTTP error rate is ${errorRate.toFixed(2)}% across ${requestCount} recent requests.`,
    evidence: {
      requestCount,
      errorCount,
      errorRate,
      windowMinutes:
        15,
    },
  });

  const backupTimers = {
    database:
      timerActive(
        "goodos-db-backup.timer"
      ),
    enterprise:
      timerActive(
        "goodos-enterprise-backup.timer"
      ),
    retention:
      timerActive(
        "goodos-backup-retention.timer"
      ),
    verification:
      timerActive(
        "goodos-enterprise-verify.timer"
      ),
  };

  const timersHealthy =
    Object.values(
      backupTimers
    ).every(Boolean);

  checks.push({
    checkKey:
      "backup_timers",
    category:
      "recovery",
    status:
      timersHealthy
        ? "healthy"
        : "critical",
    message:
      timersHealthy
        ? "Backup, retention, and verification timers are active."
        : "One or more backup or verification timers are inactive.",
    evidence:
      backupTimers,
  });

  for (const check of checks) {
    await query(
      `
        INSERT INTO
          backend_operations_checks (
            id,
            organization_id,
            project_id,
            environment_id,
            check_key,
            category,
            status,
            message,
            duration_ms,
            evidence_json
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
          $9,
          $10::jsonb
        )
      `,
      [
        identifier("opcheck"),
        policy.organizationId,
        tenant.projectId,
        tenant.environmentId,
        check.checkKey,
        check.category,
        check.status,
        check.message,
        check.durationMs || null,
        JSON.stringify(
          check.evidence || {}
        ),
      ]
    );

    const ruleKey =
      `ops.phase7.${check.checkKey}`;

    if (
      check.status ===
      "healthy"
    ) {
      await query(
        `
          UPDATE backend_alert_events
          SET
            status =
              'resolved',
            resolved_at =
              COALESCE(
                resolved_at,
                NOW()
              ),
            updated_at =
              NOW(),
            metadata_json =
              COALESCE(
                metadata_json,
                '{}'::jsonb
              ) ||
              jsonb_build_object(
                'resolvedBy',
                'goodos-operations-check'
              )

          WHERE organization_id =
                $1

            AND rule_key =
                $2

            AND status IN (
              'open',
              'acknowledged'
            )
        `,
        [
          policy.organizationId,
          ruleKey,
        ]
      );

      continue;
    }

    const existingAlert =
      await query(
        `
          UPDATE backend_alert_events
          SET
            severity =
              $3,
            title =
              $4,
            message =
              $5,
            payload_json =
              $6::jsonb,
            updated_at =
              NOW()

          WHERE organization_id =
                $1

            AND rule_key =
                $2

            AND status =
                'open'

          RETURNING id
        `,
        [
          policy.organizationId,
          ruleKey,
          check.status ===
            "critical"
            ? "critical"
            : "warning",
          `Operations check: ${check.checkKey}`,
          check.message,
          JSON.stringify(
            check.evidence || {}
          ),
        ]
      );

    if (
      existingAlert.rowCount === 0
    ) {
      const ruleResult =
        await query(
          `
            SELECT id
            FROM backend_alert_rules
            WHERE organization_id =
                  $1
              AND rule_key =
                  $2
            LIMIT 1
          `,
          [
            policy.organizationId,
            ruleKey,
          ]
        );

      await query(
        `
          INSERT INTO backend_alert_events (
            id,
            rule_id,
            rule_key,
            category,
            severity,
            title,
            message,
            source,
            source_id,
            status,
            payload_json,
            metadata_json,
            organization_id,
            project_id,
            environment_id
          )
          VALUES (
            $1,
            $2,
            $3,
            'operations',
            $4,
            $5,
            $6,
            'goodos-operations-check',
            $7,
            'open',
            $8::jsonb,
            jsonb_build_object(
              'phase',
              7
            ),
            $9,
            $10,
            $11
          )
        `,
        [
          identifier("alert"),
          ruleResult.rows[0]
            ?.id || null,
          ruleKey,
          check.status ===
            "critical"
            ? "critical"
            : "warning",
          `Operations check: ${check.checkKey}`,
          check.message,
          check.checkKey,
          JSON.stringify(
            check.evidence || {}
          ),
          policy.organizationId,
          tenant.projectId,
          tenant.environmentId,
        ]
      );
    }

    if (
      check.status ===
        "critical" &&
      policy.incidentAutoCreate
    ) {
      await query(
        `
          INSERT INTO backend_incidents (
            id,
            organization_id,
            project_id,
            environment_id,
            title,
            description,
            severity,
            status,
            source,
            source_id,
            metadata_json
          )
          SELECT
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            'critical',
            'open',
            'goodos-operations-check',
            $7,
            $8::jsonb

          WHERE NOT EXISTS (
            SELECT 1
            FROM backend_incidents
            WHERE organization_id =
                  $2
              AND source =
                  'goodos-operations-check'
              AND source_id =
                  $7
              AND status IN (
                'open',
                'investigating',
                'monitoring'
              )
          )
        `,
        [
          identifier("incident"),
          policy.organizationId,
          tenant.projectId,
          tenant.environmentId,
          `Critical operations check: ${check.checkKey}`,
          check.message,
          check.checkKey,
          JSON.stringify(
            check.evidence || {}
          ),
        ]
      );
    }
  }

  await query(
    `
      DELETE FROM backend_operations_checks

      WHERE checked_at <
            NOW() -
            make_interval(
              days => $1
            )
    `,
    [
      Number(
        policy.operationsCheckRetentionDays
      ),
    ]
  );

  const summary =
    checks.reduce(
      (
        result,
        check
      ) => {
        result[
          check.status
        ]++;

        return result;
      },
      {
        healthy:
          0,
        warning:
          0,
        critical:
          0,
      }
    );

  console.log(
    JSON.stringify(
      {
        checkedAt:
          new Date()
            .toISOString(),
        organizationId:
          policy.organizationId,
        summary,
        checks,
      },
      null,
      2
    )
  );

  if (
    summary.critical > 0
  ) {
    process.exitCode = 2;
  }
}

main()
  .catch(error => {
    console.error(
      "GoodOS operations check failed:",
      error
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      const database =
        require("../src/config/database");

      if (
        database.pool &&
        typeof database.pool.end ===
          "function"
      ) {
        await database.pool.end();
      }
    } catch {
      // Process exits naturally.
    }
  });
