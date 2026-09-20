"use strict";
/**
 * Assign a subscription plan to an account (billing isn't connected yet, so
 * this is how a plan gets set). Creates the account if the email has never
 * signed in; the user then signs in with that email and finds the plan on it.
 *
 *   node --env-file=.env.development.local scripts/set-plan.js <email> <plan> [expires]
 *
 *   plan     free | plus | pro
 *   expires  optional ISO date (2026-12-31) after which the account falls
 *            back to free by itself. Omitted → no expiry.
 *
 * A running server caches an account for up to a minute, so the change shows
 * up within that.
 */

const { PLAN_IDS } = require("../src/domain/plans");
const { getStore } = require("../src/infra/userStore");
const { normalizeEmail } = require("../src/domain/accounts");

async function main() {
  const [rawEmail, plan, expiresRaw] = process.argv.slice(2);
  const email = normalizeEmail(rawEmail);
  if (!email || !PLAN_IDS.includes(plan)) {
    console.error(`usage: set-plan.js <email> <${PLAN_IDS.join("|")}> [expires ISO date]`);
    process.exit(2);
  }
  let expires = null;
  if (expiresRaw) {
    expires = new Date(expiresRaw);
    if (Number.isNaN(expires.getTime())) {
      console.error(`"${expiresRaw}" is not a date`);
      process.exit(2);
    }
  }

  const store = await getStore();
  if (!store) {
    console.error("No DATABASE_URL — accounts aren't configured.");
    process.exit(1);
  }
  let user = await store.findByEmail(email);
  const created = !user;
  if (!user) user = await store.createUser({ email });
  await store.setPlan(user.id, plan, expires);

  console.log(
    `${created ? "created" : "updated"} ${email}: ${plan}` +
      (expires ? ` until ${expires.toISOString().slice(0, 10)}` : " (no expiry)"),
  );
  process.exit(0); // the pg pool keeps the process alive otherwise
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
