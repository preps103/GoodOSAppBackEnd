"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  __test: {
    detectManagedImageType,
    safeManagedImagePath,
    nullableEmail,
    nullableWebUrl,
  },
} = require("../src/services/settings.service");

test("managed image validation accepts JPEG, PNG, and WebP signatures", () => {
  assert.equal(
    detectManagedImageType(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])).contentType,
    "image/jpeg"
  );
  assert.equal(
    detectManagedImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00])).contentType,
    "image/png"
  );
  assert.equal(
    detectManagedImageType(Buffer.from("RIFFxxxxWEBP", "ascii")).contentType,
    "image/webp"
  );
  assert.equal(detectManagedImageType(Buffer.from("<svg></svg>")), null);
});

test("managed image paths cannot escape their storage root", () => {
  const root = path.resolve("/tmp/goodos-managed-images");
  assert.equal(safeManagedImagePath(root, "../secret"), null);
  assert.equal(safeManagedImagePath(root, "/etc/passwd"), null);
  assert.equal(safeManagedImagePath(root, "logo.png"), path.join(root, "logo.png"));
});

test("business contact validation rejects invalid email and URL values", () => {
  assert.equal(nullableEmail("owner@goodos.app", "Business email"), "owner@goodos.app");
  assert.throws(() => nullableEmail("not-an-email", "Business email"), /valid email/);
  assert.equal(nullableWebUrl("https://goodos.app"), "https://goodos.app/");
  assert.throws(() => nullableWebUrl("javascript:alert(1)"), /http or https/);
});
