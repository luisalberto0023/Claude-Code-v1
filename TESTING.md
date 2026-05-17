# Hopster — Testing Checklist

Living document tracking what's tested and what still needs polish before a public release. Tick boxes as we verify on real hardware (primary target: Android Chrome via GitHub Pages URL).

Legend: `[x]` done · `[ ]` not yet · `[~]` in progress / partial

---

## 1. Resolved (already shipped & verified)

- [x] **Daily Hop — future days grayed**: Day 2–7 cells visibly locked when only Day 1 is reachable; cannot be clicked.
- [x] **Daily Hop — Claim disables after claim**: button becomes "Come Back Tomorrow" and is non-interactive once the day's reward is taken; today's cell shows a checkmark.
- [x] **Background music**: procedural chiptune loop (C–Am–F–G, 118 BPM) starts on first user gesture, pauses when the tab is backgrounded.
- [x] **Settings menu**: accessible from main menu and from Pause. Music on/off + volume, SFX on/off + volume, Haptics toggle. Persists across reloads.

---

## 2. Core gameplay

### Movement & input
- [ ] Swipe up / down / left / right each register reliably on Android.
- [ ] Tap-zone fallback (top half = up, bottom half = down, side edges = left/right) feels natural when held one-handed.
- [ ] No accidental double-hops from a single swipe.
- [ ] No "phantom" hops while scrolling pages or pulling the notification shade.
- [ ] Movement remains responsive at 60 FPS even on long runs.

### Hop mechanics
- [ ] Hop landing tile matches the visual target (no off-by-one).
- [ ] Backward hops don't add score but still count toward survival.
- [ ] Frog cannot leave the playfield horizontally (left/right walls).
- [ ] Frog can't out-hop the auto-scroll for more than ~1 lane.

### Scoring & combo
- [ ] Forward hop → +1 × current combo, applied to HUD immediately.
- [ ] Combo multiplier increments per fast successive forward hop, max x10.
- [ ] Combo resets after the configured idle window (~1.6s).
- [ ] Coin pickup = +1 coin, +2 score, "+1🪙" floats over the frog.
- [ ] Gem pickup = +1 gem, "+1💎" floats over the frog.

### Lives & death
- [ ] Hit by car → -1 life, brief flash, respawn one lane back.
- [ ] Drowning in river without a log = death.
- [ ] Riding a log carries the frog with the log's velocity.
- [ ] Train kills regardless of any power-up except shield.
- [ ] Falling off-screen (auto-scroll catches up) ends the run.
- [ ] At 0 lives → game over modal opens, HUD hidden.

### Power-ups
- [ ] Shield pickup grants the cyan ring for ~8s; consumes the next death.
- [ ] Magnet pulls coins within radius for ~7s; visual coin trails feel right.
- [ ] Slow-mo applies the purple veil + slows world scroll for ~5s.
- [ ] Power-up chips in bottom HUD show remaining seconds and pulse.
- [ ] Skin perks stack correctly with power-ups (Ninja: slow-mo +50%, Cyber: magnet radius +1, Dragon: shield 2 hits).

### Biomes
- [ ] Grass: walkable, no hazards.
- [ ] Road: car lanes feel readable; speeds escalate with depth.
- [ ] River: logs and lily pads spawn with consistent gaps; lily pads dampen scroll.
- [ ] Train: warning telegraph fires before the train; train interval doesn't surprise.
- [ ] Desert / Ice / Lava (later biomes): each introduces one new mechanic that's telegraphed.
- [ ] Biome transitions feel earned, not random; palette changes obvious.

---

## 3. UI / UX

### Menus & modals
- [ ] Logo, stats, "TAP TO HOP" CTA all fit on small phones (e.g. iPhone SE, 320×568 effective).
- [ ] All modals dismissable on first try (no double-tap-Close bug).
- [ ] Modal backgrounds dim the canvas behind them; tapping outside the card doesn't accidentally start a run.
- [ ] HUD elements never overlap the status bar / notch (safe-area-inset respected).
- [ ] Pause button reachable with right thumb; quit button placement doesn't conflict.

### Daily Hop
- [x] Future-day cells grayed and inert.
- [x] Today's cell highlighted (cyan ring).
- [x] After claim: today gets a check, button becomes "Come Back Tomorrow" (disabled).
- [ ] After midnight, the new day becomes claimable without a manual reload.
- [ ] Streak rolls Day 7 → Day 1 with appropriate visual reset.
- [ ] Missing a day resets streak to 0 (currently the code increments unconditionally — known gap).

### Settings
- [x] Music toggle + slider live-applies.
- [x] SFX toggle + slider live-applies.
- [x] Haptics toggle persists.
- [x] Volume sliders disable when their parent toggle is off.
- [ ] Settings opened from Pause returns to Pause, not Main Menu.
- [ ] Settings persist across app close/reopen on Android.
- [ ] Music doesn't auto-restart at 100% volume when changing settings.

### Skins screen
- [ ] All 8 skins listed; equipped one shows "EQUIPPED" with cyan border.
- [ ] Locked skins greyed; tapping shows price.
- [ ] Insufficient currency → shake animation, no purchase.
- [ ] Sufficient currency → unlock, equip, deduct, levelup chime.
- [ ] Skin perk strings render correctly without truncation on small screens.

### Shop screen
- [ ] All four items render in 2-col grid; "Hop Pass" spans both columns with BEST VALUE tag.
- [ ] No purchase logic is wired up yet (placeholder OK).

### Leaderboard
- [ ] Local "You" row updates to current best.
- [ ] Two stub names show above. (Real leaderboard integration is a later milestone.)

---

## 4. Audio

- [ ] Music starts on first user gesture, not before (autoplay respect).
- [ ] Music loop has no audible click/pop at the seam.
- [ ] Music doesn't restart from step 0 every time you toggle screens.
- [ ] SFX play in sync with the action (no audible lag on Android).
- [ ] Master volumes scale linearly; 0% = silent, 100% = no clipping.
- [ ] Backgrounding the tab pauses music; returning resumes it.
- [ ] Bluetooth headphone latency tolerable (~< 100ms).

---

## 5. Persistence (localStorage)

- [ ] Best score, coins, gems, level, XP persist across reloads.
- [ ] Owned skins + equipped skin persist.
- [ ] Daily streak + last-claim date persist.
- [ ] Settings (all 5 fields) persist.
- [ ] Quest progress persists within the same day.
- [ ] Clearing browser data wipes state cleanly (no half-loaded undefined values).
- [ ] Storage shape survives future field additions (we use `{ ...defaults, ...saved }`).

---

## 6. Performance & device fit

- [ ] 60 FPS sustained on a mid-range Android (Pixel 5 / equivalent) for 5+ minutes.
- [ ] No memory growth visible in DevTools over a 10-minute session.
- [ ] CPU usage idles below 5% on the main menu.
- [ ] Battery: ~5% drain per 10-min session is acceptable.
- [ ] Device doesn't get noticeably warm during normal play.
- [ ] Canvas scales correctly on tall (19.5:9) and short (4:3 tablet) aspect ratios.
- [ ] Letter-boxing or pillar-boxing on extreme ratios doesn't obscure HUD.

---

## 7. Accessibility & feel

- [ ] All buttons ≥ 44×44 px tap target.
- [ ] Color contrast on HUD text passes WCAG AA against typical biome backgrounds.
- [ ] No flashing strobe sequences (slow-mo veil is a steady tint, OK).
- [ ] Haptics fire on hop / death / pickup when enabled; nothing fires when disabled.
- [ ] Reduce-motion preference respected for menu backdrop animation (future polish).

---

## 8. Edge cases

- [ ] Rotating the phone mid-run doesn't crash the loop or stretch the canvas.
- [ ] Backgrounding mid-run pauses the timer (not just rendering).
- [ ] Pulling the notification shade doesn't fire phantom touches.
- [ ] Browser refresh mid-run = back at menu cleanly, best-score still saved.
- [ ] Filing system permissions on file:// (when used outside Pages) — localStorage may be sandboxed; document that.
- [ ] Add-to-Home-Screen "PWA" launch fullscreen looks identical to in-browser.
- [ ] Long-press doesn't trigger native share/copy.

---

## 9. Polish wishlist (post-MVP)

- [ ] Real SFX pack instead of pure WebAudio tones (death squelch, coin sparkle).
- [ ] Particle effects on coin pickup and game-over splat.
- [ ] Animated frog character with idle bob + hop squash-stretch.
- [ ] Lane "boss" — occasional tractor / steamroller for variety.
- [ ] Cloud save (Firebase / Game Center / Play Games).
- [ ] Real rewarded-ad integration on the Revive button.
- [ ] Localization scaffold (English-only for now).
- [ ] Tutorial first-run overlay.

---

_Last updated: 2026-05-17. Edit this file as items get verified or new test scenarios surface._
