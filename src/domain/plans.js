"use strict";

// Subscription tiers. Every number here is a starting point to tune, not a
// measured optimum — they are deliberately the only place limits live, so
// changing a plan is a one-line edit.
//
// What each limit protects (all of them are about upstream JustWatch load,
// see the MAX_OFFSET / MAX_PACKAGES comments they generalise):
//   maxOffset     deepest `skip` a catalog will serve; a catalog holds
//                 maxOffset + 50 titles. The response cache is shared across
//                 users, so depth only costs upstream calls when someone
//                 actually scrolls that far.
//   maxCountries  saved selections per account. A selection is one country plus
//                 its providers (a tab on /configure), and an account has one
//                 selection per country, so this is a country count. Each is
//                 its own set of upstream queries, so this is the limit that
//                 really scales cost. null = unlimited, bounded only by
//                 MAX_SOURCES and maxCatalogs.
//   maxCatalogs   total catalogs in the manifest (sources × providers × sorts
//                 × types). Stremio asks for page 1 of every catalog on
//                 install, which is what got the deploy 403-blocked on
//                 2026-09-02 at 1200 catalogs; 216 is the worst case the
//                 anonymous flow already allows (35 × 3 × 2 + 6).
//   burst/perMin  token bucket per account for manifest + catalog requests.
const PLANS = {
  free: {
    id: "free",
    maxOffset: 100,
    maxCountries: 2,
    maxCatalogs: 36,
    features: { randomize: false },
    rateLimit: { burst: 120, perMin: 60 },
  },
  plus: {
    id: "plus",
    maxOffset: 200,
    maxCountries: null,
    maxCatalogs: 120,
    features: { randomize: true },
    rateLimit: { burst: 200, perMin: 120 },
  },
  pro: {
    id: "pro",
    maxOffset: 400,
    maxCountries: null,
    maxCatalogs: 216,
    features: { randomize: true },
    rateLimit: { burst: 400, perMin: 240 },
  },
};

const PLAN_IDS = Object.keys(PLANS);

/**
 * The plan actually in force right now. An expired paid plan is treated as
 * free without needing any job to downgrade the row — the stored plan stays
 * as the record of what was bought, expiry decides what applies.
 */
function effectivePlanId(user, now = Date.now()) {
  if (!user || !PLANS[user.plan]) return "free";
  if (user.plan === "free") return "free";
  const expires = user.planExpiresAt ? new Date(user.planExpiresAt).getTime() : null;
  if (expires !== null && expires <= now) return "free";
  return user.plan;
}

/**
 * The plans as the subscription page shows them — the same numbers the limits
 * are enforced with, so the comparison can't drift from what's applied.
 */
function publicPlans() {
  return PLAN_IDS.map((id) => {
    const { maxOffset, maxCountries, maxCatalogs, features } = PLANS[id];
    return { id, maxOffset, maxCountries, maxCatalogs, features: { ...features } };
  });
}

function getPlan(user, now) {
  return PLANS[effectivePlanId(user, now)];
}

module.exports = { PLANS, PLAN_IDS, publicPlans, effectivePlanId, getPlan };
