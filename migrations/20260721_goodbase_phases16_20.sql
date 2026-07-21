BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Phase 16: unified observability control plane.
CREATE OR REPLACE VIEW goodbase_unified_logs AS
SELECT id, NULL::text AS organization_id, NULL::text AS project_id,
       NULL::text AS environment_id, service_name AS service,
       severity, event_type, request_id, trace_id, message,
       metadata_json AS detail_json, created_at
FROM backend_operational_events
UNION ALL
SELECT id, organization_id, NULL::text, NULL::text, 'api-gateway',
       CASE WHEN COALESCE(status_code,200)>=500 THEN 'error' WHEN COALESCE(status_code,200)>=400 THEN 'warning' ELSE 'info' END,
       'api.request', request_id, NULL::text,
       method||' '||path||' returned '||COALESCE(status_code,0),
       jsonb_build_object('durationMs',duration_ms,'apiKeyId',api_key_id,'sourceIp',source_ip), created_at
FROM backend_api_gateway_request_logs
UNION ALL
SELECT id, NULL::text, NULL::text, NULL::text, 'automatic-rest',
       CASE WHEN response_status>=500 THEN 'error' WHEN response_status>=400 THEN 'warning' ELSE 'info' END,
       'rest.request', request_id, NULL::text,
       method||' '||resource_path||' returned '||response_status,
       jsonb_build_object('durationMs',duration_ms,'requestBytes',request_bytes,'responseBytes',response_bytes), created_at
FROM backend_data_plane_request_logs
UNION ALL
SELECT id, NULL::text, NULL::text, NULL::text, 'graphql',
       CASE WHEN has_errors THEN 'error' ELSE 'info' END,
       'graphql.operation', request_id, NULL::text,
       COALESCE(operation_name,'anonymous')||' returned '||response_status,
       jsonb_build_object('durationMs',duration_ms,'depth',depth,'complexity',complexity,'errors',error_codes), created_at
FROM backend_graphql_operation_logs;

CREATE TABLE IF NOT EXISTS goodbase_log_saved_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL, environment_id TEXT NOT NULL, name TEXT NOT NULL,
  query_text TEXT, regex_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  filters_json JSONB NOT NULL DEFAULT '{}'::jsonb, is_shared BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,name)
);

CREATE TABLE IF NOT EXISTS goodbase_log_drains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL, environment_id TEXT NOT NULL, name TEXT NOT NULL,
  drain_type TEXT NOT NULL CHECK(drain_type IN ('https','syslog','otlp','s3')),
  endpoint TEXT NOT NULL, secret_ref TEXT, minimum_severity TEXT NOT NULL DEFAULT 'info'
    CHECK(minimum_severity IN ('debug','info','warning','error','critical')),
  source_filters TEXT[] NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'disabled'
    CHECK(status IN ('active','disabled','failing')),
  last_delivery_at TIMESTAMPTZ, last_error TEXT, created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,name)
);

CREATE TABLE IF NOT EXISTS goodbase_log_redaction_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL, environment_id TEXT NOT NULL, name TEXT NOT NULL,
  field_pattern TEXT NOT NULL, replacement TEXT NOT NULL DEFAULT '[REDACTED]',
  detect_secrets BOOLEAN NOT NULL DEFAULT TRUE, status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','disabled')), created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodbase_observability_policies (
  id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
  environment_id TEXT NOT NULL, log_retention_days INTEGER NOT NULL DEFAULT 30 CHECK(log_retention_days BETWEEN 1 AND 3650),
  audit_retention_days INTEGER NOT NULL DEFAULT 365 CHECK(audit_retention_days BETWEEN 30 AND 3650),
  trace_sample_percent NUMERIC(5,2) NOT NULL DEFAULT 10 CHECK(trace_sample_percent BETWEEN 0 AND 100),
  pii_detection_enabled BOOLEAN NOT NULL DEFAULT TRUE, release_comparison_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  cost_attribution_enabled BOOLEAN NOT NULL DEFAULT TRUE, updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(organization_id,project_id,environment_id)
);

-- Phase 17: public management API contracts and automation operations.
CREATE TABLE IF NOT EXISTS goodbase_management_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL,
  project_id TEXT, name TEXT NOT NULL, token_prefix TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','expired')),
  last_used_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS goodbase_management_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL, environment_id TEXT, operation_type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','completed','failed','cancelled','rolled_back')),
  request_json JSONB NOT NULL DEFAULT '{}'::jsonb, result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  controller_request_id TEXT, error_message TEXT, requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
  UNIQUE(organization_id,idempotency_key)
);

CREATE TABLE IF NOT EXISTS goodbase_automation_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL,
  project_id TEXT, integration_type TEXT NOT NULL CHECK(integration_type IN ('terraform','github_actions','gitlab_ci','webhook','oauth')),
  name TEXT NOT NULL, configuration_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  secret_ref TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','failing')),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(organization_id,integration_type,name)
);

-- Phase 18: self-service custom domains and certificate lifecycle.
CREATE TABLE IF NOT EXISTS goodbase_custom_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL, environment_id TEXT NOT NULL, hostname TEXT NOT NULL,
  domain_type TEXT NOT NULL DEFAULT 'api' CHECK(domain_type IN ('api','auth','storage','functions','vanity')),
  target_hostname TEXT NOT NULL, verification_token_hash TEXT NOT NULL,
  expected_txt_name TEXT NOT NULL, expected_txt_value TEXT NOT NULL,
  dns_status TEXT NOT NULL DEFAULT 'pending' CHECK(dns_status IN ('pending','verified','failed')),
  certificate_status TEXT NOT NULL DEFAULT 'pending' CHECK(certificate_status IN ('pending','issuing','ready','renewing','failed','expired')),
  activation_status TEXT NOT NULL DEFAULT 'inactive' CHECK(activation_status IN ('inactive','activating','active','deactivating','failed')),
  certificate_secret_ref TEXT, certificate_expires_at TIMESTAMPTZ,
  oauth_callbacks_updated BOOLEAN NOT NULL DEFAULT FALSE, saml_entity_updated BOOLEAN NOT NULL DEFAULT FALSE,
  last_checked_at TIMESTAMPTZ, last_error TEXT, created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(hostname), UNIQUE(organization_id,project_id,environment_id,domain_type)
);

CREATE TABLE IF NOT EXISTS goodbase_domain_events (
  id BIGSERIAL PRIMARY KEY, domain_id UUID NOT NULL REFERENCES goodbase_custom_domains(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, status TEXT NOT NULL, detail_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor_id UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 19: managed vector, keyword, hybrid search, and embedding jobs.
CREATE TABLE IF NOT EXISTS goodbase_vector_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL, environment_id TEXT NOT NULL, name TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK(dimensions BETWEEN 2 AND 4096), distance_metric TEXT NOT NULL DEFAULT 'cosine'
    CHECK(distance_metric IN ('cosine','inner_product','euclidean')),
  index_type TEXT NOT NULL DEFAULT 'hnsw' CHECK(index_type IN ('hnsw','ivfflat','exact')),
  provider TEXT, model TEXT, provider_secret_ref TEXT, status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','building','degraded','disabled')),
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb, created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,name)
);

CREATE TABLE IF NOT EXISTS goodbase_vector_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
  collection_id UUID NOT NULL REFERENCES goodbase_vector_collections(id) ON DELETE CASCADE,
  external_id TEXT, content TEXT NOT NULL, metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding DOUBLE PRECISION[], embedding_model TEXT, embedding_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(embedding_status IN ('pending','processing','ready','failed')),
  search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple',COALESCE(content,''))) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(collection_id,external_id), CHECK(embedding IS NULL OR cardinality(embedding) BETWEEN 2 AND 4096)
);
CREATE INDEX IF NOT EXISTS idx_goodbase_vector_documents_keyword ON goodbase_vector_documents USING GIN(search_vector);

CREATE TABLE IF NOT EXISTS goodbase_embedding_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), document_id UUID NOT NULL REFERENCES goodbase_vector_documents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','completed','failed','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), locked_until TIMESTAMPTZ,
  provider_request_id TEXT, error_message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodbase_search_index_events (
  id BIGSERIAL PRIMARY KEY, collection_id UUID NOT NULL REFERENCES goodbase_vector_collections(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, status TEXT NOT NULL, documents_affected INTEGER NOT NULL DEFAULT 0,
  detail_json JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 20: regions, service nodes, capacity, failover, incidents, and published limits.
CREATE TABLE IF NOT EXISTS goodbase_regions (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, provider TEXT NOT NULL, jurisdiction TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','active','degraded','maintenance','retired')),
  is_primary BOOLEAN NOT NULL DEFAULT FALSE, capabilities_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodbase_service_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL, environment_id TEXT NOT NULL, region_id TEXT NOT NULL REFERENCES goodbase_regions(id),
  service_type TEXT NOT NULL CHECK(service_type IN ('api','realtime','functions','storage','database','pooler','worker','control_plane')),
  node_name TEXT NOT NULL, endpoint TEXT, status TEXT NOT NULL DEFAULT 'provisioning'
    CHECK(status IN ('provisioning','ready','draining','degraded','offline','retired')),
  capacity_json JSONB NOT NULL DEFAULT '{}'::jsonb, utilization_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_heartbeat_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,region_id,service_type,node_name)
);

CREATE TABLE IF NOT EXISTS goodbase_capacity_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL, environment_id TEXT NOT NULL, service_type TEXT NOT NULL,
  region_id TEXT NOT NULL REFERENCES goodbase_regions(id), minimum_nodes INTEGER NOT NULL DEFAULT 1,
  maximum_nodes INTEGER NOT NULL DEFAULT 3, target_utilization_percent INTEGER NOT NULL DEFAULT 65,
  scale_up_cooldown_seconds INTEGER NOT NULL DEFAULT 300, scale_down_cooldown_seconds INTEGER NOT NULL DEFAULT 900,
  cpu_limit_millicores INTEGER NOT NULL DEFAULT 1000, memory_limit_mb INTEGER NOT NULL DEFAULT 1024,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id,project_id,environment_id,service_type,region_id), CHECK(minimum_nodes BETWEEN 1 AND maximum_nodes)
);

CREATE TABLE IF NOT EXISTS goodbase_failover_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL, environment_id TEXT NOT NULL, name TEXT NOT NULL,
  service_type TEXT NOT NULL, primary_region_id TEXT NOT NULL REFERENCES goodbase_regions(id),
  recovery_region_id TEXT NOT NULL REFERENCES goodbase_regions(id), rto_minutes INTEGER NOT NULL,
  rpo_minutes INTEGER NOT NULL, automatic BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','testing','failing_over','failed_over','failed')),
  last_tested_at TIMESTAMPTZ, last_result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK(primary_region_id<>recovery_region_id)
);

CREATE TABLE IF NOT EXISTS goodbase_failover_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), plan_id UUID NOT NULL REFERENCES goodbase_failover_plans(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('test','failover','failback')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','rolled_back')),
  initiated_by UUID REFERENCES users(id) ON DELETE SET NULL, result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS goodbase_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL,
  project_id TEXT, environment_id TEXT, title TEXT NOT NULL, severity TEXT NOT NULL
    CHECK(severity IN ('minor','major','critical')), status TEXT NOT NULL DEFAULT 'investigating'
    CHECK(status IN ('investigating','identified','monitoring','resolved')),
  public_message TEXT, internal_summary TEXT, affected_services TEXT[] NOT NULL DEFAULT '{}',
  affected_regions TEXT[] NOT NULL DEFAULT '{}', started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ, created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS goodbase_service_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id TEXT NOT NULL,
  project_id TEXT, plan_name TEXT NOT NULL, limit_key TEXT NOT NULL, limit_value NUMERIC NOT NULL,
  unit TEXT NOT NULL, enforcement_mode TEXT NOT NULL DEFAULT 'hard' CHECK(enforcement_mode IN ('observe','soft','hard')),
  description TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(organization_id,project_id,plan_name,limit_key)
);

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'goodbase_log_saved_queries','goodbase_log_drains','goodbase_log_redaction_rules','goodbase_observability_policies',
    'goodbase_management_tokens','goodbase_management_operations','goodbase_automation_integrations',
    'goodbase_custom_domains','goodbase_vector_collections','goodbase_vector_documents',
    'goodbase_service_nodes','goodbase_capacity_policies','goodbase_failover_plans','goodbase_incidents','goodbase_service_limits'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS goodbase_tenant_isolation ON %I',table_name);
    EXECUTE format('CREATE POLICY goodbase_tenant_isolation ON %I FOR ALL TO goodos_authenticated USING (organization_id=goodos_auth.organization_id()) WITH CHECK (organization_id=goodos_auth.organization_id())',table_name);
    EXECUTE format('DROP POLICY IF EXISTS goodbase_backend_service ON %I',table_name);
    EXECUTE format('CREATE POLICY goodbase_backend_service ON %I FOR ALL TO goodapp_backend_user USING(TRUE) WITH CHECK(TRUE)',table_name);
  END LOOP;
END $$;

GRANT SELECT ON goodbase_unified_logs TO goodapp_backend_user;
GRANT SELECT,INSERT,UPDATE,DELETE ON
  goodbase_log_saved_queries,goodbase_log_drains,goodbase_log_redaction_rules,goodbase_observability_policies,
  goodbase_management_tokens,goodbase_management_operations,goodbase_automation_integrations,
  goodbase_custom_domains,goodbase_domain_events,goodbase_vector_collections,goodbase_vector_documents,
  goodbase_embedding_jobs,goodbase_search_index_events,goodbase_regions,goodbase_service_nodes,
  goodbase_capacity_policies,goodbase_failover_plans,goodbase_failover_events,goodbase_incidents,
  goodbase_service_limits TO goodapp_backend_user;
GRANT USAGE,SELECT ON SEQUENCE goodbase_domain_events_id_seq,goodbase_search_index_events_id_seq TO goodapp_backend_user;

INSERT INTO goodbase_observability_policies(id,organization_id,project_id,environment_id)
VALUES('observability_goodos_production','org_goodos','proj_goodos_platform','env_goodos_production')
ON CONFLICT(id) DO NOTHING;

INSERT INTO goodbase_regions(id,display_name,provider,jurisdiction,status,is_primary,capabilities_json) VALUES
 ('us-west','US West','self-hosted','US','active',TRUE,'{"api":true,"realtime":true,"functions":true,"storage":true,"database":true}'::jsonb),
 ('us-east','US East','unassigned','US','planned',FALSE,'{"recovery":true}'::jsonb),
 ('eu-west','EU West','unassigned','EU','planned',FALSE,'{"dataResidency":true}'::jsonb)
ON CONFLICT(id) DO UPDATE SET status=EXCLUDED.status,capabilities_json=EXCLUDED.capabilities_json,updated_at=NOW();

INSERT INTO goodbase_service_limits(organization_id,project_id,plan_name,limit_key,limit_value,unit,enforcement_mode,description) VALUES
 ('org_goodos','proj_goodos_platform','enterprise','api_requests_per_minute',6000,'requests','hard','Per-project API request ceiling.'),
 ('org_goodos','proj_goodos_platform','enterprise','storage_gb',1024,'gigabytes','soft','Provisioned object-storage allowance.'),
 ('org_goodos','proj_goodos_platform','enterprise','function_concurrency',100,'invocations','hard','Concurrent isolated function executions.'),
 ('org_goodos','proj_goodos_platform','enterprise','preview_environments',20,'environments','hard','Simultaneous preview environments.')
ON CONFLICT(organization_id,project_id,plan_name,limit_key) DO UPDATE SET limit_value=EXCLUDED.limit_value,enforcement_mode=EXCLUDED.enforcement_mode,updated_at=NOW();

INSERT INTO backend_jobs(id,name,display_name,description,job_type,handler_key,status,priority,schedule_seconds,timeout_seconds,max_attempts,concurrency_key,next_run_at,metadata_json,organization_id,project_id,environment_id,created_by) VALUES
 ('job_goodbase_observability_maintenance','goodbase.observability.maintain','Maintain Observability Retention','Applies log retention and drain health controls.','scheduled','goodbase.observability.maintain','active',8,300,120,3,'goodbase.observability.maintain',NOW(),'{"phase":16}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1)),
 ('job_goodbase_management_dispatch','goodbase.management.dispatch','Dispatch Management Operations','Dispatches idempotent platform management operations.','scheduled','goodbase.management.dispatch','active',8,15,300,5,'goodbase.management.dispatch',NOW(),'{"phase":17}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1)),
 ('job_goodbase_domain_reconcile','goodbase.domains.reconcile','Reconcile Custom Domains','Validates DNS and certificate lifecycle state.','scheduled','goodbase.domains.reconcile','active',8,60,120,5,'goodbase.domains.reconcile',NOW(),'{"phase":18}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1)),
 ('job_goodbase_embedding_process','goodbase.embeddings.process','Process Embedding Queue','Processes leased, retryable embedding jobs.','scheduled','goodbase.embeddings.process','active',8,10,300,5,'goodbase.embeddings.process',NOW(),'{"phase":19}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1)),
 ('job_goodbase_infrastructure_reconcile','goodbase.infrastructure.reconcile','Reconcile Regional Infrastructure','Detects stale nodes, capacity pressure, and failover work.','scheduled','goodbase.infrastructure.reconcile','active',8,30,300,5,'goodbase.infrastructure.reconcile',NOW(),'{"phase":20}'::jsonb,'org_goodos','proj_goodos_platform','env_goodos_production',(SELECT id FROM users ORDER BY created_at LIMIT 1))
ON CONFLICT(id) DO UPDATE SET handler_key=EXCLUDED.handler_key,status='active',schedule_seconds=EXCLUDED.schedule_seconds,timeout_seconds=EXCLUDED.timeout_seconds,max_attempts=EXCLUDED.max_attempts,metadata_json=EXCLUDED.metadata_json,updated_at=NOW();

INSERT INTO backend_job_schedules(id,job_id,schedule_type,interval_seconds,enabled,next_run_at,metadata_json,organization_id,project_id,environment_id)
SELECT 'schedule_'||id,id,'interval',schedule_seconds,TRUE,next_run_at,metadata_json,organization_id,project_id,environment_id
FROM backend_jobs WHERE id LIKE 'job_goodbase_%' AND id IN (
 'job_goodbase_observability_maintenance','job_goodbase_management_dispatch','job_goodbase_domain_reconcile',
 'job_goodbase_embedding_process','job_goodbase_infrastructure_reconcile')
ON CONFLICT(job_id) DO UPDATE SET interval_seconds=EXCLUDED.interval_seconds,enabled=TRUE,next_run_at=EXCLUDED.next_run_at,metadata_json=EXCLUDED.metadata_json,updated_at=NOW();

INSERT INTO backend_data_plane_components(id,component,version,status,endpoint,health_status,configuration_json,metadata_json,created_at,updated_at) VALUES
 ('goodbase_phase_16_observability','observability_logs','1.0.0','active','/api/goodbase/v1/enterprise/logs','healthy','{"unified":true,"tracing":true,"drains":true,"retention":true}'::jsonb,'{"phase":16,"managedBy":"Goodbase"}'::jsonb,NOW(),NOW()),
 ('goodbase_phase_17_management','management_api','1.0.0','active','/api/goodbase/v1/enterprise/management','healthy','{"tokens":true,"idempotency":true,"automation":true}'::jsonb,'{"phase":17,"managedBy":"Goodbase"}'::jsonb,NOW(),NOW()),
 ('goodbase_phase_18_domains','custom_domains','1.0.0','active','/api/goodbase/v1/enterprise/domains','healthy','{"dns":true,"acme":true,"rollback":true}'::jsonb,'{"phase":18,"managedBy":"Goodbase"}'::jsonb,NOW(),NOW()),
 ('goodbase_phase_19_search','vector_search','1.0.0','active','/api/goodbase/v1/enterprise/search','healthy','{"keyword":true,"vector":true,"hybrid":true,"queues":true}'::jsonb,'{"phase":19,"managedBy":"Goodbase"}'::jsonb,NOW(),NOW()),
 ('goodbase_phase_20_regions','regional_infrastructure','1.0.0','active','/api/goodbase/v1/enterprise/infrastructure','healthy','{"regions":true,"capacity":true,"failover":true,"status":true}'::jsonb,'{"phase":20,"managedBy":"Goodbase"}'::jsonb,NOW(),NOW())
ON CONFLICT(id) DO UPDATE SET component=EXCLUDED.component,version=EXCLUDED.version,status=EXCLUDED.status,endpoint=EXCLUDED.endpoint,health_status=EXCLUDED.health_status,configuration_json=EXCLUDED.configuration_json,metadata_json=backend_data_plane_components.metadata_json||EXCLUDED.metadata_json,updated_at=NOW();

COMMIT;
