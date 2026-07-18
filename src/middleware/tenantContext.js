"use strict";

const {
  resolveTenantContext,
} = require(
  "../services/tenant-context.service"
);

const {
  query,
} = require(
  "../config/database"
);

function headerValue(
  request,
  name
) {
  const value =
    request.get(name);

  return value
    ? String(value).trim()
    : null;
}

async function recordDenial({
  request,
  error,
}) {
  try {
    await query(
      `
        INSERT INTO audit_logs (
          user_id,
          action,
          entity_type,
          entity_id,
          ip_address,
          metadata
        )
        VALUES (
          $1,
          'tenant.context.denied',
          'tenant_context',
          $2,
          $3,
          $4::jsonb
        )
      `,
      [
        request.user?.id || null,

        headerValue(
          request,
          "X-GoodOS-Organization-ID"
        ),

        request.ip || null,

        JSON.stringify({
          code:
            error.code || null,

          path:
            request.originalUrl,

          requestedOrganizationId:
            headerValue(
              request,
              "X-GoodOS-Organization-ID"
            ),

          requestedProjectId:
            headerValue(
              request,
              "X-GoodOS-Project-ID"
            ),

          requestedEnvironmentId:
            headerValue(
              request,
              "X-GoodOS-Environment-ID"
            ),
        }),
      ]
    );
  } catch {
    // A security response cannot depend on audit availability.
  }
}

async function tenantContext(
  request,
  response,
  next
) {
  try {
    request.tenantContext =
      await resolveTenantContext({
        userId:
          request.user?.id,

        organizationId:
          headerValue(
            request,
            "X-GoodOS-Organization-ID"
          ),

        projectId:
          headerValue(
            request,
            "X-GoodOS-Project-ID"
          ),

        environmentId:
          headerValue(
            request,
            "X-GoodOS-Environment-ID"
          ),
      });

    return next();
  } catch (error) {
    if (
      request.user?.id &&
      Number(
        error.statusCode || 500
      ) === 403
    ) {
      await recordDenial({
        request,
        error,
      });
    }

    return response
      .status(
        error.statusCode || 500
      )
      .json({
        success: false,

        code:
          error.code ||
          "TENANT_CONTEXT_FAILED",

        message:
          error.message ||
          "Tenant context could not be resolved.",
      });
  }
}

module.exports =
  tenantContext;
