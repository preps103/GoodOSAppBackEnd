# GoodOS Phase 18 — Storage Control Plane V2

## Production endpoints

- Public API: `https://base.goodos.app/api/v2/storage`
- Management API: `https://base.goodos.app/api/storage-v2`
- CDN/public objects: `https://base.goodos.app/storage/v2/public/:bucketName/:objectKey`
- Signed downloads: `https://base.goodos.app/storage/v2/signed/:token`

## Public API capabilities

- List tenant-scoped buckets
- List bucket objects
- Upload objects with checksum verification
- Read object metadata
- Download objects
- Create one-time or limited signed URLs
- List immutable object versions
- Restore historical versions
- Soft-delete objects

Public API requests are protected by:

- Enterprise API Gateway V2
- `read:storage` and `write:storage` scopes
- Central Rules Engine V2
- Existing rate limits, quotas, IP policies, request IDs, and request ledger

## Provider support

### Local provider

Fully functional and validated in production:

- Versioned physical object storage
- Public object delivery
- Signed downloads
- Checksums
- Soft delete
- Restore
- Lifecycle cleanup

### S3-compatible providers

The built-in adapter supports:

- Amazon S3
- Cloudflare R2
- MinIO
- DigitalOcean Spaces
- Wasabi
- Other SigV4-compatible endpoints

No raw provider credential is accepted or stored. Provider credentials must be supplied through environment-variable references such as:

- `env://GOODOS_STORAGE_ACCESS_KEY`
- `env://GOODOS_STORAGE_SECRET_KEY`
- `env://GOODOS_STORAGE_SESSION_TOKEN`

The adapter remains `READY_NOT_CONFIGURED` until a provider and its referenced environment variables are configured.

## Management capabilities

- Provider inventory and health checks
- Safe provider configuration using references only
- Bucket provider assignment
- CDN and cache settings
- MIME and extension restrictions
- Version retention
- Soft-delete retention
- Access ledger
- Lifecycle runs

## Compatibility

- Existing `/storage/public` and `/storage/signed` routes remain unchanged.
- Existing Storage V2 console data remains available.
- GoodID, privileged MFA, local break-glass access, API Gateway V2, and Rules Engine V2 remain unchanged.
