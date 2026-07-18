"use strict";

const statusElement =
  document.getElementById("status");

const setupElement =
  document.getElementById("setup");

const enrollmentElement =
  document.getElementById("enrollment");

const stepUpElement =
  document.getElementById("stepUp");

const completeElement =
  document.getElementById("complete");

let pendingFactorId = null;

async function api(
  path,
  options = {}
) {
  const response = await fetch(
    path,
    {
      credentials: "include",
      headers: {
        "Content-Type":
          "application/json",
        ...(options.headers || {}),
      },
      ...options,
    }
  );

  const payload =
    await response.json()
      .catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      payload.message ||
      `Request failed with ${response.status}`
    );

    error.status = response.status;
    throw error;
  }

  return payload;
}

function hideFlows() {
  setupElement.classList.add("hidden");
  enrollmentElement.classList.add("hidden");
  stepUpElement.classList.add("hidden");
  completeElement.classList.add("hidden");
}

function failure(error) {
  statusElement.className = "error";

  statusElement.textContent =
    error.status === 401
      ? "Sign in to GoodOS first, then return to this page."
      : error.message;
}

async function refreshState() {
  hideFlows();

  try {
    const payload =
      await api("/api/auth/session");

    const mfa =
      payload.mfa || {};

    const session =
      payload.session || {};

    statusElement.className = "";

    if (!mfa.enabled) {
      statusElement.textContent =
        "Your account does not have an active MFA factor.";

      setupElement.classList.remove(
        "hidden"
      );

      return;
    }

    if (!session.mfaVerified) {
      statusElement.textContent =
        "MFA is active. Verify this browser session.";

      stepUpElement.classList.remove(
        "hidden"
      );

      return;
    }

    statusElement.textContent =
      "Your account and this browser session are protected by MFA.";

    completeElement.classList.remove(
      "hidden"
    );
  } catch (error) {
    failure(error);
  }
}

document
  .getElementById("startSetup")
  .addEventListener(
    "click",
    async () => {
      try {
        statusElement.textContent =
          "Creating encrypted MFA setup…";

        const payload =
          await api(
            "/api/security/mfa/setup",
            {
              method: "POST",
              body: "{}",
            }
          );

        pendingFactorId =
          payload.factorId;

        document
          .getElementById("qr")
          .src = payload.qrDataUrl;

        document
          .getElementById(
            "recoveryCodes"
          )
          .textContent =
            (
              payload.recoveryCodes ||
              []
            ).join("\n");

        setupElement.classList.add(
          "hidden"
        );

        enrollmentElement.classList
          .remove("hidden");

        statusElement.textContent =
          "Scan the QR code, save every recovery code and verify the current authenticator code.";
      } catch (error) {
        failure(error);
      }
    }
  );

document
  .getElementById("verifySetup")
  .addEventListener(
    "click",
    async () => {
      try {
        const saved =
          document.getElementById(
            "savedCodes"
          ).checked;

        if (!saved) {
          throw new Error(
            "Save the recovery codes before activation."
          );
        }

        const token =
          document.getElementById(
            "setupToken"
          ).value.trim();

        await api(
          "/api/security/mfa/verify",
          {
            method: "POST",
            body: JSON.stringify({
              factorId:
                pendingFactorId,
              token,
            }),
          }
        );

        await refreshState();
      } catch (error) {
        failure(error);
      }
    }
  );

document
  .getElementById("verifySession")
  .addEventListener(
    "click",
    async () => {
      try {
        const token =
          document.getElementById(
            "sessionToken"
          ).value.trim();

        await api(
          "/api/security/mfa/verify-session",
          {
            method: "POST",
            body: JSON.stringify({
              token,
            }),
          }
        );

        await refreshState();
      } catch (error) {
        failure(error);
      }
    }
  );

refreshState();
