"use strict";

/**
 * Normalize a title for exact-ish comparison across two different data
 * sources (JustWatch vs. Netflix's Top10 export, or JustWatch vs. TMDb) that
 * don't agree on casing, accents, or punctuation for the same title.
 *
 * Keeps any script's letters and digits (Unicode `\p{L}`/`\p{N}`, not just
 * a-z0-9) and collapses everything else to a single space. A whitelist of
 * just `[a-z0-9]` — this function's first version — strips a non-Latin
 * title (Japanese, Korean, Arabic, Hindi, Telugu, Kannada, Malayalam...) down
 * to an empty string, which makes *any two different titles in that script*
 * compare equal and silently misattribute a totally different title's
 * IMDb id/poster/synopsis. Confirmed live 2026-09-20 with a fabricated case:
 * querying for "進撃の巨人" (Attack on Titan) against a "鬼滅の刃" (Demon
 * Slayer) candidate returned Demon Slayer's IMDb id as a "match".
 */
function normalizeTitle(title) {
  return (title || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents after NFKD decomposition
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

module.exports = { normalizeTitle };
