# showeq-web-demo

A standalone WebSocket server that pretends to be the daemon, so you
can run `showeq-web` against something live without setting up a real
EQ packet capture. It:

- Loads zone geometry from `maps/<zone>.txt` plus the `_1` / `_2`
  layer overlays (vendored next to the source), parsed using the
  daemon's `loadSOEMap` rules (mapcore.cpp:940) — so you see the real
  Brewall map a live session would render.
- Spawns a randomized PC plus ~14 NPCs at named map landmarks. NPC
  names come from the local `tests/replay/combat.pbstream` golden if
  present, or a curated pool otherwise.
- Walks the mobs around at 5 Hz and sprinkles in chat / combat events.

Speaks the same `seq.v1` protobuf the daemon does — the showeq-web
client connects unchanged.

## Run

```sh
cd showeq-web-demo
git submodule update --init   # one-time: pulls showeq-proto into proto/
bun install
bun run gen                   # generate src/gen from proto/
bun run start                 # listens on ws://localhost:9091
```

Then in `showeq-web` open Settings → Daemon URL, set it to
`ws://localhost:9091`, and reload.

## Picking a zone

Append `?m=<shortname>` to the daemon URL to pin the session to a
specific zone (e.g. `ws://localhost:9091/?m=nektulos`). Without the
parameter, every connection lands in a random zone from the allowlist
— which is the union of `maps/` (vendored, ~40 zones) and
`~/.showeq/maps/` if you have legacy showeq installed locally.
Unrecognized shortnames are rejected and the connection falls back to
random.

The shortname is exact-match against the on-disk filenames; long
zone names (e.g. "Nektulos Forest") are display-only and not accepted
as input.

Append `&spawncount=N` to scale the simulated NPC count (default 14,
clamped to `1..5000`). Useful for poking at showeq-web rendering perf
— at high counts the demo synthesizes suffixed mob names
(`decaying skeleton, a #042`) once the unique-name pool runs out.

Env vars:

- `PORT=9090` — listen on the daemon's default port instead.

## Layout

- `src/server.ts`    — Bun WebSocket server + per-session simulation loop
- `src/geometry.ts`  — `maps/*.txt` parser (matches loadSOEMap) + zone scanner
- `maps/`            — vendored zone geometry files (curated set)
- `src/sim.ts`       — Mob & player movement step
- `src/mobs.ts`      — NPC name pool + combat.pbstream extraction
- `src/seed.ts`      — Static panel seed data (categories, group, items, …)
- `src/zoneNames.ts` — Generated short→long zone name map (from zones.h)
- `src/smoke.ts`     — Self-contained client used to verify the server
