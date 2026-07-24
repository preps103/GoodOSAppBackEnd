"use strict";

const database =
  require("../src/config/database");

const deployment =
  require(
    "../src/services/site-deployment.service"
  );

const { pool, query } = database;

const APPLY =
  process.argv.includes("--apply");

const PROCESS_BY_APP = {
  goodads: "goodads",
  goodbase: "goodapp-backend",
  goodboost: "goodboost",
  goodcustoms: "goodcustoms",
  gooddesigner: "gooddesigner",
  goodeditor: "goodeditor",
  goodescrow: "goodescrow",
  goodfleet: "goodfleet",
  goodos: "goodos",
  goodqr: "goodqr",
  goodscan: "goodscan",
  goodspeech: "goodspeech",
  goodswapz: "goodswapz",
  goodtrusts: "goodtrusts",
  goodvoice: "goodvoice",
};

function comparableRepository(value) {
  return String(value || "")
    .trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "")
    .toLowerCase();
}

function assertCompatible(
  label,
  current,
  discovered,
  comparator = (left, right) => left === right
) {
  if (!current) return;

  if (!comparator(current, discovered)) {
    throw new Error(
      `${label} already contains a different value. ` +
      `Current=${current}; discovered=${discovered}`
    );
  }
}

async function main() {
  const siteResult = await query(`
    SELECT
      id,
      app_id AS "appId",
      name,
      domain,
      branch,
      process_manager AS "processManager",
      process_name AS "processName",
      app_path AS "appPath",
      repository_url AS "repositoryUrl",
      health_url AS "healthUrl"
    FROM backend_deployment_sites
    WHERE status <> 'retired'
    ORDER BY name
  `);

  const sites = siteResult.rows;

  if (sites.length !== 15) {
    throw new Error(
      `Expected 15 active deployment sites; found ${sites.length}.`
    );
  }

  const unknownApps =
    sites.filter(
      (site) => !PROCESS_BY_APP[site.appId]
    );

  if (unknownApps.length) {
    throw new Error(
      `Unknown deployment app IDs: ${
        unknownApps
          .map((site) => site.appId)
          .join(", ")
      }`
    );
  }

  const targets =
    await deployment.discoverServerApps();

  const targetByName =
    new Map(
      targets.map(
        (target) => [
          target.processName,
          target,
        ]
      )
    );

  const plan =
    sites.map((site) => {
      const processName =
        PROCESS_BY_APP[site.appId];

      const target =
        targetByName.get(processName);

      if (!target) {
        throw new Error(
          `PM2 target ${processName} was not discovered for ${site.name}.`
        );
      }

      if (target.status !== "online") {
        throw new Error(
          `PM2 target ${processName} is ${target.status}, not online.`
        );
      }

      if (!target.appPath) {
        throw new Error(
          `PM2 target ${processName} has no application path.`
        );
      }

      if (!target.repositoryUrl) {
        throw new Error(
          `PM2 target ${processName} has no Git repository origin.`
        );
      }

      assertCompatible(
        `${site.name} process`,
        site.processName,
        target.processName
      );

      assertCompatible(
        `${site.name} path`,
        site.appPath,
        target.appPath
      );

      assertCompatible(
        `${site.name} repository`,
        site.repositoryUrl,
        target.repositoryUrl,
        (left, right) =>
          comparableRepository(left) ===
          comparableRepository(right)
      );

      const healthUrl =
        site.healthUrl ||
        (
          site.domain
            ? `https://${site.domain}`
            : ""
        );

      if (!healthUrl) {
        throw new Error(
          `${site.name} has no health URL or domain.`
        );
      }

      return {
        id: site.id,
        appId: site.appId,
        name: site.name,
        domain: site.domain,
        processManager: "pm2",
        processName: target.processName,
        appPath: target.appPath,
        repositoryUrl: target.repositoryUrl,
        branch:
          site.branch ||
          target.branch ||
          "main",
        healthUrl,
      };
    });

  console.log(
    JSON.stringify(
      {
        mode:
          APPLY
            ? "APPLY"
            : "CHECK_ONLY",
        mappings: plan,
      },
      null,
      2
    )
  );

  if (!APPLY) {
    console.log(
      "PASS: All 15 exact PM2 mappings are safe to apply."
    );
    return;
  }

  const client =
    await pool.connect();

  try {
    await client.query("BEGIN");

    for (const item of plan) {
      await client.query(
        `
          UPDATE backend_deployment_sites
          SET
            process_manager = $2,
            process_name = $3,
            app_path = $4,
            repository_url = $5,
            branch = $6,
            health_url = $7,
            status = 'ready',
            metadata_json =
              COALESCE(
                metadata_json,
                '{}'::jsonb
              ) ||
              jsonb_build_object(
                'phase',
                20,
                'mappingSource',
                'verified-pm2-discovery',
                'mappedAt',
                NOW()
              ),
            updated_at = NOW()
          WHERE id = $1
        `,
        [
          item.id,
          item.processManager,
          item.processName,
          item.appPath,
          item.repositoryUrl,
          item.branch,
          item.healthUrl,
        ]
      );
    }

    const verification =
      await client.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (
            WHERE status = 'ready'
              AND NULLIF(process_name, '') IS NOT NULL
              AND NULLIF(app_path, '') IS NOT NULL
              AND NULLIF(repository_url, '') IS NOT NULL
              AND NULLIF(health_url, '') IS NOT NULL
          )::int AS ready
        FROM backend_deployment_sites
      `);

    const result =
      verification.rows[0];

    if (
      result.total !== 16 ||
      result.ready !== 16
    ) {
      throw new Error(
        `Mapping verification failed: total=${result.total}, ready=${result.ready}`
      );
    }

    await client.query("COMMIT");

    console.log(
      "PASS: All 16 deployment-site mappings were applied transactionally."
    );
  } catch (error) {
    await client
      .query("ROLLBACK")
      .catch(() => {});

    throw error;
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error(
      error.stack ||
      error.message
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await pool
      .end()
      .catch(() => {});
  });
