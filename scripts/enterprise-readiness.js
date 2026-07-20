"use strict";

const { assessEnterpriseReadiness } = require("../src/enterprise/enterprise-readiness.service");
const { pool } = require("../src/config/database");

async function main() {
  const report = await assessEnterpriseReadiness();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "needs_attention" ? 1 : 0;
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
