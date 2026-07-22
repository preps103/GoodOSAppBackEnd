# Goodbase official SDK release and certification

The SDK sources are package-ready, but **not certified or publicly published** until every gate below has retained evidence tied to an exact Git commit.

## Required automated gates

1. Build Swift, Android/Kotlin/NDK, Flutter, JavaScript/TypeScript, .NET/Unity-compatible, and Python packages.
2. Run unit, API-contract, offline-buffer, consent, reconnect, lifecycle, and controlled-crash tests.
3. Generate an SBOM, SHA-256 checksums, provenance, secret scan, dependency scan, and conformance report.
4. Upload dSYM, ProGuard/R8, NDK, Flutter, Unity, and JavaScript source-map symbols through `npm run symbols:upload`.
5. Sign packages and publish only from a protected semantic-version tag.

## Required real-device evidence

| Target | Controlled test | Required production evidence |
| --- | --- | --- |
| Physical iPhone | fatal and nonfatal Swift crash | symbolicated frames, session, release, device |
| Physical Android | fatal, nonfatal, and ANR | symbolicated frames, ANR issue, session |
| Android NDK | native SIGABRT test | uploaded native symbols and resolved frames |
| Flutter app | framework and platform errors | resolved Dart frames and crash-free session impact |
| Unity app | managed fatal/nonfatal test | resolved C# frames, Unity release and device |

Certification must also show release stability, variants, crash-free users, crash-free sessions, offline replay after reconnect, consent opt-out, Remote Config, experiment assignment, push registration, attestation, and offline data synchronization. The release record must not change from `pending-real-devices` until these checks succeed.

## Publishing controls

Registry credentials remain in CI environment secrets. Personal credentials and signing keys must never be committed. npm, PyPI, Maven, NuGet, and pub.dev publishing use protected environments with approval. Swift releases use a signed Git tag. Failed or incomplete certification blocks publication.
