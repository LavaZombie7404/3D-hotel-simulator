# Poki submission packet

Everything the Poki for Developers form asks for, ready to paste.
Form: https://developers.poki.com → "Submit your game"

---

## Playable build

**https://lavazombie7404.github.io/3D-hotel-simulator/**

Source: https://github.com/LavaZombie7404/3D-hotel-simulator

Works on desktop, tablet and phone. No login, no install, loads in one request
tree of ~800 KB.

---

## Title

**3D Hotel Simulator**

Alternative, if they want something less generic: **Night Shift Hotel**,
**Bellhop Tycoon**, **One Star to Five**.

## Tagline

You are the only waiter in a hotel that will not stop filling up.

## Short description (≈150 characters)

Run a hotel from above — and run it yourself. Take room service orders, work
the front desk, and turn one grubby floor into a five-star tower.

## Long description

You play the waiter, not the spreadsheet.

Guests walk in off the road, queue at reception and pay a dollar to check in.
Every one of them takes the best free room, rides a lift that genuinely has to
travel, stays a while, and pays out based on how good that room is. When the
lobby is quiet the hotel runs itself. When it is busy it falls apart without
you.

So you run. Stand in the circle at the front desk and check-ins go two and a
half times faster — leave it and the queue outgrows the desk until people give
up in the doorway. Meanwhile a gold diamond pops above a room upstairs: a guest
wants room service, and there are fourteen seconds on it before they stop
caring. The lift only holds so many people. You are one of them.

The money goes back into the building: unlock rooms, upgrade them from a bare
bed to a suite with a sofa and a TV, open new floors. Then you rebirth — burn
the whole hotel down to two rooms in exchange for a permanent booster — and do
it again, faster. Ten rebirths in, a floor appears that did not exist before.
At twenty, prestige multiplies everything you have earned by ten.

## Genre and tags

Simulation, management, idle, tycoon, 3D, top-down, singleplayer, hotel,
incremental, upgrade

---

## Controls

**Desktop**

| | |
|---|---|
| `W` `A` `S` `D` / arrows | move the waiter |
| `E` | floor button in the lift, or call the lift from the landing |
| `1`–`6` | floor buttons in the lift; view another floor outside it |
| `F` | camera follows the waiter |
| `Esc` | pause and resume |
| Mouse drag / right drag / wheel | rotate, pan, zoom |
| Click a room | select it to unlock or upgrade |

**Mobile and tablet**

| | |
|---|---|
| Virtual stick, bottom left | move the waiter |
| Tap a room | select it to unlock or upgrade |
| Floor tabs | change view; inside the cabin they are the lift's buttons |
| Contextual button, bottom right | call the lift, or go up |
| One finger drag / pinch | rotate and zoom the camera |

---

## Technical

- **Engine:** none. Hand-written JavaScript on top of Three.js r180.
- **Size:** ~788 KB of vendored Three.js plus ~60 KB of game code. No build step.
- **External requests:** none, except the Poki SDK itself. Everything else is
  bundled.
- **Aspect:** 16:9, scales to fill; verified down to 640×360.
- **Performance:** the whole scene is 11–24 draw calls with 48 rooms and up to
  300 guests on screen. Fixed 1/60 s simulation step, decoupled from render
  rate. No per-frame allocations, so the GC does not fire during play.

## Poki requirements checklist

| Requirement | Status |
|---|---|
| Poki SDK integrated | ✅ `src/poki.js` |
| `gameplayStart` on first input, not load | ✅ |
| `gameplayStop` on any interruption | ✅ |
| Events never fire twice in a row | ✅ latched |
| No SDK events during ads | ✅ gated |
| `commercialBreak` only on resume from pause | ✅ |
| Desktop, mobile and tablet | ✅ touch controls |
| Full screen, 16:9, scales to 640×360 | ✅ tested |
| localStorage in try/catch, incognito-safe | ✅ `src/save.js` |
| Progress saved, or player told it is not | ✅ both |
| No external requests | ✅ |
| No debug code or dev tools shipped | ✅ tested on a non-localhost host |
| Under 8 MB, loads well under 10 s | ✅ ~850 KB total |
| Esc / space pause | ✅ Esc |
| Skippable intros | ✅ there are none |

`node tools/poki-ready.mjs` checks all of the above automatically, and passes
against the live URL.

## Still missing

- **Animated thumbnail.** Poki wants a static and an animated thumbnail at the
  global release stage, not at application. Static one is at
  `tools/shots/thumbnail-1280x720.png`; the animated one is not made yet.
- **A name that stands out.** "3D Hotel Simulator" describes the game but does
  not sell it. See the alternatives above.

---

## AI disclosure

Poki allows AI-assisted development but asks that you can explain your tools,
process and iterations on request. The honest version:

> The game was built with Claude Code (Anthropic) in a single collaborative
> session. I directed the design — the top-down view, the playable waiter, the
> working lift, the rebirth-into-prestige progression and the floors that
> unlock at 10/15/20 rebirths were all my calls, specified step by step as the
> game came together. The assistant wrote the implementation to that spec,
> and every mechanic was verified by automated Playwright tests that run the
> real game in a browser (six suites, in `tools/`). No generated art or audio
> is used: all visuals are procedural geometry built in code. The full
> development history, including every design decision and the bugs found and
> fixed along the way, is in the repository's commit log.

Adjust the wording to match how you want to describe your own involvement — but
keep it accurate, because they may ask follow-up questions.

---

## What Poki decides on

They are explicit that they reject games that "lack originality or don't add to
the diversity of the platform", even when the game works perfectly. Hotel
management is a well-worn genre. The thing that is actually unusual here is
that **you are a character inside your own tycoon game** — the waiter running
between the front desk and room service, physically the bottleneck in your own
economy. That is the angle worth leading with in the pitch, not the graphics.
