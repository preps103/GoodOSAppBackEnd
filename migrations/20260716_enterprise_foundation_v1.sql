/* GOODOS_ENTERPRISE_FOUNDATION_V1 */

BEGIN;

CREATE TABLE backend_metric_buckets (
    id TEXT PRIMARY KEY,

    minute_start TIMESTAMPTZ NOT NULL,
    service_name TEXT NOT NULL,
    method TEXT NOT NULL,
    route TEXT NOT NULL,
    status_class TEXT NOT NULL,

    request_count BIGINT NOT NULL
        DEFAULT 0,

    error_count BIGINT NOT NULL
        DEFAULT 0,

    duration_sum_ms DOUBLE PRECISION NOT NULL
        DEFAULT 0,

    duration_max_ms DOUBLE PRECISION NOT NULL
        DEFAULT 0,

    bucket_le_50 BIGINT NOT NULL
        DEFAULT 0,

    bucket_le_100 BIGINT NOT NULL
        DEFAULT 0,

    bucket_le_250 BIGINT NOT NULL
        DEFAULT 0,

    bucket_le_500 BIGINT NOT NULL
        DEFAULT 0,

    bucket_le_1000 BIGINT NOT NULL
        DEFAULT 0,

    bucket_le_2500 BIGINT NOT NULL
        DEFAULT 0,

    bucket_le_5000 BIGINT NOT NULL
        DEFAULT 0,

    bucket_inf BIGINT NOT NULL
        DEFAULT 0,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    UNIQUE (
        minute_start,
        service_name,
        method,
        route,
        status_class
    )
);

CREATE INDEX backend_metric_buckets_time_idx
ON backend_metric_buckets (
    minute_start DESC
);

CREATE INDEX backend_metric_buckets_route_idx
ON backend_metric_buckets (
    route,
    minute_start DESC
);

CREATE TABLE backend_dependency_checks (
    id TEXT PRIMARY KEY,

    dependency_name TEXT NOT NULL,
    dependency_type TEXT NOT NULL,

    status TEXT NOT NULL
        CHECK (
            status IN (
                'ready',
                'degraded',
                'down'
            )
        ),

    critical BOOLEAN NOT NULL
        DEFAULT TRUE,

    latency_ms DOUBLE PRECISION,

    message TEXT,

    details_json JSONB NOT NULL
        DEFAULT '{}'::jsonb,

    checked_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
);

CREATE INDEX backend_dependency_checks_name_time_idx
ON backend_dependency_checks (
    dependency_name,
    checked_at DESC
);

CREATE INDEX backend_dependency_checks_status_time_idx
ON backend_dependency_checks (
    status,
    checked_at DESC
);

CREATE TABLE backend_slo_definitions (
    id TEXT PRIMARY KEY,

    service_name TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,

    metric_name TEXT NOT NULL,

    comparator TEXT NOT NULL
        CHECK (
            comparator IN (
                'gte',
                'lte'
            )
        ),

    target_value NUMERIC(14,4) NOT NULL,

    unit TEXT NOT NULL,
    window_minutes INTEGER NOT NULL,

    status TEXT NOT NULL
        DEFAULT 'active'
        CHECK (
            status IN (
                'active',
                'paused',
                'archived'
            )
        ),

    metadata_json JSONB NOT NULL
        DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
);

CREATE UNIQUE INDEX backend_slo_definitions_name_idx
ON backend_slo_definitions (
    service_name,
    name
);

CREATE TABLE backend_slo_measurements (
    id TEXT PRIMARY KEY,

    slo_id TEXT NOT NULL
        REFERENCES backend_slo_definitions(id)
        ON DELETE CASCADE,

    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,

    observed_value NUMERIC(18,6),

    good_count BIGINT,
    total_count BIGINT,

    result TEXT NOT NULL
        CHECK (
            result IN (
                'met',
                'breached',
                'insufficient_data'
            )
        ),

    details_json JSONB NOT NULL
        DEFAULT '{}'::jsonb,

    measured_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
);

CREATE INDEX backend_slo_measurements_slo_time_idx
ON backend_slo_measurements (
    slo_id,
    measured_at DESC
);

CREATE TABLE backend_backup_inventory (
    id TEXT PRIMARY KEY,

    backup_type TEXT NOT NULL,
    storage_type TEXT NOT NULL,

    file_path TEXT NOT NULL,
    file_name TEXT NOT NULL,

    size_bytes BIGINT,
    checksum_sha256 TEXT,

    database_name TEXT,

    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,

    status TEXT NOT NULL
        CHECK (
            status IN (
                'started',
                'completed',
                'failed',
                'deleted'
            )
        ),

    retention_until TIMESTAMPTZ,

    metadata_json JSONB NOT NULL
        DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
);

CREATE INDEX backend_backup_inventory_status_time_idx
ON backend_backup_inventory (
    status,
    completed_at DESC
);

CREATE INDEX backend_backup_inventory_type_time_idx
ON backend_backup_inventory (
    backup_type,
    completed_at DESC
);

CREATE TABLE backend_restore_verifications (
    id TEXT PRIMARY KEY,

    backup_inventory_id TEXT
        REFERENCES backend_backup_inventory(id)
        ON DELETE SET NULL,

    verification_type TEXT NOT NULL,

    target_environment TEXT NOT NULL,

    status TEXT NOT NULL
        CHECK (
            status IN (
                'started',
                'passed',
                'failed',
                'cancelled'
            )
        ),

    rpo_minutes NUMERIC(14,2),
    rto_minutes NUMERIC(14,2),

    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,

    notes TEXT,

    evidence_json JSONB NOT NULL
        DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
);

CREATE INDEX backend_restore_verifications_time_idx
ON backend_restore_verifications (
    created_at DESC
);

CREATE INDEX backend_restore_verifications_status_idx
ON backend_restore_verifications (
    status,
    created_at DESC
);

CREATE TABLE backend_operational_events (
    id TEXT PRIMARY KEY,

    severity TEXT NOT NULL
        CHECK (
            severity IN (
                'debug',
                'info',
                'warning',
                'error',
                'critical'
            )
        ),

    event_type TEXT NOT NULL,
    service_name TEXT NOT NULL,

    request_id TEXT,
    trace_id TEXT,

    message TEXT,

    metadata_json JSONB NOT NULL
        DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL
        DEFAULT NOW()
);

CREATE INDEX backend_operational_events_type_time_idx
ON backend_operational_events (
    event_type,
    created_at DESC
);

CREATE INDEX backend_operational_events_severity_time_idx
ON backend_operational_events (
    severity,
    created_at DESC
);

CREATE INDEX backend_operational_events_request_idx
ON backend_operational_events (
    request_id
)
WHERE request_id IS NOT NULL;

INSERT INTO backend_slo_definitions (
    id,
    service_name,
    name,
    description,
    metric_name,
    comparator,
    target_value,
    unit,
    window_minutes,
    metadata_json
)
VALUES
(
    'slo_api_availability_5m',
    'goodapp-backend',
    'API Availability',
    'Percentage of API requests that complete without a server error.',
    'api_availability_percent',
    'gte',
    99.9000,
    'percent',
    5,
    '{"tier":"critical"}'::jsonb
),
(
    'slo_api_latency_p95_5m',
    'goodapp-backend',
    'API P95 Latency',
    'Approximate 95th percentile API request latency.',
    'api_latency_p95_ms',
    'lte',
    750.0000,
    'milliseconds',
    5,
    '{"tier":"critical"}'::jsonb
),
(
    'slo_database_readiness_5m',
    'goodapp-backend',
    'Database Readiness',
    'Percentage of successful PostgreSQL dependency checks.',
    'database_readiness_percent',
    'gte',
    99.9000,
    'percent',
    5,
    '{"tier":"critical"}'::jsonb
),
(
    'slo_backup_freshness_24h',
    'goodapp-backend',
    'Backup Freshness',
    'Age of the latest completed database backup.',
    'backup_age_minutes',
    'lte',
    1440.0000,
    'minutes',
    1440,
    '{"tier":"critical"}'::jsonb
);

COMMIT;
