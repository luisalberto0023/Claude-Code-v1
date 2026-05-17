# Hopster — Frog Royale

A modern reimagining of the 1981 arcade classic *Frogger*, designed for
mobile-first audiences. This repository contains:

- **`index.html` / `js/` / `css/`** — playable v0.1 prototype (vanilla JS,
  HTML5 Canvas, no build step)
- **`docs/GAME_DESIGN.md`** — full game design document
- **`docs/DEVELOPMENT_PLAN.md`** — production roadmap from v0.1 to v1.0
- **`docs/MONETIZATION.md`** — monetization strategy & live-ops plan
- **`docs/MARKET_RESEARCH.md`** — competitive analysis & trend research

## Vision in one paragraph

Hopster is a session-friendly, vertical arcade hopper that fuses *Frogger*'s
tile-based puzzle navigation with the chase-the-score endless arc of
**Crossy Road** and **Subway Surfers**, the collect-and-show-off layer of
**Brawl Stars**, and the meta-progression loop of **Vampire Survivors**.
The first 30 seconds must hook a new player; the first session must teach
the core verb; the second session must already have an unlock waiting.

## How to run the prototype

The prototype has zero dependencies — open `index.html` in any modern
browser, or serve the folder with any static server. On desktop, arrow
keys / WASD; on mobile, swipe or tap the screen edges.

```bash
# Any of these work
python3 -m http.server 8000
npx serve .
```

Then open <http://localhost:8000>.

### Controls

| Action | Mobile | Desktop |
|---|---|---|
| Hop forward | Swipe up / tap top half | ↑ or W |
| Hop back    | Swipe down / tap bottom | ↓ or S |
| Hop left    | Swipe left / tap left edge  | ← or A |
| Hop right   | Swipe right / tap right edge | → or D |
| Pause       | Tap II button | Esc / P |

## What's in v0.1

- Endless procedurally generated lanes (grass / road / water / train)
- 4 biomes that rotate every 25 lanes (Meadow, Desert, Cyber, Lava)
- Combo system (chain forward hops within 1.6s for score multiplier)
- 3 lives + revive ("rewarded ad" stub)
- 3 power-ups: Shield, Magnet, Slow-Mo
- 8 skins with cosmetic + light gameplay perks (frog economy)
- Daily reward streak (7-day rotating loop)
- Daily quests (3 per day, deterministic by date)
- Coins + gems dual-currency
- XP / level progression
- Local save (localStorage)
- Procedural SFX (WebAudio)
- Mobile-first portrait UI, safe-area aware

## File layout

```
.
├── index.html
├── css/style.css
├── js/
│   ├── storage.js     # localStorage save + XP curve
│   ├── audio.js       # WebAudio procedural SFX
│   ├── entities.js    # Frog, Vehicle, Floater, Pickup, Obstacle
│   ├── world.js       # Lane generation + scrolling
│   ├── ui.js          # HUD, modals, quests, daily, skins
│   └── game.js        # State machine + main loop + input
└── docs/
    ├── GAME_DESIGN.md
    ├── DEVELOPMENT_PLAN.md
    ├── MONETIZATION.md
    └── MARKET_RESEARCH.md
```

## Roadmap snapshot

| Phase | Calendar | Headline |
|---|---|---|
| **v0.1 (now)** | Wk 0 | Playable core loop, internal demos |
| **v0.2** | Wk 1–2 | Capacitor wrap → iOS / Android device builds |
| **v0.3** | Wk 3–6 | Real audio, real art, juice pass, analytics |
| **v0.5** | Wk 7–12 | Hop Pass (battle pass), leaderboards, cloud save |
| **v0.8** | Wk 13–18 | Soft launch (CA / PH / SE), live-ops dashboard |
| **v1.0** | Wk 19–24 | Worldwide launch with seasonal event |

See `docs/DEVELOPMENT_PLAN.md` for the detailed plan.
