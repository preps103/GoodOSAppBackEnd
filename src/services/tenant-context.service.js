"use strict";

const {
  query,
} = require("../config/database");

function tenantError(
  message,
  statusCode,
  code
) {
  const error = new Error(message);

  error.statusCode = statusCode;
  error.code = code;

  return error;
}

function cleanIdentifier(value) {
  const cleaned = String(
    value || ""
  ).trim();

  return cleaned || null;
}

async function loadOrganizations(userId) {
  const result = await query(
    `
      SELECT
        organization.id,
        organization.name,
        organization.slug,
        organization.plan,
        organization.status,

        membership.role
          AS "membershipRole",

        membership.status
          AS "membershipStatus"

      FROM backend_organization_memberships
           AS membership

      JOIN backend_organizations
           AS organization
        ON organization.id =
           membership.organization_id

      WHERE membership.user_id =
            $1::uuid

        AND membership.status =
            'active'

      ORDER BY organization.created_at ASC
    `,
    [userId]
  );

  return result.rows;
}

async function loadProjects({
  userId,
  organizationId,
  organizationRole,
}) {
  const elevated = [
    "owner",
    "admin",
    "manager",
  ].includes(
    String(
      organizationRole || ""
    ).toLowerCase()
  );

  const result = await query(
    `
      SELECT
        project.*,

        membership.role
          AS "membershipRole",

        membership.status
          AS "membershipStatus"

      FROM backend_projects AS project

      LEFT JOIN
        backend_project_memberships
        AS membership

        ON membership.project_id =
           project.id

       AND membership.user_id =
           $1::uuid

      WHERE project.organization_id =
            $2

        AND (
          $3::boolean
          OR membership.status =
             'active'
        )

      ORDER BY
        project.created_at ASC
    `,
    [
      userId,
      organizationId,
      elevated,
    ]
  );

  return result.rows;
}

async function loadEnvironments(
  projectId
) {
  if (!projectId) {
    return [];
  }

  const result = await query(
    `
      SELECT environment.*
      FROM backend_project_environments
           AS environment
      WHERE environment.project_id =
            $1
      ORDER BY environment.created_at ASC
    `,
    [projectId]
  );

  return result.rows;
}

async function resolveTenantContext({
  userId,
  organizationId,
  projectId,
  environmentId,
}) {
  if (!userId) {
    throw tenantError(
      "Authenticated user context is required.",
      401,
      "AUTHENTICATED_USER_REQUIRED"
    );
  }

  const requestedOrganization =
    cleanIdentifier(organizationId);

  const requestedProject =
    cleanIdentifier(projectId);

  const requestedEnvironment =
    cleanIdentifier(environmentId);

  const organizations =
    await loadOrganizations(userId);

  if (organizations.length === 0) {
    throw tenantError(
      "An active organization membership is required.",
      403,
      "ORGANIZATION_MEMBERSHIP_REQUIRED"
    );
  }

  const organization =
    requestedOrganization
      ? organizations.find(
          item =>
            String(item.id) ===
            requestedOrganization
        )
      : organizations[0];

  if (!organization) {
    throw tenantError(
      "The requested organization is not available to this user.",
      403,
      "ORGANIZATION_ACCESS_DENIED"
    );
  }

  const projects =
    await loadProjects({
      userId,
      organizationId:
        organization.id,
      organizationRole:
        organization.membershipRole,
    });

  const project =
    requestedProject
      ? projects.find(
          item =>
            String(item.id) ===
            requestedProject
        )
      : projects[0] || null;

  if (
    requestedProject &&
    !project
  ) {
    throw tenantError(
      "The requested project is not available to this user.",
      403,
      "PROJECT_ACCESS_DENIED"
    );
  }

  const environments =
    await loadEnvironments(
      project?.id || null
    );

  const environment =
    requestedEnvironment
      ? environments.find(
          item =>
            String(item.id) ===
            requestedEnvironment
        )
      : environments[0] || null;

  if (
    requestedEnvironment &&
    !environment
  ) {
    throw tenantError(
      "The requested environment is not available to this user.",
      403,
      "ENVIRONMENT_ACCESS_DENIED"
    );
  }

  return {
    organizationId:
      organization.id,

    projectId:
      project?.id || null,

    environmentId:
      environment?.id || null,

    organization,
    project,
    environment,
    organizations,
    projects,
    environments,
  };
}

module.exports = {
  resolveTenantContext,
};
