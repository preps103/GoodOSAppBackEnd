# Goodbase compatibility and deprecation policy

`https://base.goodos.app` is the canonical Goodbase origin. The legacy
`backend.goodos.app` hostname and `/sdk/goodos.*` assets are deprecated as of
July 21, 2026. They return standards-based `Deprecation`, `Sunset`, and
successor links and remain available only as method-preserving compatibility
aliases through January 21, 2027.

New integrations must use `/sdk/goodbase.js`, the `Goodbase` browser global,
the `GoodbaseClient` export, and the `X-Goodbase-API-Key` header. Compatibility
aliases do not receive new features during the deprecation window.
