# Hopster — Game Design Document

## 1. High Concept

> A neon-painted, biome-hopping, combo-chasing Frogger for the
> 15-second-attention-span era. One thumb, one heart, infinite hops.

| | |
|---|---|
| **Genre** | Endless arcade · grid-based hopper |
| **Audience** | 9–34, mobile-first, casual + midcore crossover |
| **Sessions** | 60–180 seconds per run, 6–12 runs per session |
| **Comparables** | Crossy Road · Subway Surfers · Vampire Survivors · Stumble Guys |
| **Platforms** | iOS, Android, Web (Capacitor-wrapped from one codebase) |
| **Engine** | Vanilla HTML5 Canvas → Phaser 3 or PixiJS once we add VFX-heavy juice |

## 2. The 3-Layer Retention Model

We design from the **outside in**: every feature must hook one of three loops.

### Layer A · The 60-Second Loop (Core Verb)
Hop forward through procedurally generated lanes. Avoid cars, ride logs,
collect coins, build combos, die, retry. **Must be enjoyable with no
unlocks.**

### Layer B · The Session Loop (Meta-Progression)
Each run feeds: coins (skins, consumables), gems (premium skins, pass
tiers), XP (account level → cosmetic crates), daily quests (bonus coins
& pass XP). Every run advances *something*.

### Layer C · The Calendar Loop (Live-Ops)
Daily reward streak → Weekly themed event → 6-week Hop Pass season →
Quarterly biome drop. Players return because the calendar gives them
reasons to.

## 3. Core Mechanics

### 3.1 Movement
- Tile-based: 60×60 px grid, playfield 9 columns wide.
- 4-directional hops with `easeOutBack` animation (snappy, satisfying).
- Camera auto-scrolls forward; falling behind triggers "hawk" death.
- The auto-scroll *rate ramps with depth* — pressure builds organically.

### 3.2 Lane Types
| Type | Threat | Player verb |
|---|---|---|
| Grass | Trees / rocks (block-and-squish) | Plan route, collect |
| Road | Cars + trucks, variable speed/direction | Time the gap |
| Water | Logs & lilies; water = drown | Ride moving platforms |
| Rail | Train (super-fast); telegraphed warning | Wait, then sprint |

### 3.3 Combo System (originality vs. Crossy Road)
- Each forward hop within **1.6s** of the last increments combo.
- Combo caps at **×10**; score per hop = `floor(combo)`.
- Decay ramps the tension; matches the *Tony Hawk grind line* feeling
  in a Frogger context.

### 3.4 Power-ups
Spawn rate ~3% per generated lane.

| Power-up | Duration | Effect |
|---|---|---|
| 🛡 Shield | 8s | Absorbs one hit (carries between hops) |
| 🧲 Magnet | 7s | Pulls nearby coins/gems |
| ⏱ Slow-mo | 5s | Cuts world scroll & vehicle speed to 25% |

### 3.5 Death + Revive
- 3 lives → respawn one tile back, brief i-frames.
- After final life, "Watch Ad · Revive" CTA. **Once per run**.
- Revive grants 3 seconds of shield to escape the trap.

### 3.6 Currency Map
| Currency | Earn | Spend |
|---|---|---|
| 🪙 Coins | Pickups, runs, quests, daily streak | Common skins, consumables |
| 💎 Gems | Rare drops, level-up, IAP, daily 7-day | Premium skins, Hop Pass tiers |
| ⭐ XP | Every run (based on score) | Account level → cosmetic crates |

## 4. The Skin System (Why People Pay)

> Skins are the **single largest revenue lever** in casual mobile.

Skins have **tiny gameplay perks** (10–25% of value) framed as flavor.
This is *not* pay-to-win — perks are sidegrades:

- Toad — +1 life, but slower base scroll later in the run
- Neon — +10% coin value, no defensive benefit
- Ninja — Slow-mo lasts 50% longer, no coin bonus
- Astro — +0.5s combo grace window, no power-up boost
- Golden — +25% coin value, premium-only
- Cyber — Magnet radius +30%, premium-only
- Dragon — Shield blocks 2 hits, premium-only

Players will own 4–8 skins by month 2 and switch based on the current
quest or event.

## 5. Onboarding & Tutorial

We do **not** show a "swipe to hop" tutorial. The first run is the
tutorial: the first 5 lanes are safe grass with one obvious coin trail
pointing upward. The 6th lane is a slow road with a giant gap. The 12th
lane introduces water. Telemetry will confirm a >80% completion to lane
15 on first run.

Modal tutorial only appears for advanced systems (Hop Pass, daily
quests, skin shop) and is dismissible.

## 6. Difficulty Curve

| Lane range | Mechanic introduced |
|---|---|
| 0–5 | Grass + a slow road |
| 6–15 | Variable-speed roads, first coin pickups |
| 16–25 | Water lanes (logs only, generous spacing) |
| 26–40 | Lily pads (single-tile platforms), trucks |
| 41–60 | Rail lane, first power-ups spawn |
| 61–80 | Multi-water sequences, trains more common |
| 81+ | Speed ramps; biome shifts; gem density up |

Scroll speed: `14 + min(60, gridY) * 0.4` px/s (capped to keep things
fair on commute-grade reflexes).

## 7. UI / UX Principles

1. **One-thumb playable.** All buttons in the bottom 60% of the screen.
2. **Glanceable HUD.** Score / combo / coins at top, lives left-side.
3. **Juice everywhere.** Hop bounce, coin shimmer, combo glow, shake on
   death, slow-mo veil, particle bursts (v0.3).
4. **Safe-area aware.** `env(safe-area-inset-top)` for notches.
5. **High-contrast colors** in core gameplay; cosmetic flair lives in
   skins so it never interferes with readability.
6. **Haptics** on every hop, coin, death — 10ms / 40ms / 200ms tiers
   (subject to per-platform tuning).

## 8. Audio

- v0.1: WebAudio procedural SFX (hop, coin, combo, power-up, death).
- v0.3 onward: licensed music pack (looping, biome-themed),
  high-quality SFX (Tonsturm / Sonniss layers), ducking under voice
  callouts at combo thresholds.
- **No music in menus by default** (mobile usage often muted).

## 9. Accessibility

- High-contrast mode toggle.
- Color-blind-safe palette for cars and pickups (shape + color).
- Toggle-off haptics, music, SFX separately.
- "Hold to hop" alt input for motor-impaired players (v0.4).
- All copy keyboard-accessible on desktop for testing.

## 10. Tech Architecture (current → target)

| Concern | v0.1 (now) | v0.5+ |
|---|---|---|
| Renderer | HTML5 Canvas 2D | Phaser 3 (WebGL) + PixiJS spine |
| State | Plain JS, vanilla | TypeScript, MobX or Zustand |
| Storage | localStorage | + Firebase Auth + Firestore cloud save |
| Net | None | Cloud Functions for leaderboards / anti-cheat |
| Wrap | Web | Capacitor for iOS / Android |
| Analytics | None | Firebase + GameAnalytics (free tier) |
| Ads | Stub | AdMob (mediation via Max/IronSource) |
| IAP | Stub | RevenueCat for cross-platform receipts |
| CI | None | GitHub Actions → TestFlight + Internal Testing |

## 11. Why this design beats a "Frogger clone"

A clone of Frogger would die in two days on the App Store. Hopster
wins on three vectors not available to 1981:

1. **Vertical infinite + chunked biomes** turns a single-screen puzzle
   into a viral short-video moment ("I made it to the Lava biome!").
2. **Meta-progression and seasonal content** convert a 30-second
   delight into a 30-day habit.
3. **A skin system tied to live-ops** monetizes without violating the
   "no pay-to-win" promise — which preserves the 4★+ store rating.
