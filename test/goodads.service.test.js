"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePayload, requireUuid, RESOURCE_TYPES } = require("../src/services/goodads.service");

test("GoodAds exposes every production resource family", () => {
  for (const type of ["campaigns", "content", "approvals", "calendar", "connections", "publishing_jobs", "analytics", "media", "link_hubs", "automations"]) {
    assert.equal(RESOURCE_TYPES.has(type), true);
  }
});

test("GoodAds payloads require bounded JSON objects", () => {
  assert.deepEqual(normalizePayload({ name: "Launch", nested: { ready: true } }), { name: "Launch", nested: { ready: true } });
  assert.throws(() => normalizePayload(null), /JSON object/);
  assert.throws(() => normalizePayload([]), /JSON object/);
  assert.throws(() => normalizePayload({ value: "x".repeat(270000) }), /256 KB/);
});

test("GoodAds IDs must be UUIDs", () => {
  assert.equal(requireUuid("89e0e5e1-ee43-4c9a-a41b-6b07bb920430"), "89e0e5e1-ee43-4c9a-a41b-6b07bb920430");
  assert.throws(() => requireUuid("campaign-1"), /valid resource ID/);
});
