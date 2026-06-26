const jobService = require("../src/services/job.service");

async function main() {
  const jobId = process.argv[2];

  if (!jobId) {
    console.error("Usage: node scripts/run-job-once.js <job-id-or-name>");
    process.exit(1);
  }

  const result = await jobService.runJobById(jobId, {
    workerId: `manual-${process.pid}`,
    source: "scripts/run-job-once.js",
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
