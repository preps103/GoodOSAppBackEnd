"use strict";

const state = {
  providers: [],
  domains: [],
  selectedProvider: null,
  selectedDomain: null,
  dnsRecord: null,
};

const elements = {};

function byId(id) {
  return document.getElementById(id);
}

function setMessage(
  message,
  type = ""
) {
  elements.message.textContent =
    message || "";

  elements.message.className =
    type || "";
}

async function api(
  path,
  options = {}
) {
  const response = await fetch(
    path,
    {
      credentials: "include",
      headers: {
        Accept:
          "application/json",
        "Content-Type":
          "application/json",
        ...(options.headers || {}),
      },
      ...options,
    }
  );

  const payload =
    await response.json()
      .catch(() => ({
        success: false,
        message:
          `Unexpected HTTP ${response.status} response.`,
      }));

  if (!response.ok) {
    const error = new Error(
      payload.message ||
      `Request failed with HTTP ${response.status}.`
    );

    error.status = response.status;
    error.code = payload.code;
    error.payload = payload;

    throw error;
  }

  return payload;
}

function providerSlug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 100);
}

function secretReference(value) {
  const slug =
    providerSlug(value)
      .toUpperCase()
      .replace(/[^A-Z0-9_]+/g, "_");

  return slug
    ? `GOODOS_OIDC_${slug}_CLIENT_SECRET`
    : "";
}

function createBadge(
  label,
  ready
) {
  const badge =
    document.createElement("span");

  badge.className =
    `badge ${ready ? "ready" : "pending"}`;

  badge.textContent =
    `${label}: ${ready ? "ready" : "pending"}`;

  return badge;
}

function renderFoundation(payload) {
  elements.foundationBadges
    .replaceChildren(
      createBadge(
        "Callback",
        payload.callbackImplemented ===
          true
      ),
      createBadge(
        "Mandatory SSO off",
        payload.mandatorySso === false
      ),
      createBadge(
        "Active providers",
        Number(
          payload.active_providers || 0
        ) > 0
      ),
      createBadge(
        "Verified domains",
        Number(
          payload.verified_domains || 0
        ) > 0
      ),
      createBadge(
        "Completed login",
        Number(
          payload
            .completed_external_logins ||
          0
        ) > 0
      )
    );
}

function addDetail(
  list,
  term,
  value
) {
  const dt =
    document.createElement("dt");

  const dd =
    document.createElement("dd");

  dt.textContent = term;
  dd.textContent =
    value === null ||
    value === undefined ||
    value === ""
      ? "—"
      : String(value);

  list.append(dt, dd);
}

function renderProviderDetails() {
  const provider =
    state.selectedProvider;

  const list =
    elements.providerDetails;

  list.replaceChildren();

  if (!provider) {
    addDetail(
      list,
      "Status",
      "No provider selected"
    );

    updateWorkflowButtons();
    return;
  }

  addDetail(
    list,
    "ID",
    provider.id
  );

  addDetail(
    list,
    "Status",
    provider.status
  );

  addDetail(
    list,
    "Issuer",
    provider.issuerUrl
  );

  addDetail(
    list,
    "Secret reference",
    provider.secretReference
  );

  addDetail(
    list,
    "Secret configured",
    provider.secretConfigured
      ? "Yes"
      : "No"
  );

  addDetail(
    list,
    "Discovery",
    provider.lastDiscoveredAt
      ? "Complete"
      : "Pending"
  );

  addDetail(
    list,
    "Verified domains",
    provider.verifiedDomainCount || 0
  );

  addDetail(
    list,
    "Ready for activation",
    provider.readyForActivation
      ? "Yes"
      : "No"
  );

  const providerDomains =
    state.domains.filter(
      domain =>
        domain.providerId ===
        provider.id
    );

  const activeDomain =
    providerDomains.find(
      domain =>
        domain.status === "active"
    );

  const pendingDomain =
    providerDomains.find(
      domain =>
        domain.status === "pending"
    );

  state.selectedDomain =
    activeDomain ||
    pendingDomain ||
    null;

  if (
    state.selectedDomain &&
    !elements.workflowDomain.value
  ) {
    elements.workflowDomain.value =
      state.selectedDomain.domain;
  }

  updateSecretCard();
  updateWorkflowButtons();
}

function updateSecretCard() {
  const provider =
    state.selectedProvider;

  if (
    !provider ||
    provider.secretConfigured
  ) {
    elements.secretCard
      .classList.add("hidden");

    return;
  }

  const reference =
    provider.secretReference;

  if (!reference) {
    elements.secretCard
      .classList.add("hidden");

    return;
  }

  elements.secretCommand.value =
`cd /var/www/GoodAppBackEnd

export SECRET_NAME='${reference}'

read -rsp "Paste the OIDC client secret: " OIDC_SECRET
echo

export OIDC_SECRET

python3 <<'PY'
from pathlib import Path
import os

path = Path(".env")
name = os.environ["SECRET_NAME"]
value = os.environ["OIDC_SECRET"]

if not value:
    raise SystemExit(
        "ERROR: Client secret cannot be empty."
    )

lines = []

if path.exists():
    lines = path.read_text(
        encoding="utf-8"
    ).splitlines()

lines = [
    line
    for line in lines
    if not line.startswith(
        name + "="
    )
]

lines.append(
    f"{name}={value}"
)

path.write_text(
    "\\n".join(lines) + "\\n",
    encoding="utf-8"
)
PY

unset OIDC_SECRET SECRET_NAME
chmod 600 .env

pm2 restart goodapp-backend-ha --update-env

for ATTEMPT in $(seq 1 30); do
  curl -fsS http://127.0.0.1:8002/health >/dev/null && break
  sleep 2
done

pm2 restart goodapp-backend --update-env

for ATTEMPT in $(seq 1 30); do
  curl -fsS http://127.0.0.1:8001/health >/dev/null && break
  sleep 2
done

pm2 save

echo "PASS: OIDC client secret installed without printing it."`;

  elements.secretCard
    .classList.remove("hidden");
}

function updateWorkflowButtons() {
  const provider =
    state.selectedProvider;

  const hasProvider =
    Boolean(provider);

  elements.runDiscovery.disabled =
    !hasProvider;

  elements.createDomain.disabled =
    !hasProvider;

  elements.verifyDomain.disabled =
    !state.selectedDomain ||
    state.selectedDomain.status ===
      "active";

  elements.saveLoginPolicy.disabled =
    !hasProvider;

  elements.activateProvider.disabled =
    !hasProvider ||
    provider.status === "active";

  elements.testLogin.disabled =
    !hasProvider ||
    provider.status !== "active";
}

function populateProviders() {
  const select =
    elements.providerSelect;

  const previous =
    state.selectedProvider?.id ||
    select.value;

  select.replaceChildren();

  const blank =
    document.createElement("option");

  blank.value = "";
  blank.textContent =
    state.providers.length
      ? "Select a provider"
      : "No providers registered";

  select.append(blank);

  for (
    const provider
    of state.providers
  ) {
    const option =
      document.createElement("option");

    option.value = provider.id;

    option.textContent =
      `${provider.displayName} — ${provider.status}`;

    select.append(option);
  }

  if (
    previous &&
    state.providers.some(
      provider =>
        provider.id === previous
    )
  ) {
    select.value = previous;
  } else if (
    state.providers.length === 1
  ) {
    select.value =
      state.providers[0].id;
  }

  state.selectedProvider =
    state.providers.find(
      provider =>
        provider.id ===
        select.value
    ) || null;

  renderProviderDetails();
}

async function loadFoundation() {
  const payload =
    await api(
      "/api/oidc/login-health"
    );

  renderFoundation(payload);
}

async function loadProviders() {
  const payload =
    await api(
      "/api/oidc/admin/providers"
    );

  state.providers =
    payload.providers || [];

  populateProviders();
}

async function loadDomains() {
  const payload =
    await api(
      "/api/oidc/admin/domains"
    );

  state.domains =
    payload.domains || [];

  renderProviderDetails();
}

async function refreshAll(
  announce = false
) {
  try {
    await Promise.all([
      loadFoundation(),
      loadProviders(),
      loadDomains(),
    ]);

    if (announce) {
      setMessage(
        "Provider status refreshed.",
        "success"
      );
    }
  } catch (error) {
    if (
      error.status === 401
    ) {
      setMessage(
        "Sign in to GoodOS first, then return to this page.",
        "error"
      );

      return;
    }

    if (
      error.status === 428
    ) {
      setMessage(
        "Complete MFA verification before managing OIDC providers.",
        "error"
      );

      return;
    }

    setMessage(
      error.message,
      "error"
    );
  }
}

function validateProviderForm() {
  const displayName =
    elements.displayName.value
      .trim();

  const name =
    providerSlug(
      elements.providerName.value ||
      displayName
    );

  const issuerUrl =
    elements.issuerUrl.value
      .trim();

  const clientId =
    elements.clientId.value
      .trim();

  const reference =
    elements.secretReference.value
      .trim();

  const domain =
    elements.identityDomain.value
      .trim()
      .toLowerCase();

  if (
    !displayName ||
    !name ||
    !issuerUrl ||
    !clientId ||
    !reference ||
    !domain
  ) {
    throw new Error(
      "Display name, provider identifier, issuer URL, client ID, secret reference, and domain are required."
    );
  }

  let parsedIssuer = null;

  try {
    parsedIssuer =
      new URL(issuerUrl);
  } catch {
    parsedIssuer = null;
  }

  if (
    !parsedIssuer ||
    parsedIssuer.protocol !== "https:"
  ) {
    throw new Error(
      "Issuer URL must be a valid HTTPS address."
    );
  }

  if (
    !/^[a-z0-9][a-z0-9_-]{2,99}$/
      .test(name)
  ) {
    throw new Error(
      "Provider identifier must use lowercase letters, numbers, underscores, or hyphens."
    );
  }

  if (
    !/^GOODOS_OIDC_[A-Z0-9_]+$/
      .test(reference)
  ) {
    throw new Error(
      "Secret reference must begin with GOODOS_OIDC_ and use uppercase letters, numbers, or underscores."
    );
  }

  if (
    !/^[a-z0-9.-]+\.[a-z]{2,}$/i
      .test(domain)
  ) {
    throw new Error(
      "Enter a valid organization email domain."
    );
  }

  return {
    displayName,
    name,
    issuerUrl:
      parsedIssuer.href.replace(
        /\/$/,
        ""
      ),
    clientId,
    secretReference: reference,
    domain,
  };
}

async function createProvider() {
  try {
    setMessage(
      "Registering provider…"
    );

    const form =
      validateProviderForm();

    const payload =
      await api(
        "/api/identity/providers",
        {
          method: "POST",
          body: JSON.stringify({
            providerType: "oidc",
            name: form.name,
            displayName:
              form.displayName,
            issuerUrl:
              form.issuerUrl,
            clientId:
              form.clientId,
            secretReference:
              form.secretReference,
            domains: [],
          }),
        }
      );

    await loadProviders();

    elements.providerSelect.value =
      payload.provider.id;

    state.selectedProvider =
      state.providers.find(
        provider =>
          provider.id ===
          payload.provider.id
      ) || null;

    elements.workflowDomain.value =
      form.domain;

    renderProviderDetails();

    setMessage(
      "Provider registered in disabled mode. Install its client secret using the generated hidden-prompt VPS command.",
      "success"
    );
  } catch (error) {
    setMessage(
      error.message,
      "error"
    );
  }
}

async function runDiscovery() {
  const provider =
    state.selectedProvider;

  if (!provider) {
    return;
  }

  try {
    setMessage(
      "Running OIDC discovery…"
    );

    await api(
      `/api/oidc/admin/providers/${encodeURIComponent(provider.id)}/discover`,
      {
        method: "POST",
        body: "{}",
      }
    );

    await refreshAll();

    setMessage(
      "OIDC discovery completed.",
      "success"
    );
  } catch (error) {
    setMessage(
      error.message,
      "error"
    );
  }
}

async function createDomain() {
  const provider =
    state.selectedProvider;

  const domain =
    elements.workflowDomain.value
      .trim()
      .toLowerCase();

  if (!provider || !domain) {
    setMessage(
      "Select a provider and enter its organization domain.",
      "error"
    );

    return;
  }

  try {
    setMessage(
      "Creating DNS verification record…"
    );

    const payload =
      await api(
        "/api/oidc/admin/domains",
        {
          method: "POST",
          body: JSON.stringify({
            providerId:
              provider.id,
            domain,
          }),
        }
      );

    state.selectedDomain =
      payload.domain;

    state.dnsRecord =
      payload.dnsRecord;

    elements.dnsType.textContent =
      payload.dnsRecord.type;

    elements.dnsName.textContent =
      payload.dnsRecord.name;

    elements.dnsValue.textContent =
      payload.dnsRecord.value;

    elements.dnsExpiry.textContent =
      new Date(
        payload.domain
          .verificationExpiresAt
      ).toLocaleString();

    elements.dnsDetails
      .classList.remove("hidden");

    await loadDomains();

    setMessage(
      "DNS verification record created. Add the displayed TXT record to your DNS provider, then use Verify DNS record.",
      "success"
    );
  } catch (error) {
    setMessage(
      error.message,
      "error"
    );
  }
}

async function verifyDomain() {
  const domain =
    state.selectedDomain;

  if (!domain) {
    setMessage(
      "Create or select a pending domain first.",
      "error"
    );

    return;
  }

  try {
    setMessage(
      "Checking DNS TXT verification…"
    );

    await api(
      `/api/oidc/admin/domains/${encodeURIComponent(domain.id)}/verify`,
      {
        method: "POST",
        body: "{}",
      }
    );

    await refreshAll();

    setMessage(
      "Identity domain verified.",
      "success"
    );
  } catch (error) {
    if (
      error.code ===
      "DOMAIN_VERIFICATION_PENDING"
    ) {
      setMessage(
        "The DNS record has not propagated or does not match yet.",
        "warning"
      );

      return;
    }

    setMessage(
      error.message,
      "error"
    );
  }
}

function loginPolicyBody() {
  return {
    jitEnabled:
      elements.jitEnabled.checked,

    defaultRole:
      elements.defaultRole.value,

    autoLinkVerifiedUsers:
      elements.autoLink.checked,

    trustIdpMfa:
      elements.trustIdpMfa.checked,

    mfaAmrValues: [],
    mfaAcrValues: [],
  };
}

async function saveLoginPolicy() {
  const provider =
    state.selectedProvider;

  if (!provider) {
    return;
  }

  try {
    setMessage(
      "Saving provider login policy…"
    );

    await api(
      `/api/oidc/admin/providers/${encodeURIComponent(provider.id)}/login-policy`,
      {
        method: "PATCH",
        body: JSON.stringify(
          loginPolicyBody()
        ),
      }
    );

    await refreshAll();

    setMessage(
      "Provider login policy saved.",
      "success"
    );
  } catch (error) {
    setMessage(
      error.message,
      "error"
    );
  }
}

async function activateProvider() {
  const provider =
    state.selectedProvider;

  if (!provider) {
    return;
  }

  try {
    setMessage(
      "Validating and activating provider…"
    );

    const policy =
      loginPolicyBody();

    await api(
      `/api/oidc/admin/providers/${encodeURIComponent(provider.id)}/login-policy`,
      {
        method: "PATCH",
        body: JSON.stringify(policy),
      }
    );

    await api(
      `/api/oidc/admin/providers/${encodeURIComponent(provider.id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "active",
          jitEnabled:
            policy.jitEnabled,
          defaultRole:
            policy.defaultRole,
          trustIdpMfa:
            policy.trustIdpMfa,
          mfaAmrValues: [],
          mfaAcrValues: [],
        }),
      }
    );

    await refreshAll();

    setMessage(
      "OIDC provider activated. Use Start external login for the controlled end-to-end test.",
      "success"
    );
  } catch (error) {
    if (
      error.code ===
      "OIDC_PROVIDER_NOT_READY"
    ) {
      const readiness =
        error.payload?.readiness ||
        {};

      setMessage(
        `Provider is not ready. Discovery: ${Boolean(readiness.discovery)}, secret: ${Boolean(readiness.secretConfigured)}, verified domains: ${Number(readiness.verifiedDomainCount || 0)}.`,
        "warning"
      );

      return;
    }

    setMessage(
      error.message,
      "error"
    );
  }
}

function startExternalLogin() {
  const provider =
    state.selectedProvider;

  if (
    !provider ||
    provider.status !== "active"
  ) {
    return;
  }

  const returnTo =
    encodeURIComponent(
      "https://goodos.app/"
    );

  window.location.assign(
    `/api/oidc/start/${encodeURIComponent(provider.id)}?returnTo=${returnTo}`
  );
}

function providerChanged() {
  state.selectedProvider =
    state.providers.find(
      provider =>
        provider.id ===
        elements.providerSelect.value
    ) || null;

  elements.dnsDetails
    .classList.add("hidden");

  state.dnsRecord = null;

  renderProviderDetails();
}

async function copySecretCommand() {
  try {
    await navigator.clipboard
      .writeText(
        elements.secretCommand.value
      );

    setMessage(
      "Hidden-prompt VPS command copied.",
      "success"
    );
  } catch {
    elements.secretCommand.select();

    document.execCommand("copy");

    setMessage(
      "VPS command copied.",
      "success"
    );
  }
}

function displayNameChanged() {
  const displayName =
    elements.displayName.value;

  if (
    !elements.providerName
      .dataset.manual
  ) {
    elements.providerName.value =
      providerSlug(displayName);
  }

  if (
    !elements.secretReference
      .dataset.manual
  ) {
    elements.secretReference.value =
      secretReference(
        elements.providerName.value ||
        displayName
      );
  }
}

function providerNameChanged() {
  elements.providerName
    .dataset.manual = "true";

  if (
    !elements.secretReference
      .dataset.manual
  ) {
    elements.secretReference.value =
      secretReference(
        elements.providerName.value
      );
  }
}

function bindElements() {
  const ids = [
    "message",
    "foundationBadges",
    "refreshEverything",
    "providerSelect",
    "providerDetails",
    "displayName",
    "providerName",
    "issuerUrl",
    "clientId",
    "secretReference",
    "identityDomain",
    "createProvider",
    "secretCard",
    "secretCommand",
    "copySecretCommand",
    "runDiscovery",
    "workflowDomain",
    "createDomain",
    "verifyDomain",
    "dnsDetails",
    "dnsType",
    "dnsName",
    "dnsValue",
    "dnsExpiry",
    "defaultRole",
    "jitEnabled",
    "autoLink",
    "trustIdpMfa",
    "saveLoginPolicy",
    "activateProvider",
    "testLogin",
  ];

  for (const id of ids) {
    elements[id] = byId(id);
  }

  elements.refreshEverything
    .addEventListener(
      "click",
      () => refreshAll(true)
    );

  elements.providerSelect
    .addEventListener(
      "change",
      providerChanged
    );

  elements.displayName
    .addEventListener(
      "input",
      displayNameChanged
    );

  elements.providerName
    .addEventListener(
      "input",
      providerNameChanged
    );

  elements.secretReference
    .addEventListener(
      "input",
      () => {
        elements.secretReference
          .dataset.manual = "true";
      }
    );

  elements.createProvider
    .addEventListener(
      "click",
      createProvider
    );

  elements.copySecretCommand
    .addEventListener(
      "click",
      copySecretCommand
    );

  elements.runDiscovery
    .addEventListener(
      "click",
      runDiscovery
    );

  elements.createDomain
    .addEventListener(
      "click",
      createDomain
    );

  elements.verifyDomain
    .addEventListener(
      "click",
      verifyDomain
    );

  elements.saveLoginPolicy
    .addEventListener(
      "click",
      saveLoginPolicy
    );

  elements.activateProvider
    .addEventListener(
      "click",
      activateProvider
    );

  elements.testLogin
    .addEventListener(
      "click",
      startExternalLogin
    );
}

document.addEventListener(
  "DOMContentLoaded",
  async () => {
    bindElements();

    await refreshAll();
  }
);
