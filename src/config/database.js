const { Pool } = require("pg");
const env = require("./env");

if (!env.databaseUrl) {
  console.warn("DATABASE_URL is not set.");
}

const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

async function query(text, params) {
  return pool.query(text, params);
}

async function checkDatabaseHealth() {
  const result = await query(`
    SELECT 
      current_database() AS database,
      current_user AS user,
      NOW() AS timestamp
  `);

  return result.rows[0];
}

module.exports = {
  pool,
  query,
  checkDatabaseHealth
};
