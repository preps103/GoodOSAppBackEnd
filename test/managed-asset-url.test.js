"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_PUBLIC_BACKEND_URL,
  profileAvatarUrl,
  publicBackendUrl
} = require("../src/utils/managedAssetUrl");

test("managed profile photos use the canonical backend URL", () => {
  const original = process.env.PUBLIC_BACKEND_URL;
  delete process.env.PUBLIC_BACKEND_URL;

  try {
    assert.equal(
      profileAvatarUrl({
        id: "621d30ee-bbf5-43a0-958e-f8efff4c7c7c",
        avatar_url:
          "https://legacy.invalid/api/settings/avatars/old",
        avatar_file_name: "avatar.png",
        avatar_updated_at:
          "2026-07-20T00:34:30.237Z"
      }),
      `${DEFAULT_PUBLIC_BACKEND_URL}/api/settings/avatars/` +
        "621d30ee-bbf5-43a0-958e-f8efff4c7c7c?v=1784507670237"
    );
  } finally {
    if (original === undefined) {
      delete process.env.PUBLIC_BACKEND_URL;
    } else {
      process.env.PUBLIC_BACKEND_URL = original;
    }
  }
});

test("external profile photos remain unchanged when no managed file exists", () => {
  assert.equal(
    profileAvatarUrl({
      id: "user-id",
      avatar_url: "https://images.example/avatar.png",
      avatar_file_name: null
    }),
    "https://images.example/avatar.png"
  );
});

test("invalid public backend configuration falls back safely", () => {
  const original = process.env.PUBLIC_BACKEND_URL;
  process.env.PUBLIC_BACKEND_URL = "javascript:alert(1)";

  try {
    assert.equal(
      publicBackendUrl(),
      DEFAULT_PUBLIC_BACKEND_URL
    );
  } finally {
    if (original === undefined) {
      delete process.env.PUBLIC_BACKEND_URL;
    } else {
      process.env.PUBLIC_BACKEND_URL = original;
    }
  }
});
