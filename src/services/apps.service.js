const { query } = require("../config/database");

async function getAllApps() {
  const result = await query(
    `
    SELECT
      id,
      name,
      domain,
      status,
      description,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM apps
    ORDER BY name ASC
    `
  );

  return result.rows;
}

async function getAppById(appId) {
  const result = await query(
    `
    SELECT
      id,
      name,
      domain,
      status,
      description,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM apps
    WHERE id = $1
    LIMIT 1
    `,
    [appId]
  );

  return result.rows[0] || null;
}

module.exports = {
  getAllApps,
  getAppById
};
