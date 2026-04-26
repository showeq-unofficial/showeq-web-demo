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
bun install
bun run gen     # one-time: generate src/gen from ../showeq-proto
bun run start   # listens on ws://localhost:9091
```

Then in `showeq-web` open Settings → Daemon URL, set it to
`ws://localhost:9091`, and reload.

Env vars:

- `PORT=9090` — listen on the daemon's default port instead.
- `ZONE=lavastorm ZONE_LONG="Lavastorm Mountains"` — pick a different
  zone. Drop the matching `.txt` files into `maps/` first
  (e.g. `cp ~/.showeq/maps/lavastorm*.txt maps/`).

## Layout

- `src/server.ts`   — Bun WebSocket server + per-session simulation loop
- `src/geometry.ts` — `maps/*.txt` parser (matches loadSOEMap)
- `maps/`           — vendored zone geometry files (default: nektulos)
- `src/sim.ts`      — Mob & player movement step
- `src/mobs.ts`     — NPC name pool + combat.pbstream extraction
- `src/smoke.ts`    — Self-contained client used to verify the server
