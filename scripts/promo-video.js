"use strict";
/**
 * Promo walk-through of the /configure UI, mouse-driven.
 *
 *   node scripts/promo-video.js              # headless, writes promo.webm + promo.mp4
 *   PROMO_HEADED=1 node scripts/promo-video.js   # watch it live in a real window
 *   PROMO_NORECORD=1 PROMO_HEADED=1 node scripts/promo-video.js   # just drive the
 *                                            #   UI, capture the screen yourself
 *
 * Needs the addon running locally (PORT 7000) and the dev deps `playwright` +
 * `ffmpeg-static`.
 *
 * Pointer motion follows Fitts's law — the same model HCI uses for how long a
 * person takes to point at a target: MT ≈ a + b·log2(distance/target + 1)
 * (Card, English & Burr 1978; MacKenzie 1992). With a≈100 ms and b≈140 ms/bit
 * a medium move is ~1000 px/s average for a normal hand; PROMO_POINTER_SPEED
 * scales that (default 2 → twice as fast, ~2000 px/s). Each move is eased in
 * and out so it accelerates and settles instead of sliding at constant speed.
 *
 * The headless browser draws no OS cursor, so a fake arrow is injected that
 * tracks the synthetic pointer events. Text is only typed into search boxes.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");
const ffmpeg = require("ffmpeg-static");

const BASE = process.env.PROMO_BASE || "http://127.0.0.1:7000";
const OUT_DIR = path.join(__dirname, "..", "contrib", "promo");
const HEADED = !!process.env.PROMO_HEADED;
const RECORD = !process.env.PROMO_NORECORD;

// PROMO_MOBILE=1 → portrait phone frame (iPhone-ish). The addon's own
// pre-paint script (see configure.html) then reads screen.width < 594 and
// scales the 594 px layout to fill the screen, exactly as on a real phone —
// which is why `screen` has to be set, not just `viewport`.
const MOBILE = !!process.env.PROMO_MOBILE;
const VIEWPORT = MOBILE ? { width: 390, height: 844 } : { width: 1280, height: 800 };

// Dwell after every action. One knob for the whole pace.
const GAP = Number(process.env.PROMO_GAP || 400);
const TYPE_DELAY = 45;

// Fitts's-law pointing time, in ms, for a move of `dist` px onto a ~44 px target.
// POINTER_SPEED scales the pace: 1 = human, 2 = twice as fast (half the time).
const FITTS_A = 100;
const FITTS_B = 140;
const TARGET_W = 44;
const POINTER_SPEED = Number(process.env.PROMO_POINTER_SPEED || 2);
const fittsMs = (dist) =>
  Math.min(950, Math.max(130, FITTS_A + FITTS_B * Math.log2(dist / TARGET_W + 1))) /
  POINTER_SPEED;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

// On desktop: a CSS arrow that tracks the synthetic pointer events (the path
// itself is animated by humanMove, so the element needs no transition).
// On mobile: no arrow — a finger-tip dot that leaves a tap ripple on press.
const CURSOR_SCRIPT = (mobile) => {
  const install = () => {
    if (document.getElementById("__promo_cursor")) return;
    let x = window.innerWidth / 2;
    let y = window.innerHeight / 2;

    const c = document.createElement("div");
    c.id = "__promo_cursor";
    c.style.cssText =
      "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;" +
      "will-change:transform;";
    if (mobile) {
      c.style.cssText +=
        "width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;" +
        "background:rgba(255,255,255,.32);border:1.5px solid rgba(255,255,255,.7);" +
        "box-shadow:0 0 0 1px rgba(0,0,0,.25)";
    } else {
      c.style.cssText +=
        "width:22px;height:22px;margin:-2px 0 0 -2px;transition:transform .05s ease-out;" +
        "filter:drop-shadow(0 1px 2px rgba(0,0,0,.55))";
      c.innerHTML =
        "<svg width='22' height='22' viewBox='0 0 24 24' fill='none'>" +
        "<path d='M5 3l14 8-6 1.6L9.5 19 5 3z' fill='#fff' stroke='#111' " +
        "stroke-width='1.4' stroke-linejoin='round'/></svg>";
    }
    document.body.appendChild(c);

    let s = 1;
    const draw = () => (c.style.transform = `translate(${x}px,${y}px) scale(${s})`);
    draw();

    const ripple = () => {
      const r = document.createElement("div");
      r.style.cssText =
        "position:fixed;left:0;top:0;z-index:2147483646;pointer-events:none;" +
        "width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;" +
        "background:rgba(120,190,255,.45);" +
        `transform:translate(${x}px,${y}px) scale(1);` +
        "transition:transform .45s ease-out,opacity .45s ease-out";
      document.body.appendChild(r);
      requestAnimationFrame(() => {
        r.style.transform = `translate(${x}px,${y}px) scale(4)`;
        r.style.opacity = "0";
      });
      setTimeout(() => r.remove(), 500);
    };

    addEventListener("mousemove", (e) => {
      x = e.clientX;
      y = e.clientY;
      s = 1;
      draw();
    }, true);
    addEventListener("mousedown", () => {
      s = mobile ? 0.7 : 0.82;
      draw();
      if (mobile) ripple();
    }, true);
    addEventListener("mouseup", () => {
      s = 1;
      draw();
    }, true);
  };
  if (document.body) install();
  else addEventListener("DOMContentLoaded", install);
};

// Where the pointer is right now, so each move can be eased from it.
let cursor = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };

/** Move the pointer to (x, y) along an eased path at a human pace. */
async function humanMove(page, x, y) {
  const dx = x - cursor.x;
  const dy = y - cursor.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return;
  const dur = fittsMs(dist);
  const frames = Math.max(8, Math.round(dur / 16)); // ~60 fps
  for (let i = 1; i <= frames; i++) {
    const p = easeInOut(i / frames);
    await page.mouse.move(cursor.x + dx * p, cursor.y + dy * p);
    await sleep(dur / frames);
  }
  cursor = { x, y };
}

async function moveToLocator(page, el) {
  await el.waitFor({ state: "visible", timeout: 15000 });
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  if (box) await humanMove(page, box.x + box.width / 2, box.y + box.height / 2);
  return el;
}

/** Glide the pointer to an element's centre, return its Locator. */
async function glideTo(page, target) {
  const el = typeof target === "string" ? page.locator(target).first() : target;
  return moveToLocator(page, el);
}

/** Glide to a target and mouse-click it, then dwell `gap` ms. */
async function click(page, target, gap = GAP) {
  const el = await glideTo(page, target);
  await sleep(110);
  await el.click();
  await sleep(gap);
}

/** Pick an option inside an open .custom-select, pointer-first. */
async function pickOption(page, csSel, value, textRe) {
  const list = page.locator(`${csSel} .cs-list`);
  const opt = value
    ? list.locator(`.cs-option[data-value="${value}"]`)
    : list.locator(".cs-option").filter({ hasText: textRe }).first();
  await opt.waitFor({ state: "attached", timeout: 15000 });
  await opt.scrollIntoViewIfNeeded().catch(() => {});
  const box = await opt.boundingBox();
  if (box) await humanMove(page, box.x + box.width / 2, box.y + box.height / 2);
  await sleep(110);
  await opt.click({ force: true });
  await sleep(GAP);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    screen: VIEWPORT, // the addon's pre-paint fit() reads screen.*, not innerWidth
    deviceScaleFactor: MOBILE ? 3 : 2,
    isMobile: MOBILE,
    hasTouch: MOBILE,
    // Page loads in Spanish; the video shows it being switched to English.
    locale: "es-ES",
    extraHTTPHeaders: { "Accept-Language": "es-ES,es;q=0.9" },
    ...(RECORD ? { recordVideo: { dir: OUT_DIR, size: VIEWPORT } } : {}),
  });
  await context.addInitScript(CURSOR_SCRIPT, MOBILE);
  const page = await context.newPage();

  await page.goto(`${BASE}/configure`, { waitUntil: "networkidle" });
  await page.mouse.move(cursor.x, cursor.y);
  await sleep(1300); // let the Spanish UI read for a beat

  // ── Switch the whole UI to English with the translate button ─────────────
  await click(page, "#translate-fab");
  await click(page, '#lang-menu button[data-lang="en"]', 700);

  // ── Step 1: country & title language ────────────────────────────────────
  await click(page, "#cs-country .cs-trigger");
  await page.locator("#cs-country .cs-search").pressSequentially("Spa", { delay: TYPE_DELAY });
  await sleep(GAP);
  await pickOption(page, "#cs-country", "ES");

  await click(page, "#cs-language .cs-trigger");
  await page.locator("#cs-language .cs-search").pressSequentially("Esp", { delay: TYPE_DELAY });
  await sleep(GAP);
  await pickOption(page, "#cs-language", null, /Espa[ñn]ol/i);

  // ── Step 2: global catalogs + providers ────────────────────────────────
  await click(page, "#global-sort-pop-toggle + label");
  await click(page, "#global-sort-tnd-toggle + label");

  const providers = ["nfx", "prv", "dnp", "hbm", "apv"];
  for (const sn of providers) {
    const sel = `#pkg-grid .pkg-item:has(#pkg-${sn}) .pkg-label`;
    if (await page.locator(sel).count()) await click(page, sel);
  }
  // show the movies / series type-cycle by clicking the first card again
  const firstCard = `#pkg-grid .pkg-item:has(#pkg-${providers[0]}) .pkg-label`;
  if (await page.locator(firstCard).count()) {
    await click(page, firstCard);
    await click(page, firstCard);
  }

  // ── Channels tab: open it and pick a few channels ─────────────────────
  if (await page.locator('.pkg-tab[data-pane="channels"]').count()) {
    await click(page, '.pkg-tab[data-pane="channels"]');
    const chan = page.locator("#channel-grid .pkg-item .pkg-label");
    const n = await chan.count();
    for (const i of [0, 1, 2]) {
      if (i < n) await click(page, chan.nth(i));
    }
    await click(page, '.pkg-tab[data-pane="providers"]');
  }

  // ── Additional options ───────────────────────────────────────────────
  await click(page, "#randomize-toggle + label");
  await click(page, "#hide-country-toggle + label");

  // ── Step 3: generate + copy the manifest URL ─────────────────────────
  await click(page, "#btn-generate", 800);
  await glideTo(page, "#url-out");
  await sleep(GAP);
  await click(page, "#btn-copy", 1200);

  await sleep(800);

  await context.close();
  await browser.close();

  if (!RECORD) {
    console.log("done (no recording — PROMO_NORECORD)");
    return;
  }

  const webms = fs
    .readdirSync(OUT_DIR)
    .filter((f) => f.endsWith(".webm") && f !== "promo.webm")
    .map((f) => path.join(OUT_DIR, f));
  webms.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const webm = path.join(OUT_DIR, "promo.webm");
  fs.renameSync(webms[0], webm);
  for (const stale of webms.slice(1)) fs.rmSync(stale);
  console.log("webm →", webm);

  const mp4 = path.join(OUT_DIR, "promo.mp4");
  execFileSync(
    ffmpeg,
    [
      "-y", "-i", webm,
      "-vf", "scale=-2:1080:flags=lanczos,format=yuv420p",
      "-c:v", "libx264", "-preset", "slow", "-crf", "20",
      "-movflags", "+faststart", "-an",
      mp4,
    ],
    { stdio: "inherit" },
  );
  console.log("mp4  →", mp4);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
