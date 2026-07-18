const crypto = require("crypto");

const {
  query,
} = require("../config/database");

const {
  logAudit,
} = require("./audit.service");

// GOODOS_BILLING_LIVE_SERVICE_V1

function serviceError(
  message,
  statusCode = 500
) {
  const error = new Error(message);
  error.statusCode = statusCode;

  return error;
}

function billingId(prefix) {
  return (
    `${prefix}_` +
    crypto.randomUUID().replace(/-/g, "")
  );
}

function camelizeKey(value) {
  return value.replace(
    /_([a-z])/g,
    (_, letter) => letter.toUpperCase()
  );
}

function camelizeRow(row) {
  if (!row) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(row).map(
      ([key, value]) => [
        camelizeKey(key),
        value,
      ]
    )
  );
}

function jsonValue(
  value,
  fallback
) {
  if (
    value === null ||
    value === undefined
  ) {
    return fallback;
  }

  if (
    typeof value === "object"
  ) {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizePlan(row) {
  const plan = camelizeRow(row);

  return {
    ...plan,
    included:
      jsonValue(
        plan.includedJson,
        {}
      ),
    limits:
      jsonValue(
        plan.limitsJson,
        {}
      ),
    features:
      jsonValue(
        plan.featuresJson,
        []
      ),
    metadata:
      jsonValue(
        plan.metadataJson,
        {}
      ),
  };
}

function normalizeCustomer(row) {
  const customer =
    camelizeRow(row);

  if (!customer) {
    return null;
  }

  return {
    ...customer,
    metadata:
      jsonValue(
        customer.metadataJson,
        {}
      ),
  };
}

function normalizeSubscription(row) {
  const subscription =
    camelizeRow(row);

  if (!subscription) {
    return null;
  }

  return {
    ...subscription,
    metadata:
      jsonValue(
        subscription.metadataJson,
        {}
      ),
  };
}

function normalizeInvoice(row) {
  const invoice =
    camelizeRow(row);

  if (!invoice) {
    return null;
  }

  const metadata =
    jsonValue(
      invoice.metadataJson,
      {}
    );

  return {
    ...invoice,
    metadata,
    invoicePdfUrl:
      metadata.invoicePdf ||
      metadata.invoicePdfUrl ||
      metadata.invoice_pdf ||
      null,
    hostedInvoiceUrl:
      metadata.hostedInvoiceUrl ||
      metadata.hosted_invoice_url ||
      null,
  };
}

function validEmail(value) {
  return (
    value.length >= 3 &&
    value.length <= 320 &&
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(
      value
    )
  );
}

async function requireOrganization(
  userId
) {
  const result = await query(
    `
      SELECT
        organization.id,
        organization.name,
        organization.slug,
        organization.plan,
        organization.status,

        membership.role
          AS membership_role,

        membership.status
          AS membership_status

      FROM backend_organizations
           organization

      JOIN backend_organization_memberships
           membership
        ON membership.organization_id =
           organization.id

      WHERE membership.user_id =
            $1::uuid

        AND membership.status =
            'active'

        AND organization.status =
            'active'

      ORDER BY
        CASE membership.role
          WHEN 'owner' THEN 1
          WHEN 'admin' THEN 2
          WHEN 'manager' THEN 3
          ELSE 4
        END

      LIMIT 1
    `,
    [
      userId,
    ]
  );

  if (result.rowCount === 0) {
    throw serviceError(
      "Active organization membership is required.",
      403
    );
  }

  return camelizeRow(
    result.rows[0]
  );
}

function canManageBilling(
  organization
) {
  return [
    "owner",
    "admin",
  ].includes(
    organization.membershipRole
  );
}

function stripePackageInstalled() {
  try {
    require.resolve("stripe");
    return true;
  } catch {
    return false;
  }
}

function providerStatus(plans) {
  const secretConfigured =
    Boolean(
      process.env.STRIPE_SECRET_KEY
    );

  const webhookConfigured =
    Boolean(
      process.env.STRIPE_WEBHOOK_SECRET
    );

  const mappedPlans =
    plans.filter(plan => {
      const metadata =
        plan.metadata || {};

      return Boolean(
        metadata.stripeMonthlyPriceId ||
        metadata.stripeAnnualPriceId ||
        metadata.stripePriceId
      );
    }).length;

  const packageInstalled =
    stripePackageInstalled();

  const ready =
    packageInstalled &&
    secretConfigured &&
    webhookConfigured &&
    mappedPlans > 0;

  const missing = [];

  if (!packageInstalled) {
    missing.push(
      "Stripe server package"
    );
  }

  if (!secretConfigured) {
    missing.push(
      "Stripe secret key"
    );
  }

  if (!webhookConfigured) {
    missing.push(
      "Stripe webhook secret"
    );
  }

  if (mappedPlans === 0) {
    missing.push(
      "Stripe plan price mappings"
    );
  }

  return {
    provider:
      process.env.PAYMENT_PROVIDER ||
      "stripe",
    packageInstalled,
    secretConfigured,
    webhookConfigured,
    mappedPlans,
    ready,
    missing,
  };
}

async function getBillingOverviewForUser(
  userId
) {
  const organization =
    await requireOrganization(userId);

  const [
    plansResult,
    customerResult,
    subscriptionResult,
    invoicesResult,
  ] = await Promise.all([
    query(
      `
        SELECT *
        FROM backend_billing_plans

        WHERE status = 'active'

          AND (
            organization_id =
              $1

            OR organization_id
               IS NULL
          )

        ORDER BY
          sort_order,
          annual_price_cents,
          monthly_price_cents,
          display_name
      `,
      [
        organization.id,
      ]
    ),

    query(
      `
        SELECT *
        FROM backend_billing_customers

        WHERE organization_id = $1
          AND status = 'active'

        ORDER BY
          updated_at DESC,
          created_at DESC

        LIMIT 1
      `,
      [
        organization.id,
      ]
    ),

    query(
      `
        SELECT *
        FROM backend_subscriptions

        WHERE organization_id = $1

        ORDER BY
          CASE status
            WHEN 'active' THEN 1
            WHEN 'trialing' THEN 2
            WHEN 'past_due' THEN 3
            ELSE 4
          END,

          updated_at DESC,
          created_at DESC

        LIMIT 1
      `,
      [
        organization.id,
      ]
    ),

    query(
      `
        SELECT *
        FROM backend_invoices

        WHERE organization_id = $1

        ORDER BY
          created_at DESC

        LIMIT 100
      `,
      [
        organization.id,
      ]
    ),
  ]);

  const plans =
    plansResult.rows.map(
      normalizePlan
    );

  const customer =
    normalizeCustomer(
      customerResult.rows[0]
    );

  const subscription =
    normalizeSubscription(
      subscriptionResult.rows[0]
    );

  const invoices =
    invoicesResult.rows.map(
      normalizeInvoice
    );

  const organizationPlan =
    String(
      organization.plan || ""
    ).toLowerCase();

  const currentPlan =
    plans.find(plan =>
      [
        String(
          plan.id || ""
        ).toLowerCase(),
        String(
          plan.name || ""
        ).toLowerCase(),
      ].includes(
        String(
          subscription?.planId ||
          organizationPlan
        ).toLowerCase()
      )
    ) ||
    plans.find(
      plan =>
        String(
          plan.name || ""
        ).toLowerCase() ===
        organizationPlan
    ) ||
    null;

  return {
    organization,
    canManage:
      canManageBilling(
        organization
      ),
    currentPlan,
    plans,
    customer,
    subscription,
    invoices,
    paymentMethods: [],
    provider:
      providerStatus(plans),
  };
}

async function updateBillingEmailForUser(
  userId,
  emailInput,
  requestMeta = {}
) {
  const organization =
    await requireOrganization(userId);

  if (
    !canManageBilling(
      organization
    )
  ) {
    throw serviceError(
      "Owner or admin access is required to update billing information.",
      403
    );
  }

  const email =
    String(emailInput || "")
      .trim()
      .toLowerCase();

  if (!validEmail(email)) {
    throw serviceError(
      "A valid billing email is required.",
      400
    );
  }

  const existing = await query(
    `
      SELECT id
      FROM backend_billing_customers

      WHERE organization_id = $1

      ORDER BY
        updated_at DESC,
        created_at DESC

      LIMIT 1
    `,
    [
      organization.id,
    ]
  );

  let result;

  if (existing.rowCount > 0) {
    result = await query(
      `
        UPDATE backend_billing_customers

        SET
          billing_email = $2,
          email =
            COALESCE(
              email,
              $2
            ),
          updated_at = NOW()

        WHERE id = $1

        RETURNING *
      `,
      [
        existing.rows[0].id,
        email,
      ]
    );
  } else {
    result = await query(
      `
        INSERT INTO backend_billing_customers (
          id,
          organization_id,
          user_id,
          name,
          email,
          provider,
          billing_email,
          tax_status,
          status,
          metadata_json,
          project_id,
          environment_id,
          created_by
        )
        VALUES (
          $1,
          $2,
          $3::uuid,
          $4,
          $5,
          'internal',
          $5,
          'not_configured',
          'active',
          $6::jsonb,
          'proj_goodos_platform',
          'env_goodos_production',
          $3::uuid
        )

        RETURNING *
      `,
      [
        billingId("billcust"),
        organization.id,
        userId,
        organization.name,
        email,
        JSON.stringify({
          source:
            "goodos_billing_live_v1",
        }),
      ]
    );
  }

  const customer =
    normalizeCustomer(
      result.rows[0]
    );

  await logAudit({
    userId,
    appId: "goodos",
    action:
      "billing.customer.updated",
    entityType:
      "billing_customer",
    entityId:
      customer.id,
    ipAddress:
      requestMeta.ipAddress ||
      null,
    metadata: {
      organizationId:
        organization.id,
      billingEmail: email,
    },
  });

  return customer;
}

module.exports = {
  getBillingOverviewForUser,
  updateBillingEmailForUser,
};
