# Goodbase offline storage standard

Every GoodOS application uses the shared `GoodbaseOfflineStore` runtime for local-drive browser storage. Applications must not create their own incompatible cache, queue, or token persistence layer.

## Required storage contract

- IndexedDB stores per-user application records, sync cursors, and ordered offline mutations.
- `navigator.storage.persist()` is requested so supported browsers retain the database on the device hard drive instead of treating it as an expendable cache.
- `localStorage`, matching the browser-profile persistence model used by `goodos.app`, stores only non-sensitive storage metadata such as the last sync time and cursor.
- `BroadcastChannel` coordinates sync state across tabs.
- Every key is isolated by authenticated Goodbase user ID.
- Logout and account removal must call `clear()`.
- Passwords, access tokens, refresh tokens, API keys, MFA secrets, signing keys, and provider credentials must never be stored in either IndexedDB or `localStorage`.

## Application rule

All web applications load `/sdk/goodbase-offline.js` from `base.goodos.app`, instantiate `GoodbaseOfflineStore` with the authenticated user ID, and use its `get`, `mutate`, `sync`, `pendingCount`, `storageStatus`, and `clear` methods. Mobile and desktop SDKs must preserve the same isolation, ordered mutation, idempotency, and logout-deletion semantics using the operating system's durable application-data store.

This is a platform requirement, not an optional application preference.
