# Multi-tenant RLS starter

Every table includes organization, project, and environment identifiers. Policies compare all three values with verified JWT context. Tests must prove same-tenant access succeeds and cross-organization, cross-project, cross-environment, anonymous, expired, and revoked access fails identically through REST and GraphQL.
