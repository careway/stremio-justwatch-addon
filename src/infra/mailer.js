"use strict";

// Transactional email, used only for magic-link login. Resend's HTTP API via
// the platform fetch (no SDK dependency).
//
// Off-by-default contract like the other integrations, with one difference
// that is deliberate: without RESEND_API_KEY, development prints the link to
// the console so login works locally, but production refuses to send
// (throws) instead of logging a login link — a log line is not a mailbox.

const RESEND_URL = "https://api.resend.com/emails";
const isProduction = () => process.env.NODE_ENV === "production";

async function sendMagicLink(email, link) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    if (isProduction()) throw new Error("email is not configured (RESEND_API_KEY)");
    console.log(`[mailer] (dev, no RESEND_API_KEY) login link for ${email}: ${link}`);
    return;
  }

  const from = process.env.MAIL_FROM || "OmniCatalogs <login@omnicatalogs.app>";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [email],
        subject: "Your OmniCatalogs sign-in link",
        text:
          `Use this link to sign in to OmniCatalogs. It works once and expires in 15 minutes.\n\n` +
          `${link}\n\nIf you didn't ask for it, you can ignore this email.`,
      }),
    });
    if (!res.ok) throw new Error(`Resend HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendMagicLink };
