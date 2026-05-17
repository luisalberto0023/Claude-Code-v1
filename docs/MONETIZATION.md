# Hopster — Monetization Strategy

> Players will tolerate monetization that *respects* them. They punish
> the rest with one-star reviews. Our north star: **no pay-to-win, and
> the ad-free experience is competitive.**

## 1. The mix

| Stream | Target share of revenue | Strategy |
|---|---|---|
| **IAP** | 60% | Cosmetics, Hop Pass, currency bundles |
| **Rewarded ads** | 35% | Player-chosen value exchanges |
| **Interstitial ads** | 5% | One natural break per 3 runs, skippable |

We **do not** use forced pre-roll ads, banner ads inside gameplay, or
play-while-watching ads. They tank retention faster than they earn.

## 2. IAP catalog (launch)

| Item | Price | What it gives | Why it converts |
|---|---|---|---|
| **Starter Bundle** | $1.99 | 500 gems + 1 exclusive skin | Anchored low; sub-30s purchase |
| **Hop Pass (season)** | $4.99 | 50-tier track, 2× coins season | Habit currency for engaged players |
| **Remove Ads** | $2.99 | Removes interstitials only — *keeps* rewarded ads | Whales of patience |
| **Gem Pile** | $4.99 | 1,200 gems | Standard mid-tier |
| **Gem Mountain** | $19.99 | 5,500 gems | Whale anchor |
| **Frog Vault** | $9.99 | Bundle of 3 rare skins (~30% off) | Collectors |

**Always-on**: Starter Bundle is the only purchase visible on death
screen for new players (≤ level 5). After that, contextual offers
appear (you just got a magnet — buy a 5-pack for X gems).

## 3. Rewarded ads — the value exchanges

Each placement is a **player choice**. We never auto-play.

| Placement | What player gets | When |
|---|---|---|
| **Revive** | Continue the run + 3s shield | Once per run, on game-over |
| **Double coins** | 2× the coins you earned | Once per run, post-game-over |
| **Free chest** | One random skin shard | Once every 6 hours, from menu |
| **Daily power-up** | Start your next run with magnet | Once per day, optional pre-run |
| **Quest re-roll** | Swap one daily quest | Once per day, optional |

Estimated player engagement: 35% take revive, 50% take double coins,
60% take free chest. Lifetime ad views per active player: ~6/day.

## 4. Hop Pass design

50 tiers, 6-week season.

- **Free track**: coins, common skin shards, 1 free skin at tier 25.
- **Premium track** ($4.99): exclusive frog set (4 skins), 2× coins for
  remainder of the season, 1× gem drops doubled, tier-50 bragging
  emote.

XP math:
- 25 XP per 1-minute run on average.
- ~12 runs/day for engaged player → 300 XP/day.
- 50 tiers × 200 XP = 10,000 XP total.
- ≈33 days for engaged player to finish → comfortable buffer.

The pass is **the single most important live-ops vehicle** because:
1. It bakes a return motivation into every session.
2. It's a *flat* fee, so players don't feel nickel-and-dimed.
3. It funds 4–6 free skins for the player, generating goodwill.

## 5. Live-ops calendar (post-launch month 1 example)

| Week | Event | Goal |
|---|---|---|
| W1 | Hop Pass S1 starts; "Neon Tokyo" biome event | Drive D1 retention |
| W2 | Limited "Cyber Frog" skin drop, 48h availability | FOMO IAP |
| W3 | Double XP weekend | Reactivate lapsed players |
| W4 | Friend Challenge week (asynchronous PvP) | Viral coefficient |

## 6. Pricing psychology

- **Always show value comparison**: "1,200 gems · $4.99 (BEST VALUE)".
- **Soft-bundle for skin reveals**: never sell a skin alone for >$2.99.
  Bundle it with gems or shards.
- **Anchored top SKU**: keep one premium $99 megabundle for whale
  capture, even if it's < 0.1% of buyers.
- **No regional inflation**: pricing tier respect (e.g., $0.99 in
  PH/IN) to match local power-parity.

## 7. The "respect" rules (non-negotiable)

1. **No pay-to-win.** Skin perks are gentle sidegrades. The leaderboard
   is decided by skill.
2. **No timer paywalls.** No "wait 2 hours or pay 50 gems".
3. **No deceptive UI.** The X to close a modal must be the same size
   as the buy button.
4. **No predatory loot boxes.** Crates show drop rates *before* opening.
5. **Spend caps for minors** when we detect under-13 accounts (App
   Store flags this for us).
6. **Easy refunds** — surface the platform refund path in support FAQ.

These rules cost short-term revenue and *create* long-term LTV and
press goodwill.

## 8. Ad mediation stack

- Primary: **AdMob** (Google), reliable fill.
- Mediation: **AppLovin MAX** or **IronSource LevelPlay**.
- A/B test waterfall vs. bidding in soft launch.
- Cap frequency: rewarded unlimited but with cooldowns; interstitials
  ≤ 1 per 3 runs and never within 30s of a previous one.

## 9. Push notification ethics

- Daily reward reminder: yes, 1×/day max, sent at user's local
  19:00–21:00.
- Streak-about-to-break: yes, ~22:00 day 1 of inactivity.
- "We miss you!": NO. We do not guilt-trip. Lapsed users get a
  *content-positive* nudge ("New skin out!") at most weekly.

## 10. KPI dashboard (monetization)

| KPI | Target |
|---|---|
| D1 ARPU | $0.15 |
| D7 ARPU | $0.40 |
| D30 ARPU | $1.20 |
| LTV/CPI ratio | ≥ 1.3× by day 90 |
| % paying users | ≥ 3% |
| ARPPU (paying users) | $25–$60 |
| Rewarded ad eCPM | $20+ (US/CA), $5+ (global) |
| Crash-free sessions | ≥ 99.5% |

## 11. What we are *not* doing (and why)

- **No gachas** — regulatory risk in BE, CN; player resentment.
- **No PvP-exclusive content** — fragmentation.
- **No "energy" stamina system** — kills retention for casual sessions.
- **No subscription** — players don't want a 4th subscription.
- **No in-game NFTs / crypto** — every game that tried has died.
