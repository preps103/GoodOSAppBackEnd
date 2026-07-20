/* GOODOS_ENTERPRISE_FOUNDATION_V1 */

const crypto =
  require("crypto");

const fs =
  require("fs");

const database =
  require("../config/database");

const SERVICE_NAME =
  "goodapp-backend";

const metricBuckets =
  new Map();

function dbQuery(
  sql,
  params = []
) {
  if (
    typeof database.query ===
    "function"
  ) {
    return database.query(
      sql,
      params
    );
  }

  if (
    database.pool &&
    typeof database.pool.query ===
      "function"
  ) {
    return database.pool.query(
      sql,
      params
    );
  }

  if (
    typeof database.getPool ===
    "function"
  ) {
    return database
      .getPool()
      .query(
        sql,
        params
      );
  }

  throw new Error(
    "Database query function not found"
  );
}

function identifier(
  prefix
) {
  return (
    `${prefix}_` +
    crypto
      .randomUUID()
      .replace(/-/g, "")
  );
}

function minuteStart(
  date = new Date()
) {
  const result =
    new Date(date);

  result.setUTCSeconds(
    0,
    0
  );

  return result;
}

function normalizeRoute(
  value
) {
  const route =
    String(
      value || "/unknown"
    )
      .split("?")[0]
      .replace(
        /\/[0-9a-f]{24,}(?=\/|$)/gi,
        "/:id"
      )
      .replace(
        /\/[0-9]{4,}(?=\/|$)/g,
        "/:id"
      )
      .replace(
        /\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi,
        "/:id"
      );

  return route.slice(
    0,
    300
  );
}

function observeRequest({
  method,
  route,
  statusCode,
  durationMs,
}) {
  const start =
    minuteStart();

  const normalizedMethod =
    String(
      method || "UNKNOWN"
    )
      .toUpperCase()
      .slice(0, 20);

  const normalizedRoute =
    normalizeRoute(route);

  const statusClass =
    `${Math.floor(
      Number(
        statusCode || 0
      ) / 100
    )}xx`;

  const key = [
    start.toISOString(),
    normalizedMethod,
    normalizedRoute,
    statusClass,
  ].join("|");

  const current =
    metricBuckets.get(key) || {
      id:
        identifier("metric"),
      minuteStart:
        start.toISOString(),
      serviceName:
        SERVICE_NAME,
      method:
        normalizedMethod,
      route:
        normalizedRoute,
      statusClass,
      requestCount: 0,
      errorCount: 0,
      durationSumMs: 0,
      durationMaxMs: 0,
      bucketLe50: 0,
      bucketLe100: 0,
      bucketLe250: 0,
      bucketLe500: 0,
      bucketLe1000: 0,
      bucketLe2500: 0,
      bucketLe5000: 0,
      bucketInf: 0,
    };

  const duration =
    Math.max(
      0,
      Number(durationMs) || 0
    );

  current.requestCount += 1;

  if (
    Number(statusCode) >=
    500
  ) {
    current.errorCount += 1;
  }

  current.durationSumMs +=
    duration;

  current.durationMaxMs =
    Math.max(
      current.durationMaxMs,
      duration
    );

  if (duration <= 50) {
    current.bucketLe50 += 1;
  }

  if (duration <= 100) {
    current.bucketLe100 += 1;
  }

  if (duration <= 250) {
    current.bucketLe250 += 1;
  }

  if (duration <= 500) {
    current.bucketLe500 += 1;
  }

  if (duration <= 1000) {
    current.bucketLe1000 += 1;
  }

  if (duration <= 2500) {
    current.bucketLe2500 += 1;
  }

  if (duration <= 5000) {
    current.bucketLe5000 += 1;
  }

  current.bucketInf += 1;

  metricBuckets.set(
    key,
    current
  );
}

async function flushMetricBuckets() {
  const entries = [
    ...metricBuckets.entries(),
  ];

  for (
    const [key, metric]
    of entries
  ) {
    try {
      await dbQuery(
        `
          INSERT INTO backend_metric_buckets (
            id,
            minute_start,
            service_name,
            method,
            route,
            status_class,
            request_count,
            error_count,
            duration_sum_ms,
            duration_max_ms,
            bucket_le_50,
            bucket_le_100,
            bucket_le_250,
            bucket_le_500,
            bucket_le_1000,
            bucket_le_2500,
            bucket_le_5000,
            bucket_inf,
            created_at,
            updated_at
          )
          VALUES (
            $1,
            $2::timestamptz,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13,
            $14,
            $15,
            $16,
            $17,
            $18,
            NOW(),
            NOW()
          )

          ON CONFLICT (
            minute_start,
            service_name,
            method,
            route,
            status_class
          )
          DO UPDATE SET
            request_count =
              backend_metric_buckets.request_count +
              EXCLUDED.request_count,

            error_count =
              backend_metric_buckets.error_count +
              EXCLUDED.error_count,

            duration_sum_ms =
              backend_metric_buckets.duration_sum_ms +
              EXCLUDED.duration_sum_ms,

            duration_max_ms =
              GREATEST(
                backend_metric_buckets.duration_max_ms,
                EXCLUDED.duration_max_ms
              ),

            bucket_le_50 =
              backend_metric_buckets.bucket_le_50 +
              EXCLUDED.bucket_le_50,

            bucket_le_100 =
              backend_metric_buckets.bucket_le_100 +
              EXCLUDED.bucket_le_100,

            bucket_le_250 =
              backend_metric_buckets.bucket_le_250 +
              EXCLUDED.bucket_le_250,

            bucket_le_500 =
              backend_metric_buckets.bucket_le_500 +
              EXCLUDED.bucket_le_500,

            bucket_le_1000 =
              backend_metric_buckets.bucket_le_1000 +
              EXCLUDED.bucket_le_1000,

            bucket_le_2500 =
              backend_metric_buckets.bucket_le_2500 +
              EXCLUDED.bucket_le_2500,

            bucket_le_5000 =
              backend_metric_buckets.bucket_le_5000 +
              EXCLUDED.bucket_le_5000,

            bucket_inf =
              backend_metric_buckets.bucket_inf +
              EXCLUDED.bucket_inf,

            updated_at =
              NOW()
        `,
        [
          metric.id,
          metric.minuteStart,
          metric.serviceName,
          metric.method,
          metric.route,
          metric.statusClass,
          metric.requestCount,
          metric.errorCount,
          metric.durationSumMs,
          metric.durationMaxMs,
          metric.bucketLe50,
          metric.bucketLe100,
          metric.bucketLe250,
          metric.bucketLe500,
          metric.bucketLe1000,
          metric.bucketLe2500,
          metric.bucketLe5000,
          metric.bucketInf,
        ]
      );

      metricBuckets.delete(
        key
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          timestamp:
            new Date()
              .toISOString(),

          level:
            "error",

          event:
            "enterprise.metrics_flush_failed",

          service:
            SERVICE_NAME,

          message:
            error.message,
        })
      );
    }
  }
}

let metricsFlushPromise = null;

function flushMetrics() {
  if (!metricsFlushPromise) {
    metricsFlushPromise =
      flushMetricBuckets()
        .finally(() => {
          metricsFlushPromise = null;
        });
  }

  return metricsFlushPromise;
}

async function persistDependencyCheck(
  check
) {
  await dbQuery(
    `
      INSERT INTO backend_dependency_checks (
        id,
        dependency_name,
        dependency_type,
        status,
        critical,
        latency_ms,
        message,
        details_json,
        checked_at
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8::jsonb,
        NOW()
      )
    `,
    [
      identifier("dependency"),
      check.name,
      check.type,
      check.status,
      check.critical,
      check.latencyMs,
      check.message || null,
      JSON.stringify(
        check.details || {}
      ),
    ]
  );
}

async function runDependencyChecks({
  persist = true,
} = {}) {
  const checks = [];

  let databaseReady = false;

  {
    const started =
      process.hrtime.bigint();

    try {
      await dbQuery(
        "SELECT 1 AS ready"
      );

      databaseReady = true;

      checks.push({
        name:
          "postgresql",
        type:
          "database",
        critical: true,
        status:
          "ready",
        latencyMs:
          Number(
            process.hrtime.bigint() -
            started
          ) / 1e6,
        message:
          "PostgreSQL accepted a readiness query.",
        details: {},
      });
    } catch (error) {
      checks.push({
        name:
          "postgresql",
        type:
          "database",
        critical: true,
        status:
          "down",
        latencyMs:
          Number(
            process.hrtime.bigint() -
            started
          ) / 1e6,
        message:
          error.message,
        details: {},
      });
    }
  }

  {
    const started =
      process.hrtime.bigint();

    try {
      const response =
        await fetch(
          "http://127.0.0.1:3000/health",
          {
            signal:
              AbortSignal.timeout(
                3000
              ),
          }
        );

      checks.push({
        name:
          "goodos-frontend",
        type:
          "http",
        critical: false,
        status:
          response.ok
            ? "ready"
            : "degraded",
        latencyMs:
          Number(
            process.hrtime.bigint() -
            started
          ) / 1e6,
        message:
          `Frontend health returned HTTP ${response.status}.`,
        details: {
          statusCode:
            response.status,
        },
      });
    } catch (error) {
      checks.push({
        name:
          "goodos-frontend",
        type:
          "http",
        critical: false,
        status:
          "down",
        latencyMs:
          Number(
            process.hrtime.bigint() -
            started
          ) / 1e6,
        message:
          error.message,
        details: {},
      });
    }
  }

  {
    try {
      const stats =
        fs.statfsSync(
          "/var/www"
        );

      const totalBytes =
        Number(stats.blocks) *
        Number(stats.bsize);

      const freeBytes =
        Number(stats.bavail) *
        Number(stats.bsize);

      const usedPercent =
        totalBytes > 0
          ? (
              (
                totalBytes -
                freeBytes
              ) /
              totalBytes
            ) * 100
          : 0;

      checks.push({
        name:
          "application-disk",
        type:
          "filesystem",
        critical: true,
        status:
          usedPercent >= 95
            ? "down"
            : usedPercent >= 85
            ? "degraded"
            : "ready",
        latencyMs: null,
        message:
          `${usedPercent.toFixed(2)}% disk utilization.`,
        details: {
          totalBytes,
          freeBytes,
          usedPercent:
            Number(
              usedPercent.toFixed(2)
            ),
        },
      });
    } catch (error) {
      checks.push({
        name:
          "application-disk",
        type:
          "filesystem",
        critical: true,
        status:
          "degraded",
        latencyMs: null,
        message:
          error.message,
        details: {},
      });
    }
  }

  if (databaseReady) {
    try {
      const result =
        await dbQuery(
          `
            SELECT
              id,

              completed_at
                AS "completedAt",

              EXTRACT(
                EPOCH FROM (
                  NOW() -
                  completed_at
                )
              ) / 60
                AS "ageMinutes"

            FROM backend_backup_inventory

            WHERE status =
                  'completed'

            ORDER BY
              completed_at DESC

            LIMIT 1
          `
        );

      const backup =
        result.rows[0];

      if (!backup) {
        checks.push({
          name:
            "database-backup",
          type:
            "backup",
          critical: true,
          status:
            "degraded",
          latencyMs: null,
          message:
            "No completed database backup has been recorded.",
          details: {},
        });
      } else {
        const ageMinutes =
          Number(
            backup.ageMinutes
          );

        checks.push({
          name:
            "database-backup",
          type:
            "backup",
          critical: true,
          status:
            ageMinutes > 2880
              ? "down"
              : ageMinutes > 1440
              ? "degraded"
              : "ready",
          latencyMs: null,
          message:
            `Latest backup is ${ageMinutes.toFixed(1)} minutes old.`,
          details: {
            backupId:
              backup.id,
            completedAt:
              backup.completedAt,
            ageMinutes:
              Number(
                ageMinutes.toFixed(2)
              ),
          },
        });
      }
    } catch (error) {
      checks.push({
        name:
          "database-backup",
        type:
          "backup",
        critical: true,
        status:
          "degraded",
        latencyMs: null,
        message:
          error.message,
        details: {},
      });
    }
  }

  if (
    persist &&
    databaseReady
  ) {
    for (
      const check
      of checks
    ) {
      try {
        await persistDependencyCheck(
          check
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            timestamp:
              new Date()
                .toISOString(),

            level:
              "error",

            event:
              "enterprise.dependency_persist_failed",

            service:
              SERVICE_NAME,

            dependency:
              check.name,

            message:
              error.message,
          })
        );
      }
    }
  }

  const criticalChecks =
    checks.filter(
      check =>
        check.critical
    );

  return {
    status:
      criticalChecks.every(
        check =>
          check.status ===
          "ready"
      )
        ? "ready"
        : criticalChecks.some(
            check =>
              check.status ===
              "down"
          )
        ? "down"
        : "degraded",

    checks,
    checkedAt:
      new Date()
        .toISOString(),
  };
}

function evaluateResult(
  comparator,
  observed,
  target
) {
  if (
    observed === null ||
    observed === undefined ||
    Number.isNaN(
      Number(observed)
    )
  ) {
    return "insufficient_data";
  }

  if (
    comparator ===
    "gte"
  ) {
    return (
      Number(observed) >=
      Number(target)
    )
      ? "met"
      : "breached";
  }

  return (
    Number(observed) <=
    Number(target)
  )
    ? "met"
    : "breached";
}

async function insertSloMeasurement({
  sloId,
  periodStart,
  periodEnd,
  observedValue,
  goodCount = null,
  totalCount = null,
  result,
  details = {},
}) {
  await dbQuery(
    `
      INSERT INTO backend_slo_measurements (
        id,
        slo_id,
        period_start,
        period_end,
        observed_value,
        good_count,
        total_count,
        result,
        details_json,
        measured_at
      )
      VALUES (
        $1,
        $2,
        $3::timestamptz,
        $4::timestamptz,
        $5,
        $6,
        $7,
        $8,
        $9::jsonb,
        NOW()
      )
    `,
    [
      identifier("slomeasure"),
      sloId,
      periodStart,
      periodEnd,
      observedValue,
      goodCount,
      totalCount,
      result,
      JSON.stringify(details),
    ]
  );
}

function approximateP95(
  row
) {
  const total =
    Number(
      row.totalRequests || 0
    );

  if (total <= 0) {
    return null;
  }

  const target =
    Math.ceil(
      total * 0.95
    );

  const buckets = [
    [
      50,
      Number(
        row.bucketLe50 || 0
      ),
    ],
    [
      100,
      Number(
        row.bucketLe100 || 0
      ),
    ],
    [
      250,
      Number(
        row.bucketLe250 || 0
      ),
    ],
    [
      500,
      Number(
        row.bucketLe500 || 0
      ),
    ],
    [
      1000,
      Number(
        row.bucketLe1000 || 0
      ),
    ],
    [
      2500,
      Number(
        row.bucketLe2500 || 0
      ),
    ],
    [
      5000,
      Number(
        row.bucketLe5000 || 0
      ),
    ],
  ];

  for (
    const [limit, count]
    of buckets
  ) {
    if (count >= target) {
      return limit;
    }
  }

  return Number(
    row.durationMaxMs || 5000
  );
}

async function evaluateSlos() {
  await flushMetrics();

  const end =
    new Date();

  const start =
    new Date(
      end.getTime() -
      5 * 60 * 1000
    );

  const [
    metricResult,
    databaseResult,
    backupResult,
    definitionsResult,
  ] = await Promise.all([
    dbQuery(
      `
        SELECT
          COALESCE(
            SUM(request_count),
            0
          )::bigint
            AS "totalRequests",

          COALESCE(
            SUM(error_count),
            0
          )::bigint
            AS "errorRequests",

          COALESCE(
            SUM(bucket_le_50),
            0
          )::bigint
            AS "bucketLe50",

          COALESCE(
            SUM(bucket_le_100),
            0
          )::bigint
            AS "bucketLe100",

          COALESCE(
            SUM(bucket_le_250),
            0
          )::bigint
            AS "bucketLe250",

          COALESCE(
            SUM(bucket_le_500),
            0
          )::bigint
            AS "bucketLe500",

          COALESCE(
            SUM(bucket_le_1000),
            0
          )::bigint
            AS "bucketLe1000",

          COALESCE(
            SUM(bucket_le_2500),
            0
          )::bigint
            AS "bucketLe2500",

          COALESCE(
            SUM(bucket_le_5000),
            0
          )::bigint
            AS "bucketLe5000",

          COALESCE(
            MAX(duration_max_ms),
            0
          )::double precision
            AS "durationMaxMs"

        FROM backend_metric_buckets

        WHERE minute_start >=
              $1::timestamptz
      `,
      [
        start.toISOString(),
      ]
    ),

    dbQuery(
      `
        SELECT
          COUNT(*)::int
            AS total,

          COUNT(*) FILTER (
            WHERE status =
                  'ready'
          )::int
            AS good

        FROM backend_dependency_checks

        WHERE dependency_name =
              'postgresql'

          AND checked_at >=
              $1::timestamptz
      `,
      [
        start.toISOString(),
      ]
    ),

    dbQuery(
      `
        SELECT
          EXTRACT(
            EPOCH FROM (
              NOW() -
              completed_at
            )
          ) / 60
            AS "ageMinutes"

        FROM backend_backup_inventory

        WHERE status =
              'completed'

        ORDER BY
          completed_at DESC

        LIMIT 1
      `
    ),

    dbQuery(
      `
        SELECT
          id,
          comparator,

          target_value
            AS "targetValue"

        FROM backend_slo_definitions

        WHERE status =
              'active'
      `
    ),
  ]);

  const definitions =
    new Map(
      definitionsResult.rows.map(
        row => [
          row.id,
          row,
        ]
      )
    );

  const metrics =
    metricResult.rows[0] || {};

  const totalRequests =
    Number(
      metrics.totalRequests || 0
    );

  const errors =
    Number(
      metrics.errorRequests || 0
    );

  const availability =
    totalRequests > 0
      ? (
          (
            totalRequests -
            errors
          ) /
          totalRequests
        ) * 100
      : null;

  const availabilityDefinition =
    definitions.get(
      "slo_api_availability_5m"
    );

  if (
    availabilityDefinition
  ) {
    await insertSloMeasurement({
      sloId:
        availabilityDefinition.id,
      periodStart:
        start.toISOString(),
      periodEnd:
        end.toISOString(),
      observedValue:
        availability,
      goodCount:
        totalRequests -
        errors,
      totalCount:
        totalRequests,
      result:
        totalRequests === 0
          ? "insufficient_data"
          : evaluateResult(
              availabilityDefinition.comparator,
              availability,
              availabilityDefinition.targetValue
            ),
      details: {},
    });
  }

  const p95 =
    approximateP95(
      metrics
    );

  const latencyDefinition =
    definitions.get(
      "slo_api_latency_p95_5m"
    );

  if (latencyDefinition) {
    await insertSloMeasurement({
      sloId:
        latencyDefinition.id,
      periodStart:
        start.toISOString(),
      periodEnd:
        end.toISOString(),
      observedValue:
        p95,
      totalCount:
        totalRequests,
      result:
        p95 === null
          ? "insufficient_data"
          : evaluateResult(
              latencyDefinition.comparator,
              p95,
              latencyDefinition.targetValue
            ),
      details: {
        approximation:
          "histogram_upper_bound",
      },
    });
  }

  const database =
    databaseResult.rows[0] || {};

  const databaseTotal =
    Number(
      database.total || 0
    );

  const databaseGood =
    Number(
      database.good || 0
    );

  const databaseReadiness =
    databaseTotal > 0
      ? (
          databaseGood /
          databaseTotal
        ) * 100
      : null;

  const databaseDefinition =
    definitions.get(
      "slo_database_readiness_5m"
    );

  if (
    databaseDefinition
  ) {
    await insertSloMeasurement({
      sloId:
        databaseDefinition.id,
      periodStart:
        start.toISOString(),
      periodEnd:
        end.toISOString(),
      observedValue:
        databaseReadiness,
      goodCount:
        databaseGood,
      totalCount:
        databaseTotal,
      result:
        databaseTotal === 0
          ? "insufficient_data"
          : evaluateResult(
              databaseDefinition.comparator,
              databaseReadiness,
              databaseDefinition.targetValue
            ),
      details: {},
    });
  }

  const backupAge =
    backupResult.rows[0]
      ? Number(
          backupResult.rows[0]
            .ageMinutes
        )
      : null;

  const backupDefinition =
    definitions.get(
      "slo_backup_freshness_24h"
    );

  if (
    backupDefinition
  ) {
    await insertSloMeasurement({
      sloId:
        backupDefinition.id,
      periodStart:
        new Date(
          end.getTime() -
          24 * 60 * 60 * 1000
        ).toISOString(),
      periodEnd:
        end.toISOString(),
      observedValue:
        backupAge,
      result:
        backupAge === null
          ? "insufficient_data"
          : evaluateResult(
              backupDefinition.comparator,
              backupAge,
              backupDefinition.targetValue
            ),
      details: {},
    });
  }
}

async function recordOperationalEvent({
  severity = "info",
  eventType,
  requestId = null,
  traceId = null,
  message = null,
  metadata = {},
}) {
  try {
    await dbQuery(
      `
        INSERT INTO backend_operational_events (
          id,
          severity,
          event_type,
          service_name,
          request_id,
          trace_id,
          message,
          metadata_json,
          created_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8::jsonb,
          NOW()
        )
      `,
      [
        identifier("operation"),
        severity,
        eventType,
        SERVICE_NAME,
        requestId,
        traceId,
        message,
        JSON.stringify(metadata),
      ]
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        timestamp:
          new Date()
            .toISOString(),

        level:
          "error",

        event:
          "enterprise.operational_event_failed",

        service:
          SERVICE_NAME,

        message:
          error.message,
      })
    );
  }
}

async function getEnterpriseOverview() {
  await flushMetrics();

  const [
    sloResult,
    dependencyResult,
    backupResult,
    verificationResult,
    metricResult,
    eventResult,
  ] = await Promise.all([
    dbQuery(
      `
        SELECT
          definition.id,
          definition.name,
          definition.description,

          definition.metric_name
            AS "metricName",

          definition.comparator,

          definition.target_value
            AS "targetValue",

          definition.unit,

          definition.window_minutes
            AS "windowMinutes",

          measurement.observed_value
            AS "observedValue",

          measurement.result,

          measurement.good_count
            AS "goodCount",

          measurement.total_count
            AS "totalCount",

          measurement.measured_at
            AS "measuredAt"

        FROM backend_slo_definitions
             definition

        LEFT JOIN LATERAL (
          SELECT *
          FROM backend_slo_measurements

          WHERE slo_id =
                definition.id

          ORDER BY
            measured_at DESC

          LIMIT 1
        ) measurement
          ON TRUE

        WHERE definition.status =
              'active'

        ORDER BY definition.name
      `
    ),

    dbQuery(
      `
        SELECT DISTINCT ON (
          dependency_name
        )
          id,

          dependency_name
            AS "dependencyName",

          dependency_type
            AS "dependencyType",

          status,
          critical,

          latency_ms
            AS "latencyMs",

          message,

          details_json
            AS details,

          checked_at
            AS "checkedAt"

        FROM backend_dependency_checks

        ORDER BY
          dependency_name,
          checked_at DESC
      `
    ),

    dbQuery(
      `
        SELECT
          id,

          backup_type
            AS "backupType",

          storage_type
            AS "storageType",

          file_path
            AS "filePath",

          file_name
            AS "fileName",

          size_bytes
            AS "sizeBytes",

          checksum_sha256
            AS "checksumSha256",

          database_name
            AS "databaseName",

          completed_at
            AS "completedAt",

          status,

          retention_until
            AS "retentionUntil",

          metadata_json
            AS metadata

        FROM backend_backup_inventory

        ORDER BY
          created_at DESC

        LIMIT 30
      `
    ),

    dbQuery(
      `
        SELECT
          id,

          backup_inventory_id
            AS "backupInventoryId",

          verification_type
            AS "verificationType",

          target_environment
            AS "targetEnvironment",

          status,

          rpo_minutes
            AS "rpoMinutes",

          rto_minutes
            AS "rtoMinutes",

          started_at
            AS "startedAt",

          completed_at
            AS "completedAt",

          notes,

          evidence_json
            AS evidence,

          created_at
            AS "createdAt"

        FROM backend_restore_verifications

        ORDER BY
          created_at DESC

        LIMIT 30
      `
    ),

    dbQuery(
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
            AS "errorCount",

          COALESCE(
            SUM(duration_sum_ms),
            0
          )::double precision
            AS "durationSumMs",

          COALESCE(
            MAX(duration_max_ms),
            0
          )::double precision
            AS "durationMaxMs"

        FROM backend_metric_buckets

        WHERE minute_start >=
              NOW() -
              INTERVAL '24 hours'
      `
    ),

    dbQuery(
      `
        SELECT
          id,
          severity,

          event_type
            AS "eventType",

          service_name
            AS "serviceName",

          request_id
            AS "requestId",

          trace_id
            AS "traceId",

          message,

          metadata_json
            AS metadata,

          created_at
            AS "createdAt"

        FROM backend_operational_events

        ORDER BY
          created_at DESC

        LIMIT 100
      `
    ),
  ]);

  const metric =
    metricResult.rows[0] || {};

  const requestCount =
    Number(
      metric.requestCount || 0
    );

  const errorCount =
    Number(
      metric.errorCount || 0
    );

  return {
    service: {
      name:
        SERVICE_NAME,
      status:
        "operational",
      generatedAt:
        new Date()
          .toISOString(),
    },

    metrics24Hours: {
      requestCount,
      errorCount,

      errorRatePercent:
        requestCount > 0
          ? Number(
              (
                (
                  errorCount /
                  requestCount
                ) * 100
              ).toFixed(4)
            )
          : 0,

      averageLatencyMs:
        requestCount > 0
          ? Number(
              (
                Number(
                  metric.durationSumMs ||
                  0
                ) /
                requestCount
              ).toFixed(2)
            )
          : 0,

      maximumLatencyMs:
        Number(
          Number(
            metric.durationMaxMs ||
            0
          ).toFixed(2)
        ),
    },

    slos:
      sloResult.rows,

    dependencies:
      dependencyResult.rows,

    backups:
      backupResult.rows,

    restoreVerifications:
      verificationResult.rows,

    events:
      eventResult.rows,
  };
}

function escapePrometheusLabel(
  value
) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

async function getPrometheusMetrics() {
  await flushMetrics();

  const [
    requestResult,
    dependencyResult,
    backupResult,
  ] = await Promise.all([
    dbQuery(
      `
        SELECT
          method,
          route,
          status_class
            AS "statusClass",

          SUM(request_count)::bigint
            AS requests,

          SUM(error_count)::bigint
            AS errors,

          SUM(duration_sum_ms)
            AS "durationSumMs"

        FROM backend_metric_buckets

        WHERE minute_start >=
              NOW() -
              INTERVAL '24 hours'

        GROUP BY
          method,
          route,
          status_class

        ORDER BY
          method,
          route,
          status_class
      `
    ),

    dbQuery(
      `
        SELECT DISTINCT ON (
          dependency_name
        )
          dependency_name
            AS "dependencyName",

          status

        FROM backend_dependency_checks

        ORDER BY
          dependency_name,
          checked_at DESC
      `
    ),

    dbQuery(
      `
        SELECT
          EXTRACT(
            EPOCH FROM (
              NOW() -
              completed_at
            )
          ) AS "ageSeconds"

        FROM backend_backup_inventory

        WHERE status =
              'completed'

        ORDER BY
          completed_at DESC

        LIMIT 1
      `
    ),
  ]);

  const lines = [
    "# HELP goodos_api_requests_total GoodOS API requests during the retained metric window.",
    "# TYPE goodos_api_requests_total counter",
  ];

  for (
    const row
    of requestResult.rows
  ) {
    const labels =
      `method="${escapePrometheusLabel(
        row.method
      )}",route="${escapePrometheusLabel(
        row.route
      )}",status_class="${escapePrometheusLabel(
        row.statusClass
      )}"`;

    lines.push(
      `goodos_api_requests_total{${labels}} ${Number(
        row.requests || 0
      )}`
    );
  }

  lines.push(
    "# HELP goodos_api_errors_total GoodOS API server errors during the retained metric window.",
    "# TYPE goodos_api_errors_total counter"
  );

  for (
    const row
    of requestResult.rows
  ) {
    const labels =
      `method="${escapePrometheusLabel(
        row.method
      )}",route="${escapePrometheusLabel(
        row.route
      )}",status_class="${escapePrometheusLabel(
        row.statusClass
      )}"`;

    lines.push(
      `goodos_api_errors_total{${labels}} ${Number(
        row.errors || 0
      )}`
    );
  }

  lines.push(
    "# HELP goodos_api_duration_ms_sum Sum of API request duration in milliseconds.",
    "# TYPE goodos_api_duration_ms_sum counter"
  );

  for (
    const row
    of requestResult.rows
  ) {
    const labels =
      `method="${escapePrometheusLabel(
        row.method
      )}",route="${escapePrometheusLabel(
        row.route
      )}",status_class="${escapePrometheusLabel(
        row.statusClass
      )}"`;

    lines.push(
      `goodos_api_duration_ms_sum{${labels}} ${Number(
        row.durationSumMs || 0
      )}`
    );
  }

  lines.push(
    "# HELP goodos_dependency_ready Whether a GoodOS dependency is ready.",
    "# TYPE goodos_dependency_ready gauge"
  );

  for (
    const row
    of dependencyResult.rows
  ) {
    lines.push(
      `goodos_dependency_ready{dependency="${escapePrometheusLabel(
        row.dependencyName
      )}"} ${
        row.status ===
        "ready"
          ? 1
          : 0
      }`
    );
  }

  lines.push(
    "# HELP goodos_backup_age_seconds Age of the latest completed database backup.",
    "# TYPE goodos_backup_age_seconds gauge",
    `goodos_backup_age_seconds ${Number(
      backupResult.rows[0]
        ?.ageSeconds || 0
    )}`
  );

  return (
    lines.join("\n") +
    "\n"
  );
}

function initializeEnterpriseFoundation() {
  if (
    global
      .__GOODOS_ENTERPRISE_FOUNDATION_V1__
  ) {
    return;
  }

  global
    .__GOODOS_ENTERPRISE_FOUNDATION_V1__ =
    true;

  const metricsTimer =
    setInterval(
      () => {
        void flushMetrics();
      },
      60 * 1000
    );

  metricsTimer.unref();

  const dependencyTimer =
    setInterval(
      () => {
        void runDependencyChecks({
          persist: true,
        });
      },
      60 * 1000
    );

  dependencyTimer.unref();

  const sloTimer =
    setInterval(
      () => {
        void evaluateSlos();
      },
      5 * 60 * 1000
    );

  sloTimer.unref();

  const startupTimer =
    setTimeout(
      () => {
        void runDependencyChecks({
          persist: true,
        });

        void evaluateSlos();

        void recordOperationalEvent({
          severity:
            "info",
          eventType:
            "enterprise.foundation_started",
          message:
            "GoodOS Enterprise Foundation V1 initialized.",
          metadata: {
            pid:
              process.pid,
          },
        });
      },
      2000
    );

  startupTimer.unref();

  for (
    const signal
    of [
      "SIGTERM",
      "SIGINT",
    ]
  ) {
    process.once(
      signal,
      () => {
        void flushMetrics();
      }
    );
  }
}

module.exports = {
  dbQuery,
  observeRequest,
  flushMetrics,
  runDependencyChecks,
  evaluateSlos,
  recordOperationalEvent,
  getEnterpriseOverview,
  getPrometheusMetrics,
  initializeEnterpriseFoundation,
};
