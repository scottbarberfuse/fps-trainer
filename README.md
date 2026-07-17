# FPS TRAINER

A tiny, full-screen **aim trainer** in the browser. You're locked to a static
position — flick, track, and peek. Retro-bright, no build step, no dependencies.

**▶ Play:** https://scottbarberfuse.github.io/fps-trainer/

## How it plays

- **3 clicks** to pop each dot — it shrinks with every hit.
- **8 dots per wave**, **5 waves**. Dots drift, bounce, and leak away if you're too slow.
- Some **peek from behind cover** — you can't tag them until they clear the wall.
- Your score **carries across waves**. Miss a wave's **checkpoint score** and you flatline.

Checkpoints ramp from ~50% to ~80% of a flawless run, so the pressure builds.

## Built on `intox`

Core logic is borrowed and adapted from
[scottbarberfuse/intox](https://github.com/scottbarberfuse/intox) — specifically
its `src/lib/reflex.js` "tap the dot" reflex checkpoint: the target colour
palette, the shrinking-lifetime ramp, and the median/accuracy scoring helpers.
Here they drive an FPS-style trainer instead of a BAC reflex test.

## Running locally

It's static — just serve the folder:

```sh
py -m http.server 8000   # or: npx serve
# open http://localhost:8000
```

## Files

| File | Purpose |
|------|---------|
| `index.html` | Markup, HUD, start/end overlays |
| `style.css`  | Retro-CRT neon theme (scanlines, glow, glitch title) |
| `game.js`    | Canvas game loop, dots, cover, waves, scoring, audio |

## Deploy

Served from GitHub Pages on `main` (root). In **Settings → Pages**, set
*Source: Deploy from a branch → `main` / `(root)`*.
