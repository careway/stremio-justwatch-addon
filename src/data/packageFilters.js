"use strict";

// ─── Package rules ────────────────────────────────────────────────────────────
// Everything that decides *which* JustWatch packages the addon offers, and how
// they are classified, lives here — deliberately out of infra/justwatch.js,
// which should only know how to talk to the API.
//
// Two independent stages, each a plain array. Adding or removing a rule is a
// one-entry edit and nothing else changes:
//
//   EXCLUSIONS     drop a package entirely        → keepPackage()
//   CHANNEL_RULES  mark a package as a channel    → annotateChannels()
//
// This module is a leaf: it imports nothing from the rest of the app and every
// function in it is pure apart from the documented in-place annotation.

// ─── Stage 1: exclusions ──────────────────────────────────────────────────────
// `drop(pkg)` returning true removes the package from the list the addon shows.
// `why` is documentation, not used at runtime.

const EXCLUSIONS = [
  {
    id: "cinema-only",
    why: "Cinema-ticketing packages sell showtimes, not a VOD catalogue.",
    drop: (pkg) => {
      const types = pkg.monetizationTypes || [];
      return types.length === 1 && types[0] === "CINEMA";
    },
  },
  {
    id: "no-titles",
    why: "Sports/live-only providers have no movie or series catalogue at all.",
    drop: (pkg) => pkg.hasTitles === false,
  },
];

/** True when no exclusion rule rejects this package. */
function keepPackage(pkg) {
  return !EXCLUSIONS.some((rule) => rule.drop(pkg));
}

// ─── Stage 2: channel (add-on) classification ─────────────────────────────────
// A channel is a service watched *through* another subscription — "HBO Max
// Amazon Channel" rides on Amazon Prime Video. Its catalogue duplicates the
// direct provider's, so /configure lists the two in separate tabs.
//
// Rules are tried in order and the first match wins. Each returns either null
// or `{ parentTechnicalName, parentName }`; the parent is later resolved to the
// real package so two rules naming the same service can't produce two entries.

// JustWatch's own link. Authoritative, but **badly incomplete** — measured
// 2026-09-02 on US/WEB it covers 71 packages and misses ~110 obvious channels,
// including every "… Apple TV channel" (null on every platform, and Apple TV
// declares zero `addons` in the reverse direction). See memories/justwatch-api.md.
const addonParentRule = {
  id: "addon-parent",
  why: "JustWatch's own addonParent link, when it has one.",
  match: (pkg) =>
    pkg.addonParent
      ? {
          parentTechnicalName: null, // already a real package; matched by shortName
          parentName: pkg.addonParent.clearName,
          parentShortName: pkg.addonParent.shortName,
        }
      : null,
};

// The supplement for what addonParent misses. The suffix must be a **platform
// name immediately before "channel"**, never the word alone — that is what
// keeps Channel 4, Criterion Channel, Science Channel, Travel Channel, Super
// Channel Plus, Plex Channel, The Roku Channel and RokuChannel Live TV
// correctly classified as providers. Audited across 15 countries with zero
// false positives.
//
// Matching `clearName` rather than `technicalName` is deliberate: a prefix rule
// on `roku` would wrongly catch `rokuchannel` (The Roku Channel) and
// `rokuchannelfast` (RokuChannel Live TV).
//
// To add a platform, add a row. To stop treating one as a channel, delete it.
const CHANNEL_SUFFIXES = [
  {
    // "Amzon" is a real JustWatch typo, present in 2 US packages.
    re: /\b(?:amazon|amzon)\s+channels?$/i,
    parentTechnicalName: "amazonprime",
    parentName: "Amazon Prime Video",
  },
  {
    re: /\bapple\s?tv\s+channels?$/i,
    parentTechnicalName: "appletvplus",
    parentName: "Apple TV",
  },
  {
    re: /\broku\s+premium\s+channels?$/i,
    parentTechnicalName: "rokuchannel",
    parentName: "The Roku Channel",
  },
  {
    re: /\bsling\s+tv\s+channels?$/i,
    parentTechnicalName: "slingtv",
    parentName: "Sling TV",
  },
  {
    re: /\bnow\s+tv\s+channels?$/i,
    parentTechnicalName: "nowtv",
    parentName: "Now TV",
  },
];

const nameSuffixRule = {
  id: "name-suffix",
  why: "Channels JustWatch never linked — see CHANNEL_SUFFIXES above.",
  match: (pkg) => {
    const name = (pkg.clearName || "").trim();
    const hit = CHANNEL_SUFFIXES.find((s) => s.re.test(name));
    return hit
      ? {
          parentTechnicalName: hit.parentTechnicalName,
          parentName: hit.parentName,
          parentShortName: null,
        }
      : null;
  },
};

// Order matters only in that the API's own answer is preferred over the
// heuristic; the suffix rule never overrules a package JustWatch classified.
const CHANNEL_RULES = [addonParentRule, nameSuffixRule];

/** The first channel rule that matches, or null when the package is a provider. */
function classifyChannel(pkg) {
  for (const rule of CHANNEL_RULES) {
    const hit = rule.match(pkg);
    if (hit) return { ...hit, ruleId: rule.id };
  }
  return null;
}

/**
 * Annotate a package list in place with `isAddon`, `addonParentName` and
 * `addonParentShortName`.
 *
 * A parent named by `parentTechnicalName` is resolved against the list itself,
 * so a rule-matched channel and an API-linked one end up sharing the parent's
 * real shortName — otherwise /configure would draw two filter chips for the
 * same service. Falls back to the rule's literal name when that parent package
 * isn't offered in this country.
 *
 * @param {Array} pkgs - packages, already past keepPackage()
 * @returns {Array} the same array
 */
function annotateChannels(pkgs) {
  const byTechnical = new Map(pkgs.map((p) => [p.technicalName, p]));
  for (const pkg of pkgs) {
    const hit = classifyChannel(pkg);
    if (!hit) {
      pkg.isAddon = false;
      pkg.addonParentName = null;
      pkg.addonParentShortName = null;
      continue;
    }
    const parent = hit.parentTechnicalName
      ? byTechnical.get(hit.parentTechnicalName)
      : null;
    pkg.isAddon = true;
    pkg.addonParentName = parent?.clearName || hit.parentName;
    pkg.addonParentShortName =
      parent?.shortName || hit.parentShortName || hit.parentTechnicalName;
  }
  return pkgs;
}

module.exports = {
  keepPackage,
  annotateChannels,
  classifyChannel,
  // Exported for tests and for anyone auditing the rule set.
  EXCLUSIONS,
  CHANNEL_RULES,
  CHANNEL_SUFFIXES,
};
