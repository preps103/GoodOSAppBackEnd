require("dotenv").config();

const bcrypt = require("bcryptjs");
const { query, pool } = require("../src/config/database");

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const firstName = process.env.ADMIN_FIRST_NAME || "GoodOS";
  const lastName = process.env.ADMIN_LAST_NAME || "Owner";
  const displayName = process.env.ADMIN_DISPLAY_NAME || `${firstName} ${lastName}`;

  if (!email || !password) {
    console.error("Missing ADMIN_EMAIL or ADMIN_PASSWORD.");
    process.exit(1);
  }

  if (password.length < 10) {
    console.error("Password must be at least 10 characters.");
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const userResult = await query(
    `
    INSERT INTO users (
      email,
      password_hash,
      first_name,
      last_name,
      display_name,
      platform_role,
      status,
      email_verified
    )
    VALUES (
      LOWER($1),
      $2,
      $3,
      $4,
      $5,
      'owner',
      'active',
      true
    )
    ON CONFLICT (LOWER(email))
    DO UPDATE SET
      password_hash = EXCLUDED.password_hash,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      display_name = EXCLUDED.display_name,
      platform_role = 'owner',
      status = 'active',
      email_verified = true,
      updated_at = NOW()
    RETURNING id, email, first_name, last_name, display_name, platform_role, status, email_verified;
    `,
    [email, passwordHash, firstName, lastName, displayName]
  );

  const user = userResult.rows[0];

  await query(
    `
    INSERT INTO app_memberships (user_id, app_id, role, status)
    SELECT $1, id, 'owner', 'active'
    FROM apps
    ON CONFLICT (user_id, app_id)
    DO UPDATE SET
      role = 'owner',
      status = 'active',
      updated_at = NOW();
    `,
    [user.id]
  );

  const membershipResult = await query(
    `
    SELECT 
      am.app_id,
      a.name,
      am.role,
      am.status
    FROM app_memberships am
    JOIN apps a ON a.id = am.app_id
    WHERE am.user_id = $1
    ORDER BY a.name ASC;
    `,
    [user.id]
  );

  console.log("Owner user created/updated:");
  console.log({
    id: user.id,
    email: user.email,
    name: user.display_name,
    platformRole: user.platform_role,
    status: user.status,
    emailVerified: user.email_verified,
    appMemberships: membershipResult.rows.length
  });

  console.table(membershipResult.rows);
}

main()
  .catch((err) => {
    console.error("Seed owner failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
