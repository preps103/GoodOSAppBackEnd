# GoodSpeech Kokoro deployment

GoodSpeech uses the Apache-2.0 licensed `hexgrad/Kokoro-82M` model through a private inference service. Browser clients continue to call only:

`POST https://base.goodos.app/api/goodspeech/v1/speech`

GoodBase authenticates the user, validates and rate-limits the request, calls the loopback-only Kokoro service, records audit metadata, and returns transient WAV audio. The browser never receives the internal service token and cannot call Kokoro directly.

## Production configuration

1. Create `/etc/goodbase/goodspeech.env` from `deploy/goodspeech/env.example`, set mode `0600`, and generate a unique token with `openssl rand -hex 32`.
2. Add the same token to the GoodBase runtime environment:

   ```text
   KOKORO_TTS_URL=http://127.0.0.1:8880
   KOKORO_TTS_TOKEN=<same secret>
   ```

3. Install `deploy/systemd/goodspeech-inference.service`, then enable and start it.
4. Wait for `http://127.0.0.1:8880/health/ready` to return `200`. The first start downloads the pinned Kokoro model into the persistent `kokoro_models` volume.
5. Restart GoodBase with its updated environment.

## Security and operations

- Port `8880` is published only on loopback.
- GoodBase-to-Kokoro calls require a constant-time-checked bearer token of at least 32 characters.
- Containers run as an unprivileged user with all Linux capabilities removed, a read-only root filesystem, and a bounded temporary filesystem.
- Request text is limited to 2,000 characters and generated audio is limited to 24 MiB at the GoodBase boundary.
- The model cache is persistent so releases and restarts do not repeatedly download weights.
- Voice cloning is intentionally unavailable. Kokoro does not clone voices, and GoodSpeech must not imply that a stock voice is a user-provided voice.

## Verification

```sh
docker compose --env-file /etc/goodbase/goodspeech.env -f deploy/goodspeech/compose.yaml config --quiet
curl --fail http://127.0.0.1:8880/health/ready
npm test -- --test-name-pattern GoodSpeech
```
