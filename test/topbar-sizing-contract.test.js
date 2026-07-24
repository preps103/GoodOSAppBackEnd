const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const consoleHtml = fs.readFileSync(
  path.join(__dirname, "..", "src", "public", "console.html"),
  "utf8"
);

test("GoodBase uses the shared GoodApps desktop top-bar sizing contract", () => {
  const expectedTokens = {
    "--suite-topbar-height": "77px",
    "--suite-edge-space": "36px",
    "--suite-brand-mark": "36px",
    "--suite-workspace-width": "246px",
    "--suite-workspace-height": "38px",
    "--suite-search-width": "544px",
    "--suite-search-height": "46px",
    "--suite-control-size": "34px",
  };

  for (const [token, value] of Object.entries(expectedTokens)) {
    assert.match(
      consoleHtml,
      new RegExp(`${token.replaceAll("-", "\\-")}\\s*:\\s*${value.replace(".", "\\.")}\\s*;`)
    );
  }

  assert.match(
    consoleHtml,
    /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*var\(--suite-search-width\)\s*minmax\(0,\s*1fr\)\s*;/
  );
  assert.match(consoleHtml, /padding:\s*0\s+var\(--suite-edge-space\)\s*;/);
});
