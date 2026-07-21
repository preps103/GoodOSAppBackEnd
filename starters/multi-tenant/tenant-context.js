export function tenantHeaders({ organizationId, projectId, environmentId }) {
  if (!organizationId || !projectId || !environmentId) throw new Error("Complete tenant context is required.");
  return {
    "X-GoodOS-Organization-ID": organizationId,
    "X-GoodOS-Project-ID": projectId,
    "X-GoodOS-Environment-ID": environmentId,
  };
}

