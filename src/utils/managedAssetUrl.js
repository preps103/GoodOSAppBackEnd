"use strict";

const DEFAULT_PUBLIC_BACKEND_URL =
  "https://base.goodos.app";

function publicBackendUrl() {
  const configured = String(
    process.env.PUBLIC_BACKEND_URL ||
      DEFAULT_PUBLIC_BACKEND_URL
  ).replace(/\/+$/, "");

  try {
    const parsed = new URL(configured);

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return DEFAULT_PUBLIC_BACKEND_URL;
    }

    return parsed.origin;
  } catch {
    return DEFAULT_PUBLIC_BACKEND_URL;
  }
}

function profileAvatarUrl(row) {
  if (!row) return null;

  if (!row.avatar_file_name || !row.id) {
    return row.avatar_url || null;
  }

  const updatedAt = Date.parse(
    row.avatar_updated_at || ""
  );
  const version = Number.isFinite(updatedAt)
    ? `?v=${updatedAt}`
    : "";

  return (
    `${publicBackendUrl()}/api/settings/avatars/` +
    `${encodeURIComponent(String(row.id))}${version}`
  );
}

module.exports = {
  DEFAULT_PUBLIC_BACKEND_URL,
  publicBackendUrl,
  profileAvatarUrl
};
