const PORT = Number(Deno.env.get("GOODBASE_EDGE_PORT") || "8500");
const FUNCTION_ROOT = "/functions";
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

function safeBundleRef(value: unknown): string | null {
  const ref = String(value || "").trim();
  if (!/^\/[a-zA-Z0-9/_-]+\.(?:ts|js|mjs)$/.test(ref) || ref.includes("..")) return null;
  return `${FUNCTION_ROOT}${ref}`;
}

function networkArgs(policy: unknown, allowlist: unknown): string[] {
  if (policy !== "allowlist") return [];
  if (!Array.isArray(allowlist)) return [];
  const hosts = allowlist
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => /^(?:[a-z0-9-]+\.)*[a-z0-9-]+(?::\d{1,5})?$/.test(item))
    .slice(0, 50);
  return hosts.length ? [`--allow-net=${hosts.join(",")}`] : [];
}

Deno.serve({ hostname: "0.0.0.0", port: PORT }, async (request) => {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ success: true, service: "Goodbase Isolated Edge Runtime", runtime: `deno@${Deno.version.deno}` });
  }
  if (request.method !== "POST" || url.pathname !== "/invoke") return json({ success: false, message: "Not found." }, 404);

  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (declaredLength > MAX_REQUEST_BYTES) return json({ success: false, message: "Request too large." }, 413);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, message: "Invalid JSON." }, 400);
  }

  const bundle = safeBundleRef(body.bundleRef);
  if (!bundle) return json({ success: false, message: "Invalid bundle reference." }, 400);
  try {
    const stat = await Deno.stat(bundle);
    if (!stat.isFile) return json({ success: false, message: "Bundle not found." }, 404);
  } catch {
    return json({ success: false, message: "Bundle not found." }, 404);
  }

  const timeoutMs = boundedInteger(body.timeoutMs, 10_000, 100, 300_000);
  const responseLimit = boundedInteger(body.responseLimitBytes, 6_291_456, 1024, MAX_RESPONSE_BYTES);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "run", "--quiet", "--no-prompt", "--no-config", "--no-lock", "--cached-only",
        ...networkArgs(body.networkPolicy, body.networkAllowlist),
        bundle,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
      clearEnv: true,
      env: { GOODBASE_FUNCTION_ID: String(body.functionId || ""), GOODBASE_FUNCTION_VERSION: String(body.version || "") },
    });
    const process = command.spawn();
    const input = new TextEncoder().encode(JSON.stringify(body.input ?? {}));
    const writer = process.stdin.getWriter();
    await writer.write(input);
    await writer.close();
    const output = await process.output();
    const durationMs = Math.round(performance.now() - startedAt);
    if (output.stdout.byteLength > responseLimit) return json({ success: false, code: "RESPONSE_LIMIT", durationMs }, 502);
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr).slice(0, 4000);
    if (!output.success) return json({ success: false, code: "FUNCTION_FAILED", exitCode: output.code, stderr, durationMs }, 502);
    let result: unknown = stdout;
    try { result = JSON.parse(stdout); } catch { /* plain text output */ }
    return json({ success: true, result, durationMs, responseBytes: output.stdout.byteLength });
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return json({ success: false, code: timedOut ? "FUNCTION_TIMEOUT" : "RUNTIME_FAILURE", message: timedOut ? "Execution timed out." : String(error), durationMs: Math.round(performance.now() - startedAt) }, timedOut ? 504 : 500);
  } finally {
    clearTimeout(timer);
  }
});
