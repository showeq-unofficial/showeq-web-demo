import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  ChatMessageSchema,
  CombatEventSchema,
  EnvelopeSchema,
  FilterRulesUpdateSchema,
  PlayerStatsSchema,
  SnapshotSchema,
  SpawnAddedSchema,
  SpawnUpdatedSchema,
  type Spawn,
} from '@gen/seq/v1/events_pb';
import { ClientEnvelopeSchema } from '@gen/seq/v1/client_pb';
import { loadZoneGeometry } from './geometry.ts';
import { loadMobNames, randomPlayerName } from './mobs.ts';
import { buildMobs, buildPlayer, stepMob, type MobState, type ZoneBounds } from './sim.ts';
import {
  compileRule,
  computeFlags,
  emptyFilterState,
  toWireRules,
  type FilterState,
} from './filters.ts';

const PORT = Number(process.env.PORT ?? 9091);
const ZONE_SHORT = process.env.ZONE ?? 'nektulos';
const ZONE_LONG = process.env.ZONE_LONG ?? 'Nektulos Forest';
const TICK_MS = 200;

// Load geometry once at startup. ~/.showeq/maps/<zone>.txt and the
// _1/_2 layer overlays are read using the daemon's loadSOEMap rules
// (mapcore.cpp:940). We exit early with a clear error if the requested
// zone has no installed map — running the demo without geometry would
// just give an empty canvas.
const _loaded = loadZoneGeometry(ZONE_SHORT);
if (!_loaded) {
  console.error(
    `[demo] no map files found for zone "${ZONE_SHORT}" under ~/.showeq/maps. ` +
    `Set ZONE=<short_name> to pick a different zone.`,
  );
  process.exit(1);
}
// Re-bind to a non-nullable handle so callers below don't need null
// guards. The early exit above ensures _loaded was non-null here.
const loaded = _loaded;
const ZONE_BOUNDS: ZoneBounds = {
  minX: loaded.geometry.minX, maxX: loaded.geometry.maxX,
  minY: loaded.geometry.minY, maxY: loaded.geometry.maxY,
};
console.log(
  `[demo] zone=${ZONE_SHORT} bounds=` +
  `(${ZONE_BOUNDS.minX},${ZONE_BOUNDS.minY})..(${ZONE_BOUNDS.maxX},${ZONE_BOUNDS.maxY}) ` +
  `lines=${loaded.geometry.lines.length} ` +
  `locs=${loaded.geometry.locations.length} ` +
  `anchors=${loaded.spawnAnchors.length}`,
);
// Visible in the chat log so the demo doesn't feel empty even before
// any mobs move.
const CHAT_LINES = [
  { from: 'Marrik', text: 'anyone need a port to nek?' },
  { from: 'Sylvana', text: 'lfg sk 24 — nek?' },
  { from: 'Bremen', text: 'cleared the camp at greenblood, free for now' },
  { from: 'Ystra', text: 'wts spider silk x4 5p ea' },
  { from: 'Daskar', text: 'watch for tracker patrols by the bridge' },
];

interface Session {
  player: Spawn;
  // Persistent MobState for the player — kept on the session so
  // velocity smoothing and the current waypoint survive between
  // ticks. Earlier the player state was rebuilt every tick, which
  // wiped m.vx/m.vy and broke the heading-from-velocity
  // calculation (the player would visually drift but never face the
  // direction of travel).
  playerMob: MobState;
  // Ordered list of waypoint coordinates the player walks between.
  // When the player reaches the current waypoint, we advance the
  // index. Pulled from the parsed map locations so the route covers
  // recognizable landmarks.
  waypoints: [number, number][];
  waypointIdx: number;
  mobs: MobState[];
  // In-memory FilterMgr. Per the user's brief, filter rules are not
  // persisted — they reset on every connection.
  filters: FilterState;
  // Monotonic envelope sequence — clients use this to detect gaps and
  // drive the resume protocol (Subscribe.last_seq), but the demo's
  // session_id is empty so resume falls back to a fresh Snapshot every
  // time. That's fine — this is a demo, not a real session.
  seq: bigint;
  ticker?: ReturnType<typeof setInterval>;
}

const sessions = new WeakMap<WebSocket, Session>();

function nextSeq(s: Session): bigint {
  s.seq += 1n;
  return s.seq;
}

// Pick a small set of waypoints for the player to walk between.
// Sorted by angle around the start so the route forms a rough loop
// rather than darting back and forth across the zone — produces a
// continuously-changing heading that's easy to see on the FOV cone.
function pickWaypoints(
  anchors: [number, number][],
  start: [number, number],
): [number, number][] {
  if (anchors.length === 0) return [];
  const eligible = anchors.filter(([x, y]) => {
    const dx = x - start[0], dy = y - start[1];
    // Drop near-duplicates to the spawn anchor — too-close waypoints
    // would just snap-advance and never produce a heading change.
    return dx * dx + dy * dy > 200 * 200;
  });
  // Sample up to 8 points and order them by bearing from the start
  // so consecutive segments turn smoothly rather than reversing.
  const sample = eligible
    .map((p) => ({ p, r: Math.random() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, 8)
    .map((e) => e.p);
  sample.sort((a, b) => {
    const aa = Math.atan2(a[1] - start[1], a[0] - start[0]);
    const bb = Math.atan2(b[1] - start[1], b[0] - start[0]);
    return aa - bb;
  });
  return sample;
}

function envelope(s: Session, payload: any): Uint8Array {
  const env = create(EnvelopeSchema, {
    seq: nextSeq(s),
    serverTsMs: BigInt(Date.now()),
    payload,
  });
  return toBinary(EnvelopeSchema, env);
}

function startSession(ws: WebSocket): void {
  const playerName = randomPlayerName();
  const PLAYER_ID = 1;
  // Drop the player at the first available anchor (or the bounding-box
  // center if there are none) so the FOV cone has something to point at.
  const playerAnchor: [number, number] = loaded.spawnAnchors[0]
    ?? [(ZONE_BOUNDS.minX + ZONE_BOUNDS.maxX) >> 1,
        (ZONE_BOUNDS.minY + ZONE_BOUNDS.maxY) >> 1];
  const { spawn: playerSpawn, mob: playerMobInit } = buildPlayer(
    PLAYER_ID, playerName, playerAnchor, ZONE_BOUNDS,
  );
  // Player walks a randomized loop of map landmarks so the heading
  // sweeps through the full compass over the course of a demo session
  // (rather than nudging in a tiny lissajous around the spawn point).
  const waypoints = pickWaypoints(loaded.spawnAnchors, playerAnchor);
  // Aim the first walking segment immediately so the heading is
  // populated on the very first tick rather than starting at 0 (north).
  if (waypoints.length > 0) {
    playerMobInit.tx = waypoints[0][0];
    playerMobInit.ty = waypoints[0][1];
  }
  const names = loadMobNames(14);
  // Mob anchors skip index 0 so they don't all stack on the player.
  const mobAnchors = loaded.spawnAnchors.length > 1
    ? loaded.spawnAnchors.slice(1)
    : loaded.spawnAnchors;
  const mobs = buildMobs(names, mobAnchors, ZONE_BOUNDS);
  const session: Session = {
    filters: emptyFilterState(),
    player: playerSpawn,
    playerMob: playerMobInit,
    waypoints,
    waypointIdx: 0,
    mobs,
    seq: 0n,
  };
  sessions.set(ws, session);

  console.log(`[demo] new session — player=${playerName} mobs=${mobs.length}`);

  // Snapshot first: tells the client the zone (so the title bar updates
  // to "Loading <zone>…" → the long name), the geometry to render
  // on the map canvas, and every spawn including the player.
  const snapshot = create(SnapshotSchema, {
    zoneShort: ZONE_SHORT,
    zoneLong: ZONE_LONG,
    playerId: PLAYER_ID,
    spawns: [playerSpawn, ...mobs.map((m) => m.spawn)],
    geometry: loaded.geometry,
    spawnPoints: [],
    sessionId: '',
  });
  ws.send(envelope(session, { case: 'snapshot', value: snapshot }));

  // PlayerStats so the StatsPanel populates.
  const stats = create(PlayerStatsSchema, {
    name: playerName,
    class: 1, race: 1, level: 25,
    hpCur: 850, hpMax: 850,
    manaCur: 600, manaMax: 600,
    staminaCur: 100, staminaMax: 100,
    expCur: 12_500_000, expMax: 25_000_000,
    aaExpCur: 0, aaExpMax: 15_000_000, aaPoints: 0,
    str: 95, sta: 95, agi: 95, dex: 90, wis: 80, int: 80, cha: 75,
  });
  ws.send(envelope(session, { case: 'playerStats', value: stats }));

  // Send an initial empty FilterRulesUpdate so FilterRulesPanel renders
  // its add-row UI right away. Daemon does the same on Subscribe so
  // the panel doesn't sit in a "loading" state forever when there are
  // no rules yet.
  sendFilterRules(ws, session);

  let tickCount = 0;
  session.ticker = setInterval(() => {
    if (ws.readyState !== 1 /* OPEN */) return;
    tickCount++;
    // Move each mob and emit SpawnUpdated for the ones that moved.
    for (const m of session.mobs) {
      const moved = stepMob(m, 18 + Math.random() * 10);
      if (!moved) continue;
      const upd = create(SpawnUpdatedSchema, {
        id: m.spawn.id,
        pos: m.spawn.pos,
      });
      ws.send(envelope(session, { case: 'spawnUpdated', value: upd }));
    }
    // Walk the player toward the current waypoint. When close enough,
    // advance to the next one (looping around). Persistent state on
    // session.playerMob means stepMob's velocity smoothing accumulates
    // across ticks — that's what gives the FOV cone a natural turn
    // when the path bends, instead of snapping each frame.
    const pm = session.playerMob;
    if (session.waypoints.length > 0) {
      const wp = session.waypoints[session.waypointIdx];
      pm.tx = wp[0];
      pm.ty = wp[1];
      const dx = wp[0] - pm.spawn.pos!.x;
      const dy = wp[1] - pm.spawn.pos!.y;
      if (dx * dx + dy * dy < 60 * 60) {
        session.waypointIdx = (session.waypointIdx + 1) % session.waypoints.length;
      }
    }
    if (stepMob(pm, 22)) {
      ws.send(envelope(session, {
        case: 'spawnUpdated',
        value: create(SpawnUpdatedSchema, {
          id: session.player.id,
          pos: session.player.pos,
        }),
      }));
    }

    // Every ~3s, emit a flavour event: chat line OR a combat hit between
    // two mobs. Keeps the right-rail logs scrolling in the demo.
    if (tickCount % 15 === 0) {
      if (Math.random() < 0.5) {
        const line = CHAT_LINES[Math.floor(Math.random() * CHAT_LINES.length)];
        ws.send(envelope(session, {
          case: 'chat',
          value: create(ChatMessageSchema, {
            channel: 5 /* OOC */,
            from: line.from,
            target: '',
            text: line.text,
          }),
        }));
      } else if (session.mobs.length >= 2) {
        const a = session.mobs[Math.floor(Math.random() * session.mobs.length)];
        const b = session.mobs[Math.floor(Math.random() * session.mobs.length)];
        if (a.spawn.id !== b.spawn.id) {
          ws.send(envelope(session, {
            case: 'combat',
            value: create(CombatEventSchema, {
              sourceId: a.spawn.id,
              sourceName: a.spawn.name,
              targetId: b.spawn.id,
              targetName: b.spawn.name,
              type: 1,
              damage: 5 + Math.floor(Math.random() * 40),
              spellId: 0,
              spellName: '',
            }),
          }));
        }
      }
    }
  }, TICK_MS);
}

function endSession(ws: WebSocket): void {
  const s = sessions.get(ws);
  if (!s) return;
  if (s.ticker) clearInterval(s.ticker);
  sessions.delete(ws);
  console.log('[demo] session ended');
}

// Snapshot every spawn's filter_flags into a Map<id, oldFlags> so we
// can diff after a rule mutation and only re-emit the changed ones.
function snapshotFlags(s: Session): Map<number, number> {
  const out = new Map<number, number>();
  out.set(s.player.id, s.player.filterFlags);
  for (const m of s.mobs) out.set(m.spawn.id, m.spawn.filterFlags);
  return out;
}

// Recompute every spawn's filter_flags against the current rule set
// and emit a SpawnAdded for each spawn whose flags actually changed.
// This mirrors the daemon's behavior in SessionAdapter::onChangeItem
// (sessionadapter.cpp:507) which uses SpawnAdded — not SpawnUpdated —
// for filter-flag mutations because the showeq-web store doesn't apply
// filter_flags from SpawnUpdated.
function recomputeAndEmit(
  ws: WebSocket, s: Session, prev: Map<number, number>,
): void {
  const send = (spawn: Spawn) => {
    spawn.filterFlags = computeFlags(s.filters, spawn);
    if (prev.get(spawn.id) === spawn.filterFlags) return;
    ws.send(envelope(s, {
      case: 'spawnAdded',
      value: create(SpawnAddedSchema, { spawn }),
    }));
  };
  send(s.player);
  for (const m of s.mobs) send(m.spawn);
}

function sendFilterRules(ws: WebSocket, s: Session): void {
  ws.send(envelope(s, {
    case: 'filterRules',
    value: create(FilterRulesUpdateSchema, { rules: toWireRules(s.filters) }),
  }));
}

function addFilter(
  ws: WebSocket, s: Session,
  filterType: number, pattern: string, perZone: boolean,
): void {
  const trimmed = pattern.trim();
  if (!trimmed) return;
  // Reject duplicates by (type, pattern, perZone) so the panel's add
  // button is idempotent — typing the same rule twice doesn't pile up
  // identical entries.
  if (s.filters.rules.some((r) =>
    r.filterType === filterType && r.pattern === trimmed && r.perZone === perZone)) {
    return;
  }
  const prev = snapshotFlags(s);
  s.filters.rules.push(compileRule(filterType, trimmed, perZone));
  recomputeAndEmit(ws, s, prev);
  sendFilterRules(ws, s);
}

function removeFilter(
  ws: WebSocket, s: Session,
  filterType: number, pattern: string, perZone: boolean,
): void {
  const idx = s.filters.rules.findIndex((r) =>
    r.filterType === filterType && r.pattern === pattern && r.perZone === perZone);
  if (idx === -1) return;
  const prev = snapshotFlags(s);
  s.filters.rules.splice(idx, 1);
  recomputeAndEmit(ws, s, prev);
  sendFilterRules(ws, s);
}

const server = Bun.serve({
  port: PORT,
  fetch(req, srv) {
    if (srv.upgrade(req)) return;
    return new Response('showeq-web-demo: WebSocket only', { status: 426 });
  },
  websocket: {
    open(ws) {
      // Wait for Subscribe before streaming — matches the daemon's
      // SessionAdapter contract; the showeq-web client sends it on open.
      ws.binaryType = 'arraybuffer';
    },
    message(ws, data) {
      if (typeof data === 'string') return;
      const bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      try {
        const env = fromBinary(ClientEnvelopeSchema, bytes);
        const sock = ws as unknown as WebSocket;
        const session = sessions.get(sock);
        switch (env.payload.case) {
          case 'subscribe':
            if (!session) startSession(sock);
            break;
          case 'addFilterRule':
            if (session) {
              addFilter(
                sock, session,
                env.payload.value.filterType,
                env.payload.value.pattern,
                env.payload.value.perZone,
              );
            }
            break;
          case 'removeFilterRule':
            if (session) {
              removeFilter(
                sock, session,
                env.payload.value.filterType,
                env.payload.value.pattern,
                env.payload.value.perZone,
              );
            }
            break;
          // setPref is ignored — the demo has no PrefsBroker to mutate.
        }
      } catch (err) {
        console.warn('[demo] failed to decode ClientEnvelope', err);
      }
    },
    close(ws) {
      endSession(ws as unknown as WebSocket);
    },
  },
});

console.log(`[demo] listening on ws://localhost:${server.port}`);
console.log('[demo] point showeq-web at this URL via Settings → Daemon URL');
