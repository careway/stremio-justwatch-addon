# Promo screen recording

`../../scripts/promo-video.js` drives the `/configure` UI with Playwright and
records the session, then transcodes it to 1080p H.264.

## Regenerate

```bash
npm i -D playwright ffmpeg-static
npx playwright install chromium

PORT=7000 NODE_ENV=development node src/index.js &   # addon must be running
node scripts/promo-video.js
```

Outputs (git-ignored):

- `promo.webm` — raw Playwright capture (VP8, 1280×800)
- `promo.mp4`  — `scale=-2:1080`, `libx264 -crf 20`, faststart, no audio

Every action is driven with the mouse pointer (move → click); text is only typed
into the two search boxes that need it. The headless browser draws no OS cursor,
so the script injects a fake arrow that tracks the synthetic pointer events.

Pointer motion follows **Fitts's law** — the HCI model for how long a person
takes to point at a target, `MT ≈ 100 ms + 140 ms·log2(distance/target + 1)`
(Card/English/Burr 1978, MacKenzie 1992) — eased in and out like a real hand.
A normal hand is ~1000 px/s average; the script runs at **2×** that by default.

Knobs (env vars):

- `PROMO_GAP` — ms of dwell after every action (default 400)
- `PROMO_POINTER_SPEED` — pointer pace multiplier (default 2; 1 = human speed)
- `PROMO_HEADED=1` — run in a visible window instead of headless
- `PROMO_NORECORD=1` — just drive the UI, don't write webm/mp4 (capture the
  screen yourself; pair with `PROMO_HEADED=1`)
- `PROMO_MOBILE=1` — portrait phone frame (390×844, DPR 3, touch). Sets both
  `viewport` and `screen`, so the addon's pre-paint script scales the 594 px
  layout to fill the screen exactly as on a real phone. The pointer becomes a
  finger-tip dot that leaves a tap ripple instead of the arrow.

## What it shows

1. Page loads in **Spanish**, then gets switched to **English** with the
   translate button (top-right)
2. Step 1 — Region **Spain**, Title language **Español** (via the search boxes)
3. Step 2 — global catalogs Popular + Trending
4. Providers — Netflix, Prime Video, Disney+ … plus the movies/series
   type-cycle by clicking the first card again
5. **Channels** tab — pick a few channels, back to Providers
6. Additional options — Shuffle catalogs, Hide the country in catalog names
7. Step 3 — Install on Stremio → manifest URL → Copy

Tweak `BASE`, the `providers` list and the `sleep()` pacing at the top of the
script.
