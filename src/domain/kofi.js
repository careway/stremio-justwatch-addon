"use strict";

// Paid plans through Ko-fi memberships. Ko-fi calls our webhook once per
// payment (first and every monthly renewal); each one extends the plan of the
// account with the payer's email. Ko-fi sends nothing when a membership is
// cancelled, and doesn't reliably retry, so the plan is only ever granted
// until one billing month plus a grace window after the payment it came
// from: a cancelled (or lost) renewal lets it lapse to free by itself (see
// effectivePlanId), no event needed.
//
//   KOFI_VERIFICATION_TOKEN  from ko-fi.com/manage/webhooks; the webhook is off without it
//   KOFI_URL                 the creator page supporters are sent to (https://ko-fi.com/…)
//   KOFI_TIER_PLUS / _PRO    membership tier names; default "Plus" / "Pro"
//
// The account is matched by email. A payer who has never signed in gets an
// account created with the plan on it, the same as scripts/set-plan.js, and
// finds it there on first sign-in.

const crypto = require("crypto");
const { getStore } = require("../infra/userStore");

const BILLING_PERIOD_MS = 31 * 24 * 60 * 60 * 1000;
const GRACE_MS = 3 * 24 * 60 * 60 * 1000;

const verificationToken = () => process.env.KOFI_VERIFICATION_TOKEN || null;

function kofiUrl() {
  const url = process.env.KOFI_URL;
  return url && /^https:\/\/ko-fi\.com\/[\w-]+\/?$/.test(url) ? url.replace(/\/$/, "") : null;
}

const isEnabled = () => !!verificationToken() && !!kofiUrl();

function planForTier(tierName) {
  if (typeof tierName !== "string") return null;
  const tier = tierName.trim().toLowerCase();
  const tiers = {
    plus: process.env.KOFI_TIER_PLUS || "Plus",
    pro: process.env.KOFI_TIER_PRO || "Pro",
  };
  const entry = Object.entries(tiers).find(([, name]) => name.trim().toLowerCase() === tier);
  return entry ? entry[0] : null;
}

function sameToken(given, expected) {
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The plan one payment buys: its tier, until a billing month plus grace after
 * the payment. Measured from Ko-fi's timestamp, not from now, so a delivery
 * that repeats or arrives late grants no extra time.
 */
function grantFor(payment, now = Date.now()) {
  const plan = planForTier(payment.tier_name);
  if (!plan) return null;
  const paidAt = Date.parse(payment.timestamp);
  const from = Number.isNaN(paidAt) || paidAt > now ? now : paidAt;
  return { plan, expiresAt: new Date(from + BILLING_PERIOD_MS + GRACE_MS) };
}

/**
 * Apply one webhook delivery (the form-encoded request body).
 * @returns {Promise<{status: number, user?: object}>} the HTTP status to
 *   answer and the account that changed, if any.
 */
async function handleWebhook(rawBody, now = Date.now()) {
  const expected = verificationToken();
  if (!expected) return { status: 404 };

  let payment;
  try {
    payment = JSON.parse(new URLSearchParams(rawBody.toString("utf8")).get("data"));
  } catch {
    return { status: 400 };
  }
  if (!payment || typeof payment !== "object") return { status: 400 };
  if (!sameToken(payment.verification_token, expected)) {
    console.warn("[kofi] webhook with a wrong verification token");
    return { status: 401 };
  }

  // Donations, shop orders and commissions don't buy a plan.
  if (payment.type !== "Subscription") return { status: 200 };
  const grant = grantFor(payment, now);
  if (!grant) {
    console.warn(`[kofi] membership payment for unknown tier "${payment.tier_name}"`);
    return { status: 200 };
  }
  // Required here, not at the top: accounts requires this module.
  const email = require("./accounts").normalizeEmail(payment.email);
  if (!email) {
    console.warn("[kofi] membership payment without a usable email:", payment.kofi_transaction_id);
    return { status: 200 };
  }

  const store = await getStore();
  if (!store) return { status: 404 };
  let user = await store.findByEmail(email);
  if (!user) {
    try {
      user = await store.createUser({ email });
    } catch (err) {
      user = await store.findByEmail(email); // a sign-in raced us
      if (!user) throw err;
    }
  }

  // Never shorten what's already been paid for: a repeated or out-of-order
  // delivery of an older payment for the same tier leaves the later expiry.
  const current = user.planExpiresAt ? new Date(user.planExpiresAt) : null;
  const expiresAt =
    user.plan === grant.plan && current && current > grant.expiresAt ? current : grant.expiresAt;
  await store.setPlan(user.id, grant.plan, expiresAt);
  console.log(`[kofi] ${email}: ${grant.plan} until ${expiresAt.toISOString().slice(0, 10)}`);
  return { status: 200, user: { ...user, plan: grant.plan, planExpiresAt: expiresAt } };
}

module.exports = { isEnabled, kofiUrl, planForTier, grantFor, handleWebhook, BILLING_PERIOD_MS, GRACE_MS };
