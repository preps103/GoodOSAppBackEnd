# Phase 20 — Live GoodOS application status

The backend now exposes `GET /api/apps/status`.

The endpoint combines:

- the PostgreSQL application registry;
- verified deployment-site mappings;
- one cached PM2 runtime query;
- real HTTPS response checks;
- genuine response timing;
- latest deployment state and revision data.

No static response times, fake deployment times, or fabricated version values are returned.
