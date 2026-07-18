"use strict";

const deployment = require("../src/services/site-deployment.service");

async function main() {
  const runId = String(process.argv[2] || "").trim();
  if (!runId) {
    console.error("A deployment run id is required.");
    process.exit(2);
  }

  try {
    const result = await deployment.executeDeployment(runId);
    console.log(JSON.stringify(result));
    process.exit(0);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}

main();
