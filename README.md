# FAGE WARS

FAGE WARS is a real-time node-control strategy game built as a static browser project.

You capture cells, grow population automatically, and win by eliminating every rival colony on the map. Orders are one-shot only, and mouse play supports grouped sweep-drag so multiple friendly cells can launch into one target.

Live site: [https://frankstop.github.io/fage-wars/](https://frankstop.github.io/fage-wars/)

## Run locally

From the project root:

```bash
npm start
```

Then open:

```text
http://localhost:4173/index.html
```

This project is static and does not require an install step.

## Controls

- Mouse: hold on a player colony, sweep across more friendly colonies if you want to group them, then release on a target
- Touch: tap a player colony, then tap a destination
- `I`: toggle the briefing panel
- `R`: restart the current map
- `Space`: pause or resume
- `1`, `2`, `3`: switch board speed

## Features

- 20 handcrafted campaign maps
- One-shot dispatch system across the whole game
- Integer-based combat and growth resolution
- Grouped multi-source sweep-drag input
- Difficulty-specific AI behavior
- Compact in-HUD briefing and board status panels
- Browser QA harness with saved screenshots
- GitHub Pages deployment workflow

## Project layout

```text
.
├── index.html
├── package.json
├── src
│   ├── core
│   │   ├── ai.js
│   │   ├── config.js
│   │   └── simulation.js
│   ├── data
│   │   └── maps.js
│   ├── main.js
│   └── styles.css
├── qa
│   └── ...
└── tools
    └── verify-live.mjs
```

## QA

The live verification script is:

```bash
node tools/verify-live.mjs
```

It performs a real Chrome pass against the game, verifies combat math and grouped drag behavior, and writes screenshots into `qa/`.
