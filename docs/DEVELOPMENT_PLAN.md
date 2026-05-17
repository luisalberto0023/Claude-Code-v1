# Hopster — Development Plan (v0.1 → v1.0)

> 24-week plan from playable prototype to worldwide launch.
> Buffered for a 3-person team (1 dev, 1 artist, 1 designer/PM).
> Solo-able in 4× the time.

## Milestone overview

| Phase | Weeks | Output | Gate to advance |
|---|---|---|---|
| **P0 · Prototype** | 0 | Vanilla JS core loop (this repo) | Internal "fun?" vote |
| **P1 · Mobile shell** | 1–2 | Capacitor iOS / Android builds | Runs on real devices 60fps |
| **P2 · Production tech** | 3–6 | Phaser 3 + TS migration, real art | Stable build, no jank |
| **P3 · Live systems** | 7–12 | Hop Pass, cloud save, leaderboards | All systems exercised by QA |
| **P4 · Soft launch** | 13–18 | CA / PH / SE release | D1 ≥ 35%, D7 ≥ 12%, ARPDAU ≥ $0.10 |
| **P5 · GA launch** | 19–24 | Worldwide + marketing burst | Sustained DAU growth |

---

## P0 · Prototype (week 0) — ✅ Done

- ✅ Endless lane generation (grass / road / water / rail)
- ✅ 4-direction tile movement with auto-scroll pressure
- ✅ 3 power-ups, 3 lives, revive stub
- ✅ Combo system
- ✅ Coins + gems
- ✅ Daily reward + daily quests
- ✅ Skin store (8 skins, 5 with perks)
- ✅ Localstorage save
- ✅ Procedural SFX

**Deliverable**: This repo. Test by opening `index.html`.

---

## P1 · Mobile shell (weeks 1–2)

**Goal**: Get the prototype onto real iPhones and Android devices,
verified at 60 fps with touch input.

- [ ] Wrap with **Capacitor 5** (`npx cap init`).
- [ ] Add `manifest.json` + service worker for installable PWA.
- [ ] Test on iPhone SE (3rd gen) as floor device, Pixel 6a, S23.
- [ ] Add safe-area handling for Dynamic Island / pinhole cutouts.
- [ ] Verify haptics on iOS (`Haptics.impact`) and Android.
- [ ] Wire up basic crash reporting (Sentry free tier).
- [ ] **Demo to 10 outside testers**, capture first-30-second video.

**Exit criteria**: 60 fps on iPhone SE, no input lag >50ms, all UI in
safe areas, no console errors over a 10-minute session.

---

## P2 · Production tech & content (weeks 3–6)

**Goal**: Make the game *look* like a finished product.

### Engine migration
- [ ] Port to **Phaser 3 + TypeScript** (Vite for dev server).
- [ ] Replace canvas primitives with sprite atlas (TexturePacker).
- [ ] Particle system for hop dust, coin burst, splat, log splash.
- [ ] Custom shader for water (wave displacement).
- [ ] Lottie for menu animations (cheaper than Spine).

### Art bar
- [ ] Commission **one artist** for: 1 frog rig + 8 skin variants,
      4 biome tilesets, vehicle set (12 cars), HUD icons, app icon.
- [ ] Style: chunky 3D-looking 2D pixel-style à la Crossy Road but
      *not* voxel — slightly painterly so we can ship faster.

### Audio bar
- [ ] License biome-loop music pack (Pond5 / AudioJungle ~$300).
- [ ] Source SFX from Sonniss Game Audio Bundle (free, royalty-free).
- [ ] Dynamic music: combo ≥5 layers in synth bell; combo ≥10 adds
      kick drum.

### Juice pass
- [ ] Screen shake on death (8px / 250ms).
- [ ] Hit-stop (50ms freeze) on power-up collect.
- [ ] Coin number popup with combo color grading.
- [ ] Death cam: zoom + slow-mo on the moment the frog gets hit.

### Analytics & telemetry
- [ ] Integrate **GameAnalytics** (free tier covers our scale).
- [ ] Funnel events: `tutorial_complete`, `first_death`, `first_coin`,
      `first_revive`, `first_skin_unlock`, `day_n_return`.
- [ ] Heatmap of death locations (gridY at death).

**Exit criteria**: A 60-second silent video of the game should make a
non-player ask "what is that".

---

## P3 · Live systems (weeks 7–12)

**Goal**: Build the systems that turn 1 session into 100 sessions.

### Accounts & cloud save
- [ ] Firebase Auth (Sign in with Apple, Google, Anonymous).
- [ ] Firestore for player profile, with conflict resolution
      ("keep highest score, sum currencies, union unlocks").

### Hop Pass (battle pass)
- [ ] 50-tier season, free + premium track.
- [ ] Free track gives coins + 1 free skin at tier 25.
- [ ] Premium track ($4.99) gives an exclusive frog set + 2× coins
      remainder of season.
- [ ] XP-per-run formula tuned to ~60 days of casual play to complete.

### Leaderboards
- [ ] Global daily / weekly / all-time, per-region.
- [ ] **Anti-cheat**: validate replays server-side via deterministic
      seed (we already use procedural lanes).
- [ ] Friends list via deep links and contact-book opt-in.

### Live-ops infrastructure
- [ ] Config-driven event system (Firestore-backed JSON).
- [ ] Server-controlled drop tables, prices, and bundles.
- [ ] Push notification scheduler (FCM) — see Monetization doc for
      ethical limits.

### Monetization plumbing
- [ ] **RevenueCat** for cross-platform IAP.
- [ ] **AdMob** + **AppLovin MAX** mediation for rewarded ads.
- [ ] Receipt validation server-side.

**Exit criteria**: Internal company-wide playtest weekend produces no
P0 bugs and at least one player at level 20.

---

## P4 · Soft launch (weeks 13–18)

**Goal**: Validate retention & monetization before paying for users.

### Markets
- Canada, Philippines, Sweden (industry-standard soft-launch picks:
  English-speaking, similar player behavior to US, low CPI).

### KPIs to hit before GA
| Metric | Target | Why |
|---|---|---|
| **D1 retention** | ≥ 35% | "Did the first session deliver?" |
| **D7 retention** | ≥ 12% | "Did the loop hold?" |
| **D30 retention** | ≥ 5% | "Is this a real game?" |
| **Median session** | ≥ 4 min | Long enough for ad serving |
| **ARPDAU** | ≥ $0.10 | Industry-decent for hyper-casual+ |
| **Tutorial complete** | ≥ 90% | Onboarding works |
| **Day-1 purchase rate** | ≥ 2% | Starter pack is converting |
| **App rating** | ≥ 4.4★ | Don't ship below this |

### Activities
- [ ] Weekly content drop (1 new skin or 1 limited-time event).
- [ ] Run A/B tests on: Starter Pack price ($1.99 / $2.99 / $4.99),
      revive ad placement (post-death only vs. mid-run "save me"),
      Hop Pass tier curve.
- [ ] Cohort analysis weekly; sunset features that don't help retention.

**Exit criteria**: Hit the KPI table above for two consecutive weeks.

---

## P5 · Worldwide launch (weeks 19–24)

- [ ] Launch trailer (15s, 30s, 60s versions for TikTok / YouTube).
- [ ] Influencer campaign focused on **completionist & speedrun** angles
      (best biome reached, longest combo, weirdest skin).
- [ ] Featured request to App Store + Google Play editorial.
- [ ] Localization: ES, PT-BR, JA, KR, DE, FR, ZH-CN, ZH-TW, AR.
- [ ] **Season 1 event**: themed biome ("Neon Tokyo") with exclusive
      cosmetics, runs for 4 weeks post-launch.

### Marketing buy
- [ ] $25–50k initial UA on Meta + TikTok + AppLovin, payback target
      < 90 days.
- [ ] Creative testing rig: 30+ ad variants in week 1; double down on
      top 3 by hook rate.

---

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Hyper-casual market saturated | High | High | Lean into meta-progression to push toward midcore CPI economics |
| Crossy Road comparisons | Certain | Med | Lean into difference: combo system, biomes, seasonal events |
| Apple/Google rejection | Low | High | Avoid IDFA workarounds; conservative copy; AdMob-only ads |
| Cheating leaderboards | Med | Med | Server-side replay verification with deterministic seed |
| Burn-out on content | High | Med | Build content tooling (drop-table JSON) before launch |
| One artist bottleneck | High | High | Sign an emergency second artist for skin variants from week 8 |

---

## Team & budget (24 weeks, indicative)

| Role | Cost |
|---|---|
| Dev (1.0 FTE × 6 mo) | $60k–$120k |
| Artist (1.0 FTE × 4 mo) | $32k–$60k |
| Designer / PM (0.5 FTE × 6 mo) | $24k–$48k |
| Audio license + SFX | $1k |
| Tools (TexturePacker, Spine, Figma) | $500 |
| Backend (Firebase) | $50–$300/mo |
| Soft-launch UA | $5k–$10k |
| GA-launch UA | $25k–$50k |
| Legal (privacy, IAP terms, T&Cs) | $1k–$3k |
| **Total** | **$150k–$300k** |

Solo / weekend-warrior version: ship to P3 in ~6 months by buying art
assets from itch.io or asset packs, skipping cloud save until v1.0.
