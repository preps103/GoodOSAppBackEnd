"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const social = require("../src/services/goodads-social.service");

test("GoodAds social registry includes major publishing networks", () => {
  for (const provider of ["google", "facebook", "instagram", "threads", "linkedin", "x", "tiktok", "pinterest", "reddit"]) {
    assert.ok(social.PROVIDERS[provider]);
    assert.ok(social.PROVIDERS[provider].authUrl.startsWith("https://"));
    assert.ok(social.PROVIDERS[provider].tokenUrl.startsWith("https://"));
  }
});

test("social tokens are authenticated-encrypted at rest", () => {
  process.env.GOODADS_OAUTH_ENCRYPTION_KEY = "test-only-key";
  const encrypted = social.encrypt("provider-token");
  assert.notEqual(encrypted.ciphertext, "provider-token");
  assert.equal(social.decrypt(encrypted.ciphertext, encrypted.iv, encrypted.tag), "provider-token");
});

test("unconfigured providers are reported without fabricated success", () => {
  delete process.env.GOODADS_X_CLIENT_ID;
  delete process.env.GOODADS_X_CLIENT_SECRET;
  assert.equal(social.providerConfig("x").configured, false);
  assert.throws(() => social.providerConfig("unknown"), /Unsupported social provider/);
});
