# GoodOS Update Sites Deployment Center

Production URL:

`https://base.goodos.app/update-sites`

The center stores site deployment configuration and performs GitHub updates without requiring the operator to type Git, build, PM2, systemd, health-check, or rollback commands.

## Security boundary

- Existing GoodOS authentication is required.
- Only `owner` and `admin` platform roles may use management endpoints.
- Existing MFA step-up remains enforced by `authRequired`.
- Repositories are restricted to GitHub HTTPS or GitHub SSH URLs.
- Existing application directories must be under `/home`, `/var/www`, or `/opt`.
- Deployments stop when the working tree has uncommitted changes.
- Only fast-forward Git updates are accepted.
- PM2 and systemd names are validated and executed without a shell.
- Site updates are serialized with PostgreSQL advisory locks.
- Deployment workers run as detached Node processes and persist if an API backend restarts.

## Update sequence

1. Validate site configuration.
2. Verify application path, Git repository, origin, branch, and clean working tree.
3. Fetch GitHub.
4. Confirm fast-forward-only update.
5. Save rollback metadata.
6. Merge the remote branch.
7. Install dependencies when enabled.
8. Run the package build script when enabled and present.
9. Restart the configured PM2 process or systemd service.
10. Verify the configured health URL.
11. Mark the deployment successful.
12. Automatically reset, rebuild, restart, and recheck the previous commit after failure.

## API

- `GET /api/update-sites/health`
- `GET /api/update-sites/sites`
- `POST /api/update-sites/sites`
- `PATCH /api/update-sites/sites/:siteId`
- `GET /api/update-sites/discover`
- `POST /api/update-sites/sites/:siteId/test`
- `POST /api/update-sites/sites/:siteId/update`
- `GET /api/update-sites/runs`
- `GET /api/update-sites/runs/:runId`
