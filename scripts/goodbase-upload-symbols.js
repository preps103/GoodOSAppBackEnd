"use strict";

const fs = require("fs");
const path = require("path");

const baseUrl = String(process.env.GOODBASE_URL || "https://base.goodos.app").replace(/\/+$/, "");
const accessToken = process.env.GOODBASE_ACCESS_TOKEN;
const appId = process.env.GOODBASE_APP_ID;
const platform = process.env.GOODBASE_RELEASE_PLATFORM;
const version = process.env.GOODBASE_RELEASE_VERSION;
const buildNumber = process.env.GOODBASE_RELEASE_BUILD;
const commitSha = process.env.GOODBASE_RELEASE_COMMIT || null;
const artifacts = process.argv.slice(2);

function fail(message) { console.error(message); process.exitCode = 1; }

async function api(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { Authorization:`Bearer ${accessToken}`, Accept:"application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `Goodbase returned HTTP ${response.status}.`);
  return body;
}

async function main() {
  if (!accessToken || !appId || !platform || !version || !buildNumber || !artifacts.length) {
    return fail("Set GOODBASE_ACCESS_TOKEN, GOODBASE_APP_ID, GOODBASE_RELEASE_PLATFORM, GOODBASE_RELEASE_VERSION, GOODBASE_RELEASE_BUILD, then pass type:path symbol artifacts.");
  }
  const release = await api("/api/goodbase/v1/experience/telemetry/releases", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({appId,platform,version,buildNumber,commitSha}),
  });
  for (const artifact of artifacts) {
    const separator = artifact.indexOf(":");
    if (separator < 1) throw new Error(`Invalid artifact '${artifact}'; use type:path.`);
    const symbolType = artifact.slice(0,separator), filePath = path.resolve(artifact.slice(separator + 1));
    const contents = await fs.promises.readFile(filePath), form = new FormData();
    form.set("releaseId",release.release.id); form.set("symbolType",symbolType);
    form.set("metadata",JSON.stringify({ci:true,commitSha}));
    form.set("symbolFile",new Blob([contents]),path.basename(filePath));
    const result = await api("/api/goodbase/v1/experience/telemetry/symbol-files",{method:"POST",body:form});
    console.log(`${symbolType}: ${result.symbolFile.checksum_sha256} (${result.symbolFile.status})`);
  }
}

main().catch(error => fail(error.message));
