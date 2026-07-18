const nodemailer = require("nodemailer");

function envBoolean(value) {
  return String(value || "").toLowerCase() === "true";
}

function createTransporter() {
  const required = [
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASS",
  ];

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(
        `Transactional email is missing ${key}.`
      );
    }
  }

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: envBoolean(process.env.SMTP_SECURE),
    requireTLS: envBoolean(
      process.env.SMTP_REQUIRE_TLS
    ),
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: {
      servername:
        process.env.SMTP_TLS_SERVERNAME ||
        undefined,
      minVersion: "TLSv1.2",
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function publicAppUrl() {
  return (
    process.env.PUBLIC_APP_URL ||
    "https://app.goodos.app"
  ).replace(/\/+$/, "");
}

function fromAddress() {
  return (
    process.env.SMTP_FROM ||
    "GoodOS <no-reply@goodos.app>"
  );
}

async function sendVerificationEmail({
  to,
  firstName,
  token,
}) {
  const verificationUrl =
    `${publicAppUrl()}/?verify=` +
    encodeURIComponent(token);

  const safeName = escapeHtml(
    firstName || "GoodOS user"
  );

  const safeUrl = escapeHtml(verificationUrl);

  const transporter = createTransporter();

  try {
    const result = await transporter.sendMail({
      from: fromAddress(),
      to,
      envelope: {
        from:
          process.env.SMTP_FROM_EMAIL ||
          "no-reply@goodos.app",
        to,
      },
      subject: "Verify your GoodOS account",
      headers: {
        "Auto-Submitted": "auto-generated",
      },
      text: [
        `Hello ${firstName || "GoodOS user"},`,
        "",
        "Verify your GoodOS account by opening this link:",
        verificationUrl,
        "",
        "This link expires in 24 hours.",
        "",
        "If you did not create this account, no action is required.",
      ].join("\n"),
      html: `
<!doctype html>
<html lang="en">
<body style="margin:0;background:#090b10;color:#ffffff;font-family:Arial,sans-serif;">
  <div style="max-width:620px;margin:0 auto;padding:36px 20px;">
    <div style="background:#151821;border:1px solid #292e39;border-radius:22px;padding:34px;">
      <div style="font-size:12px;font-weight:700;letter-spacing:2px;color:#a5b4fc;">
        GOODOS ACCOUNT VERIFICATION
      </div>

      <h1 style="font-size:28px;margin:18px 0 12px;">
        Verify your email
      </h1>

      <p style="color:#c4cad4;line-height:1.65;">
        Hello ${safeName}. Confirm your email address to activate your GoodOS account.
      </p>

      <a
        href="${safeUrl}"
        style="display:inline-block;margin:22px 0;padding:15px 22px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:12px;font-weight:700;"
      >
        Verify my GoodOS account
      </a>

      <p style="color:#949dac;font-size:14px;line-height:1.6;">
        This secure link expires in 24 hours.
      </p>

      <p style="color:#6f7886;font-size:13px;line-height:1.6;">
        If you did not create this account, no action is required.
      </p>
    </div>
  </div>
</body>
</html>
      `,
    });

    return {
      messageId: result.messageId,
      accepted: result.accepted || [],
      rejected: result.rejected || [],
    };
  } finally {
    transporter.close();
  }
}

module.exports = {
  sendVerificationEmail,
};
