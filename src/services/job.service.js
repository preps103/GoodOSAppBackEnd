const crypto = require("crypto");
const os = require("os");
const database = require("../config/database");
const notificationService = require("./notification.service");

function dbQuery(sql, params = []) {
  if (typeof database.query === "function") return database.query(sql, params);
  if (database.pool && typeof database.pool.query === "function") return database.pool.query(sql, params);
  if (typeof database.getPool === "function") return database.getPool().query(sql, params);
  if (database.default && typeof database.default.query === "function") return database.default.query(sql, params);
  throw new Error("Database query function not found");
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function nowMs() {
  return Date.now();
}

function workerIdFromEnv() {
  return process.env.GOODAPP_WORKER_ID || `${os.hostname()}-${process.pid}`;
}

async function acquireLock(lockKey, ownerId, ttlSeconds = 120) {
  const lockId = `lock_${lockKey.replace(/[^a-zA-Z0-9]/g, "_")}`;

  const result = await dbQuery(
    `
      INSERT INTO backend_worker_locks (
        id,
        lock_key,
        owner_id,
        locked_until,
        status,
        metadata_json
      )
      VALUES ($1,$2,$3,NOW() + ($4::text || ' seconds')::interval,'locked',$5::jsonb)
      ON CONFLICT (lock_key) DO UPDATE
      SET owner_id = EXCLUDED.owner_id,
          locked_until = EXCLUDED.locked_until,
          acquired_at = NOW(),
          released_at = NULL,
          status = 'locked',
          updated_at = NOW()
      WHERE backend_worker_locks.locked_until < NOW()
         OR backend_worker_locks.owner_id = EXCLUDED.owner_id
         OR backend_worker_locks.status <> 'locked'
      RETURNING *
    `,
    [
      lockId,
      lockKey,
      ownerId,
      ttlSeconds,
      JSON.stringify({ acquiredBy: ownerId }),
    ]
  );

  return Boolean(result.rows[0]);
}

async function releaseLock(lockKey, ownerId) {
  await dbQuery(
    `
      UPDATE backend_worker_locks
      SET status = 'released',
          released_at = NOW(),
          updated_at = NOW()
      WHERE lock_key = $1
        AND owner_id = $2
    `,
    [lockKey, ownerId]
  ).catch(() => null);
}

async function heartbeat(workerId = workerIdFromEnv(), status = "online", metadata = {}) {
  await dbQuery(
    `
      INSERT INTO backend_worker_heartbeats (
        id,
        worker_id,
        worker_name,
        hostname,
        pid,
        status,
        last_seen_at,
        started_at,
        metadata_json
      )
      VALUES ($1,$2,$3,$4,$5,$6,NOW(),NOW(),$7::jsonb)
      ON CONFLICT (worker_id) DO UPDATE
      SET status = EXCLUDED.status,
          last_seen_at = NOW(),
          hostname = EXCLUDED.hostname,
          pid = EXCLUDED.pid,
          metadata_json = backend_worker_heartbeats.metadata_json || EXCLUDED.metadata_json,
          updated_at = NOW()
    `,
    [
      `heartbeat_${workerId.replace(/[^a-zA-Z0-9]/g, "_")}`,
      workerId,
      process.env.GOODAPP_WORKER_NAME || "goodapp-worker",
      os.hostname(),
      process.pid,
      status,
      JSON.stringify(metadata || {}),
    ]
  );
}

async function finishRun(runId, status, startedAtMs, result = {}, errorMessage = null) {
  await dbQuery(
    `
      UPDATE backend_job_runs
      SET status = $2,
          finished_at = NOW(),
          duration_ms = $3,
          result_json = $4::jsonb,
          error_message = $5
      WHERE id = $1
    `,
    [
      runId,
      status,
      Math.max(0, nowMs() - startedAtMs),
      JSON.stringify(result || {}),
      errorMessage,
    ]
  );
}

async function updateJobAfterRun(job, status, result = {}, errorMessage = null) {
  await dbQuery(
    `
      UPDATE backend_jobs
      SET last_run_at = NOW(),
          next_run_at = NOW() + (schedule_seconds::text || ' seconds')::interval,
          last_status = $2,
          last_error = $3,
          updated_at = NOW()
      WHERE id = $1
    `,
    [job.id, status, errorMessage]
  );

  await dbQuery(
    `
      UPDATE backend_job_schedules
      SET last_enqueued_at = NOW(),
          next_run_at = NOW() + (interval_seconds::text || ' seconds')::interval,
          updated_at = NOW()
      WHERE job_id = $1
    `,
    [job.id]
  ).catch(() => null);
}

async function runEmailQueueProcess() {
  return notificationService.processEmailQueue(25);
}

async function runAlertRulesEvaluate() {
  return notificationService.evaluateAlertRules();
}

async function runExpiredSessionsCleanup() {
  const result = await dbQuery(
    `
      UPDATE sessions
      SET revoked_at = COALESCE(revoked_at, NOW()),
          metadata_json = COALESCE(metadata_json, '{}'::jsonb) || '{"revokedBy":"background_jobs_v2_expired_cleanup"}'::jsonb
      WHERE expires_at <= NOW()
        AND revoked_at IS NULL
      RETURNING id
    `
  );

  return {
    revokedCount: result.rows.length,
  };
}

async function runQuotaCountersRefresh() {
  const result = await dbQuery(
    `
      UPDATE backend_quota_counters
      SET status = CASE
            WHEN quota_limit > 0 AND quantity >= quota_limit THEN 'over_limit'
            WHEN quota_limit > 0 AND quantity >= (quota_limit * 0.8) THEN 'warning'
            ELSE 'ok'
          END,
          updated_at = NOW()
      RETURNING id, metric_key, quantity, quota_limit, status
    `
  );

  return {
    refreshedCount: result.rows.length,
    counters: result.rows,
  };
}

async function runDigestJobsProcess() {
  const due = await dbQuery(
    `
      SELECT *
      FROM backend_digest_jobs
      WHERE status = 'scheduled'
        AND scheduled_for <= NOW()
      ORDER BY scheduled_for ASC
      LIMIT 25
    `
  );

  const processed = [];

  for (const job of due.rows) {
    await dbQuery(
      `
        UPDATE backend_digest_jobs
        SET status = 'processed',
            processed_at = NOW(),
            updated_at = NOW(),
            metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $2::jsonb
        WHERE id = $1
      `,
      [
        job.id,
        JSON.stringify({ processedBy: "background_jobs_v2", workerId: workerIdFromEnv() }),
      ]
    );

    processed.push({ id: job.id, email: job.email, category: job.category });
  }

  return {
    processedCount: processed.length,
    processed,
  };
}

async function runWebhookRetryScan() {
  const result = await dbQuery(
    `
      SELECT COUNT(*)::int AS count
      FROM backend_webhook_deliveries
      WHERE status IN ('failed','retrying')
        AND next_retry_at IS NOT NULL
        AND next_retry_at <= NOW()
    `
  );

  return {
    pendingRetryCount: result.rows[0]?.count || 0,
    note: "Phase 24A scans webhook retry backlog. Existing admin retry processor remains available for actual delivery retries.",
  };
}

function cronFieldMatches(field, value, minimum, maximum) {
  return String(field).split(",").some((part) => {
    const [rangePart, stepPart] = part.split("/");
    const step = Math.max(Number(stepPart || 1), 1);
    if (rangePart === "*") return (value - minimum) % step === 0;
    const [startText, endText] = rangePart.split("-");
    const start = Number(startText);
    const end = endText == null ? start : Number(endText);
    return Number.isInteger(start) && Number.isInteger(end) && start >= minimum && end <= maximum && value >= start && value <= end && (value - start) % step === 0;
  });
}

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC", minute: "2-digit", hour: "2-digit", hourCycle: "h23",
    day: "2-digit", month: "2-digit", weekday: "short",
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return {
    minute: Number(parts.minute), hour: Number(parts.hour), day: Number(parts.day), month: Number(parts.month),
    weekday: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(parts.weekday),
  };
}

function nextCronOccurrence(expression, timezone = "UTC", from = new Date()) {
  const fields = String(expression || "").trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron expressions must contain five fields.");
  let candidate = new Date(Math.floor(from.getTime() / 60000) * 60000 + 60000);
  for (let index = 0; index < 527040; index += 1, candidate = new Date(candidate.getTime() + 60000)) {
    const value = zonedParts(candidate, timezone);
    if (cronFieldMatches(fields[0],value.minute,0,59) && cronFieldMatches(fields[1],value.hour,0,23) &&
        cronFieldMatches(fields[2],value.day,1,31) && cronFieldMatches(fields[3],value.month,1,12) &&
        cronFieldMatches(fields[4],value.weekday,0,6)) return candidate;
  }
  throw new Error("Cron expression has no occurrence within one year.");
}

async function runGoodbaseQueueMaintenance() {
  const released = await dbQuery(`
    UPDATE goodbase_queue_messages SET
      status=CASE WHEN attempts>=max_attempts THEN 'dead_lettered' ELSE 'available' END,
      available_at=CASE WHEN attempts>=max_attempts THEN available_at ELSE NOW()+make_interval(secs=>LEAST(3600,power(2,LEAST(attempts,11))::int)) END,
      lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=NOW()
    WHERE status='leased' AND lease_expires_at<=NOW() RETURNING id,status
  `);
  const archived = await dbQuery(`
    DELETE FROM goodbase_queue_messages message USING goodbase_queues queue
    WHERE message.queue_id=queue.id AND message.status IN ('completed','archived')
      AND COALESCE(message.archived_at,message.completed_at,message.updated_at) < NOW()-make_interval(secs=>queue.retention_seconds)
    RETURNING message.id
  `);
  return { releasedLeases: released.rows.length, deadLettered: released.rows.filter((row)=>row.status==="dead_lettered").length, purgedArchived: archived.rows.length };
}

async function executeGoodbaseSchedule(schedule) {
  const payload = schedule.payload_json || {};
  if (schedule.target_type === "queue") {
    const sent = await dbQuery(`SELECT goodbase_queue_send($1,$2::jsonb,$3,0,100) AS id`, [schedule.target_ref, JSON.stringify(payload), `schedule:${schedule.id}:${schedule.next_run_at.toISOString()}`]);
    return { messageId: sent.rows[0].id };
  }
  if (schedule.target_type === "sql_function") {
    if (!/^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$/.test(schedule.target_ref)) throw new Error("Scheduled SQL function reference is invalid.");
    const [schema, fn] = schedule.target_ref.split(".");
    const result = await dbQuery(`SELECT "${schema}"."${fn}"($1::jsonb) AS result`, [JSON.stringify(payload)]);
    return { result: result.rows[0]?.result ?? null };
  }
  if (schedule.target_type === "http") {
    const url = new URL(schedule.target_ref);
    if (url.protocol !== "https:" || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[?::1)/i.test(url.hostname)) throw new Error("Scheduled HTTP target is not allowed.");
    const result = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(schedule.headers_json || {}) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(schedule.timeout_seconds * 1000) });
    return { status: result.status, ok: result.ok };
  }
  if (schedule.target_type === "edge_function") {
    const fn = await dbQuery(`SELECT function.*,version.bundle_ref,version.version FROM goodbase_edge_functions function JOIN goodbase_edge_versions version ON version.function_id=function.id AND version.version=function.active_version WHERE function.id=$1 AND function.status='active'`, [schedule.target_ref]);
    if (!fn.rowCount) throw new Error("Scheduled edge function has no active version.");
    const item = fn.rows[0];
    const result = await fetch(`${process.env.GOODBASE_EDGE_RUNTIME_URL || "http://127.0.0.1:8500"}/invoke`, { method:"POST", headers:{"content-type":"application/json"}, signal:AbortSignal.timeout(item.timeout_ms+2500), body:JSON.stringify({ functionId:item.id,version:item.version,bundleRef:item.bundle_ref,timeoutMs:item.timeout_ms,responseLimitBytes:item.response_limit_bytes,networkPolicy:item.network_policy,networkAllowlist:item.network_allowlist,input:payload }) });
    if (!result.ok) throw new Error(`Edge runtime returned HTTP ${result.status}.`);
    return result.json();
  }
  throw new Error("Unsupported schedule target.");
}

async function runGoodbaseSchedules() {
  const ownerId = workerIdFromEnv();
  const due = await dbQuery(`
    SELECT schedule.* FROM goodbase_schedules schedule
    WHERE schedule.status='active' AND schedule.next_run_at<=NOW()
      AND (SELECT COUNT(*) FROM goodbase_schedule_runs run WHERE run.schedule_id=schedule.id AND run.status='running') < schedule.concurrency_limit
    ORDER BY schedule.next_run_at FOR UPDATE SKIP LOCKED LIMIT 25
  `);
  const runs = [];
  for (const schedule of due.rows) {
    const runId = crypto.randomUUID();
    const started = Date.now();
    const nextRun = schedule.interval_seconds
      ? new Date(Date.now() + schedule.interval_seconds * 1000)
      : nextCronOccurrence(schedule.cron_expression, schedule.timezone);
    await dbQuery(`INSERT INTO goodbase_schedule_runs(id,schedule_id,status,worker_id,scheduled_for,started_at) VALUES($1,$2,'running',$3,$4,NOW())`,[runId,schedule.id,ownerId,schedule.next_run_at]);
    await dbQuery(`UPDATE goodbase_schedules SET last_run_at=NOW(),next_run_at=$2,updated_at=NOW() WHERE id=$1`,[schedule.id,nextRun]);
    try {
      const result = await executeGoodbaseSchedule(schedule);
      await dbQuery(`UPDATE goodbase_schedule_runs SET status='succeeded',finished_at=NOW(),duration_ms=$2,result_json=$3::jsonb WHERE id=$1`,[runId,Date.now()-started,JSON.stringify(result)]);
      runs.push({ scheduleId:schedule.id,runId,status:"succeeded" });
    } catch (error) {
      await dbQuery(`UPDATE goodbase_schedule_runs SET status='failed',finished_at=NOW(),duration_ms=$2,error_message=$3 WHERE id=$1`,[runId,Date.now()-started,String(error.message).slice(0,2000)]);
      runs.push({ scheduleId:schedule.id,runId,status:"failed",error:error.message });
    }
  }
  return { dueCount:due.rows.length,runs };
}

async function runQueueItemProcessor() {
  const ownerId = workerIdFromEnv();

  const items = await dbQuery(
    `
      UPDATE backend_queue_items
      SET status = 'processing',
          locked_by = $1,
          locked_until = NOW() + INTERVAL '5 minutes',
          attempts = attempts + 1,
          updated_at = NOW()
      WHERE id IN (
        SELECT id
        FROM backend_queue_items
        WHERE status = 'pending'
          AND scheduled_at <= NOW()
        ORDER BY priority ASC, scheduled_at ASC
        LIMIT 25
      )
      RETURNING *
    `,
    [ownerId]
  );

  const processed = [];

  for (const item of items.rows) {
    await dbQuery(
      `
        UPDATE backend_queue_items
        SET status = 'completed',
            processed_at = NOW(),
            locked_by = NULL,
            locked_until = NULL,
            metadata_json = COALESCE(metadata_json, '{}'::jsonb) || $2::jsonb,
            updated_at = NOW()
        WHERE id = $1
      `,
      [
        item.id,
        JSON.stringify({ processedBy: ownerId }),
      ]
    );

    processed.push({ id: item.id, queueName: item.queue_name, handlerKey: item.handler_key });
  }

  return {
    processedCount: processed.length,
    processed,
  };
}

async function runHandler(handlerKey) {
  switch (handlerKey) {
    case "notifications.email_queue.process":
      return runEmailQueueProcess();
    case "notifications.alert_rules.evaluate":
      return runAlertRulesEvaluate();
    case "security.sessions.cleanup_expired":
      return runExpiredSessionsCleanup();
    case "usage.quota_counters.refresh":
      return runQuotaCountersRefresh();
    case "notifications.digest.process":
      return runDigestJobsProcess();
    case "webhooks.retry.scan":
      return runWebhookRetryScan();
    case "queue.items.process":
      return runQueueItemProcessor();
    case "goodbase.queues.maintain":
      return runGoodbaseQueueMaintenance();
    case "goodbase.schedules.dispatch":
      return runGoodbaseSchedules();
    default:
      return {
        skipped: true,
        message: `No handler implemented for ${handlerKey}`,
      };
  }
}

async function runJob(job, options = {}) {
  const workerId = options.workerId || workerIdFromEnv();
  const lockKey = job.concurrency_key || job.handler_key || job.name;
  const lockAcquired = await acquireLock(lockKey, workerId, Number(job.timeout_seconds || 120));

  if (!lockAcquired) {
    return {
      skipped: true,
      reason: "lock_not_acquired",
      jobId: job.id,
      jobName: job.name,
    };
  }

  const runId = randomId("jobrun");
  const startedAt = nowMs();

  await dbQuery(
    `
      INSERT INTO backend_job_runs (
        id,
        job_id,
        job_name,
        handler_key,
        worker_id,
        status,
        attempt,
        started_at,
        metadata_json,
        organization_id,
        project_id,
        environment_id
      )
      VALUES ($1,$2,$3,$4,$5,'running',1,NOW(),$6::jsonb,$7,$8,$9)
    `,
    [
      runId,
      job.id,
      job.name,
      job.handler_key,
      workerId,
      JSON.stringify({ manual: Boolean(options.manual), source: options.source || "background-worker" }),
      job.organization_id || "org_goodos",
      job.project_id || "proj_goodos_platform",
      job.environment_id || "env_goodos_production",
    ]
  );

  try {
    const result = await runHandler(job.handler_key);

    await finishRun(runId, "completed", startedAt, result, null);
    await updateJobAfterRun(job, "completed", result, null);

    return {
      runId,
      jobId: job.id,
      jobName: job.name,
      handlerKey: job.handler_key,
      status: "completed",
      result,
    };
  } catch (error) {
    await finishRun(runId, "failed", startedAt, { error: error.message }, error.message);
    await updateJobAfterRun(job, "failed", {}, error.message);

    return {
      runId,
      jobId: job.id,
      jobName: job.name,
      handlerKey: job.handler_key,
      status: "failed",
      error: error.message,
    };
  } finally {
    await releaseLock(lockKey, workerId);
  }
}

async function runJobById(jobId, options = {}) {
  const result = await dbQuery(
    `
      SELECT *
      FROM backend_jobs
      WHERE id = $1 OR name = $1
      LIMIT 1
    `,
    [jobId]
  );

  const job = result.rows[0];

  if (!job) {
    const error = new Error("Job not found");
    error.statusCode = 404;
    throw error;
  }

  return runJob(job, {
    ...options,
    manual: true,
    source: options.source || "manual",
  });
}

async function runDueJobs(options = {}) {
  const limit = Math.min(Math.max(Number(options.limit || 10), 1), 50);

  const result = await dbQuery(
    `
      SELECT *
      FROM backend_jobs
      WHERE status = 'active'
        AND next_run_at <= NOW()
      ORDER BY priority ASC, next_run_at ASC
      LIMIT $1
    `,
    [limit]
  );

  const runs = [];

  for (const job of result.rows) {
    runs.push(await runJob(job, options));
  }

  return {
    dueCount: result.rows.length,
    runs,
  };
}

async function getJobsSnapshot() {
  const jobs = await dbQuery(`
    SELECT
      id,
      name,
      display_name AS "displayName",
      description,
      job_type AS "jobType",
      handler_key AS "handlerKey",
      status,
      priority,
      schedule_seconds AS "scheduleSeconds",
      timeout_seconds AS "timeoutSeconds",
      last_run_at AS "lastRunAt",
      next_run_at AS "nextRunAt",
      last_status AS "lastStatus",
      last_error AS "lastError",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM backend_jobs
    ORDER BY priority ASC, name ASC
    LIMIT 300
  `);

  const schedules = await dbQuery(`
    SELECT
      id,
      job_id AS "jobId",
      schedule_type AS "scheduleType",
      interval_seconds AS "intervalSeconds",
      cron_expression AS "cronExpression",
      timezone,
      enabled,
      next_run_at AS "nextRunAt",
      last_enqueued_at AS "lastEnqueuedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM backend_job_schedules
    ORDER BY next_run_at ASC
    LIMIT 300
  `);

  const runs = await dbQuery(`
    SELECT
      id,
      job_id AS "jobId",
      job_name AS "jobName",
      handler_key AS "handlerKey",
      worker_id AS "workerId",
      status,
      attempt,
      started_at AS "startedAt",
      finished_at AS "finishedAt",
      duration_ms AS "durationMs",
      result_json AS "result",
      error_message AS "errorMessage",
      created_at AS "createdAt"
    FROM backend_job_runs
    ORDER BY created_at DESC
    LIMIT 300
  `);

  const locks = await dbQuery(`
    SELECT
      id,
      lock_key AS "lockKey",
      owner_id AS "ownerId",
      locked_until AS "lockedUntil",
      acquired_at AS "acquiredAt",
      released_at AS "releasedAt",
      status,
      updated_at AS "updatedAt"
    FROM backend_worker_locks
    ORDER BY updated_at DESC
    LIMIT 300
  `);

  const heartbeats = await dbQuery(`
    SELECT
      id,
      worker_id AS "workerId",
      worker_name AS "workerName",
      hostname,
      pid,
      status,
      last_seen_at AS "lastSeenAt",
      started_at AS "startedAt",
      updated_at AS "updatedAt"
    FROM backend_worker_heartbeats
    ORDER BY last_seen_at DESC
    LIMIT 300
  `);

  const queueItems = await dbQuery(`
    SELECT
      id,
      queue_name AS "queueName",
      item_type AS "itemType",
      status,
      priority,
      handler_key AS "handlerKey",
      attempts,
      max_attempts AS "maxAttempts",
      scheduled_at AS "scheduledAt",
      locked_by AS "lockedBy",
      processed_at AS "processedAt",
      error_message AS "errorMessage",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM backend_queue_items
    ORDER BY created_at DESC
    LIMIT 300
  `);

  return {
    jobs: jobs.rows,
    schedules: schedules.rows,
    runs: runs.rows,
    locks: locks.rows,
    heartbeats: heartbeats.rows,
    queueItems: queueItems.rows,
    counts: {
      jobs: jobs.rows.length,
      activeJobs: jobs.rows.filter((item) => item.status === "active").length,
      failedRuns: runs.rows.filter((item) => item.status === "failed").length,
      completedRuns: runs.rows.filter((item) => item.status === "completed").length,
      onlineWorkers: heartbeats.rows.filter((item) => item.status === "online").length,
      queuePending: queueItems.rows.filter((item) => item.status === "pending").length,
      locks: locks.rows.filter((item) => item.status === "locked").length,
    },
  };
}

module.exports = {
  dbQuery,
  heartbeat,
  runDueJobs,
  runJobById,
  getJobsSnapshot,
  runHandler,
};
