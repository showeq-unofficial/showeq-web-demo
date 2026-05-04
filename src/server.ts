import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  BuffsUpdateSchema,
  CategoriesUpdateSchema,
  ChatMessageSchema,
  CombatEventSchema,
  ConsideredSchema,
  DevicesListSchema,
  EnvelopeSchema,
  FilterRulesUpdateSchema,
  GroupUpdateSchema,
  ItemCacheTotalsSchema,
  ItemLearnedSchema,
  PlayerStatsSchema,
  PrefChangedSchema,
  PrefsSnapshotSchema,
  SnapshotSchema,
  SpawnAddedSchema,
  SpawnPointSchema,
  SpawnPointUpdatedSchema,
  SpawnUpdatedSchema,
  TargetedSchema,
  WornSetSchema,
  type Buff,
  type Pref,
  type Spawn,
  type SpawnPoint,
} from '@gen/seq/v1/events_pb';
import type { ServerWebSocket } from 'bun';
import { ClientEnvelopeSchema } from '@gen/seq/v1/client_pb';
import {
  loadZoneGeometry,
  scanZoneShorts,
  SYSTEM_MAPS_DIR,
  VENDORED_MAPS_DIR,
  type LoadResult,
} from './geometry.ts';
import { loadMobNames, randomPlayerName } from './mobs.ts';
import { buildMobs, buildPlayer, stepMob, type MobState, type ZoneBounds } from './sim.ts';
import { ZONE_LONG_NAMES } from './zoneNames.ts';
import {
  compileRule,
  computeFlags,
  emptyFilterState,
  toWireRules,
  type FilterState,
} from './filters.ts';
import {
  buildAA,
  buildBuffs,
  buildCategories,
  buildDevices,
  buildGroup,
  buildItems,
  buildPrefs,
  buildSkills,
  categoryIdsForName,
  summedTotals,
  WORN_SEED,
} from './seed.ts';

const PORT = Number(process.env.PORT ?? 9091);
const TICK_MS = 200;

// Build the zone allowlist once at startup by scanning the two
// candidate dirs (vendored maps/ and the developer-local
// ~/.showeq/maps). The set returned here is the ONLY input that
// `?m=<zone>` is validated against — exact-match short-name lookup, no
// regex sanitization needed because filesystem-traversal characters
// can't survive scanZoneShorts's `[a-z0-9_-]+\.txt$` filter.
const ZONE_ALLOWLIST = scanZoneShorts([VENDORED_MAPS_DIR, SYSTEM_MAPS_DIR]);
if (ZONE_ALLOWLIST.size === 0) {
  console.error(
    `[demo] no zone .txt files found under ${VENDORED_MAPS_DIR} or ${SYSTEM_MAPS_DIR} — ` +
    `vendor at least one zone or install legacy showeq maps.`,
  );
  process.exit(1);
}
const ZONE_LIST = [...ZONE_ALLOWLIST];
console.log(`[demo] zone allowlist: ${ZONE_ALLOWLIST.size} zones`);

// Geometry parse runs once per zone — popular zones (or the same zone
// re-picked by the random fallback) reuse the cached parse instead of
// re-reading + re-parsing the .txt files on every connection.
const geomCache = new Map<string, LoadResult>();
function getGeometry(zone: string): LoadResult | null {
  let g = geomCache.get(zone);
  if (g) return g;
  const loaded = loadZoneGeometry(zone);
  if (loaded) geomCache.set(zone, loaded);
  return loaded;
}

// Pick a zone for a connection: requested if it's on the allowlist
// AND its geometry actually parses, otherwise fall back to a random
// allowlist entry. The double-check (allowlist + parses) protects
// against a zone whose base file exists but is empty/malformed.
function pickZone(requested: string | null): { zone: string; loaded: LoadResult } {
  if (requested && ZONE_ALLOWLIST.has(requested)) {
    const g = getGeometry(requested);
    if (g) return { zone: requested, loaded: g };
  }
  // Random fallback. Reroll up to a few times if a picked zone fails
  // to load; in practice the curated set parses cleanly so this
  // should resolve on the first try.
  for (let i = 0; i < 8; i++) {
    const z = ZONE_LIST[Math.floor(Math.random() * ZONE_LIST.length)];
    const g = getGeometry(z);
    if (g) return { zone: z, loaded: g };
  }
  throw new Error('[demo] no loadable zone in allowlist after 8 retries');
}
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
  // Per-session in-memory pref store keyed by `${section}|${key}` so
  // SetPref echoes update the same record we sent in PrefsSnapshot.
  prefs: Map<string, Pref>;
  // Buffs ticked down locally so the BuffsPanel countdown moves
  // visibly during a demo session.
  buffs: Buff[];
  // SpawnPoints keyed by SpawnPoint.key. Populated from a small
  // sample of map anchors so SpawnPointList isn't empty.
  spawnPoints: Map<string, SpawnPoint>;
  // Monotonic envelope sequence — clients use this to detect gaps and
  // drive the resume protocol (Subscribe.last_seq), but the demo's
  // session_id is empty so resume falls back to a fresh Snapshot every
  // time. That's fine — this is a demo, not a real session.
  seq: bigint;
  ticker?: ReturnType<typeof setInterval>;
}

// Per-connection state attached to the upgraded WebSocket. Populated
// in `fetch` from URL query params so `open()` and the message
// handlers can read it without a side-table lookup.
type WSData = { zone: string; loaded: LoadResult; spawnCount: number };
type WS = ServerWebSocket<WSData>;

// Default mob count is calibrated for the demo's "feel" — enough mobs
// to populate a SpawnList without crowding the canvas. The cap is
// chosen so a malicious or fat-fingered query can't allocate
// unbounded simulation state; rendering-perf testing past this point
// would say more about the test client than the web client.
const DEFAULT_SPAWN_COUNT = 14;
const MAX_SPAWN_COUNT = 5000;

function parseSpawnCount(raw: string | null): number {
  if (raw == null) return DEFAULT_SPAWN_COUNT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_SPAWN_COUNT;
  return Math.min(n, MAX_SPAWN_COUNT);
}

const sessions = new WeakMap<WS, Session>();

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

function startSession(ws: WS): void {
  const { zone, loaded } = ws.data;
  const zoneLong = ZONE_LONG_NAMES[zone] ?? zone;
  const zoneBounds: ZoneBounds = {
    minX: loaded.geometry.minX, maxX: loaded.geometry.maxX,
    minY: loaded.geometry.minY, maxY: loaded.geometry.maxY,
  };
  const playerName = randomPlayerName();
  const PLAYER_ID = 1;
  // Drop the player at the first available anchor (or the bounding-box
  // center if there are none) so the FOV cone has something to point at.
  const playerAnchor: [number, number] = loaded.spawnAnchors[0]
    ?? [(zoneBounds.minX + zoneBounds.maxX) >> 1,
        (zoneBounds.minY + zoneBounds.maxY) >> 1];
  const { spawn: playerSpawn, mob: playerMobInit } = buildPlayer(
    PLAYER_ID, playerName, playerAnchor, zoneBounds,
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
  const names = loadMobNames(ws.data.spawnCount);
  // Mob anchors skip index 0 so they don't all stack on the player.
  const mobAnchors = loaded.spawnAnchors.length > 1
    ? loaded.spawnAnchors.slice(1)
    : loaded.spawnAnchors;
  const mobs = buildMobs(names, mobAnchors, zoneBounds);
  // Stamp categoryIds onto each mob from the seed regex table — the
  // daemon does this once at SpawnAdded time and never mutates it,
  // so we match that semantic here.
  for (const m of mobs) {
    m.spawn.categoryIds = categoryIdsForName(m.spawn.name);
  }
  // Promote a small sample of mob anchors into spawn points so the
  // SpawnPointList renders something. Real SpawnMonitor only promotes
  // after the second pop at the same coords; the demo skips that
  // (n=1) and just seeds points directly from the mob set.
  const spawnPoints = new Map<string, SpawnPoint>();
  const nowS = BigInt(Math.floor(Date.now() / 1000));
  for (const m of mobs.slice(0, 6)) {
    const x = m.spawn.pos!.x, y = m.spawn.pos!.y, z = m.spawn.pos!.z;
    const key = `${x}|${y}|${z}`;
    spawnPoints.set(key, create(SpawnPointSchema, {
      key, x, y, z,
      name: '',
      last: m.spawn.name,
      lastId: m.spawn.id,
      count: 1,
      spawnTimeS: nowS,
      // diff_time_s = 360 mimics a 6-minute respawn cycle so the
      // SpawnPointList countdown column is non-empty.
      deathTimeS: 0n,
      diffTimeS: 360n,
    }));
  }
  const session: Session = {
    filters: emptyFilterState(),
    player: playerSpawn,
    playerMob: playerMobInit,
    waypoints,
    waypointIdx: 0,
    mobs,
    prefs: new Map(),
    buffs: buildBuffs(PLAYER_ID, playerName),
    spawnPoints,
    seq: 0n,
  };
  // Seed the pref store before sending the snapshot — handle messages
  // arriving on the same socket race the snapshot otherwise.
  for (const p of buildPrefs()) session.prefs.set(`${p.section}|${p.key}`, p);
  sessions.set(ws, session);

  console.log(`[demo] new session — zone=${zone} player=${playerName} mobs=${mobs.length}`);

  // Build worn-set + totals once — the same data ships in the
  // Snapshot and on subsequent ItemCacheTotals/WornSet events.
  const wornSet = create(WornSetSchema, {
    slotIndices: WORN_SEED.map((w) => w.slot),
    itemIds: WORN_SEED.map((w) => w.item.id),
  });
  const totals = summedTotals();
  const itemTotals = create(ItemCacheTotalsSchema, totals);

  // Snapshot first: tells the client the zone (so the title bar updates
  // to "Loading <zone>…" → the long name), the geometry to render
  // on the map canvas, and every spawn including the player.
  const snapshot = create(SnapshotSchema, {
    zoneShort: zone,
    zoneLong: zoneLong,
    playerId: PLAYER_ID,
    spawns: [playerSpawn, ...mobs.map((m) => m.spawn)],
    geometry: loaded.geometry,
    spawnPoints: [...session.spawnPoints.values()],
    items: buildItems(),
    itemTotals,
    wornSet,
    sessionId: '',
  });
  ws.send(envelope(session, { case: 'snapshot', value: snapshot }));

  // PlayerStats so the StatsPanel populates. Skills + purchased_aa
  // make the SkillsWindow and AAWindow render real rows; aa_unspent
  // gives AAWindow's "points to spend" header a non-zero value.
  const stats = create(PlayerStatsSchema, {
    name: playerName,
    class: 1, race: 1, level: 25,
    hpCur: 850, hpMax: 850,
    manaCur: 600, manaMax: 600,
    enduranceCur: 100, enduranceMax: 100,
    expCur: 12_500_000, expMax: 25_000_000,
    aaExpCur: 4_200_000, aaExpMax: 15_000_000,
    aaPoints: 14, aaUnspent: 3,
    str: 95, sta: 95, agi: 95, dex: 90, wis: 80, int: 80, cha: 75,
    skills: buildSkills(),
    purchasedAa: buildAA(),
  });
  ws.send(envelope(session, { case: 'playerStats', value: stats }));

  // Categories drive the per-spawn category_ids tags emitted on every
  // mob in the snapshot — send the index right after so the client can
  // resolve those ids to display names.
  ws.send(envelope(session, {
    case: 'categories',
    value: create(CategoriesUpdateSchema, { categories: buildCategories() }),
  }));

  // Group, buffs, prefs — all panel-feeding broadcasts the daemon
  // sends on Subscribe.
  ws.send(envelope(session, {
    case: 'group',
    value: create(GroupUpdateSchema, { members: buildGroup() }),
  }));
  ws.send(envelope(session, {
    case: 'buffs',
    value: create(BuffsUpdateSchema, {
      capturedMs: BigInt(Date.now()),
      buffs: session.buffs,
    }),
  }));
  ws.send(envelope(session, {
    case: 'prefs',
    value: create(PrefsSnapshotSchema, {
      prefs: [...session.prefs.values()],
    }),
  }));

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

    // Every ~7s, fire a Targeted event toggled with a Considered. Real
    // sessions emit one when the user clicks a mob; the demo cycles
    // through mobs so the SpawnList highlight moves on its own.
    if (tickCount % 35 === 17 && session.mobs.length > 0) {
      const m = session.mobs[Math.floor(Math.random() * session.mobs.length)];
      ws.send(envelope(session, {
        case: 'targeted',
        value: create(TargetedSchema, { spawnId: m.spawn.id }),
      }));
      ws.send(envelope(session, {
        case: 'considered',
        value: create(ConsideredSchema, { spawnId: m.spawn.id }),
      }));
    }

    // Every ~5s, re-emit the BuffsUpdate with decremented durations so
    // the BuffsPanel countdown ticks visibly. When a buff hits 0 we
    // recycle it to the seed value so the panel stays populated.
    if (tickCount % 25 === 0) {
      for (const b of session.buffs) {
        b.durationS = b.durationS > 30 ? b.durationS - 5 : 1500;
      }
      ws.send(envelope(session, {
        case: 'buffs',
        value: create(BuffsUpdateSchema, {
          capturedMs: BigInt(Date.now()),
          buffs: session.buffs,
        }),
      }));
    }

    // Every ~10s, "respawn" one spawn point: bump count + spawn_time_s
    // so the SpawnPointList table shows live updates.
    if (tickCount % 50 === 0 && session.spawnPoints.size > 0) {
      const keys = [...session.spawnPoints.keys()];
      const k = keys[Math.floor(Math.random() * keys.length)];
      const sp = session.spawnPoints.get(k)!;
      sp.count += 1;
      sp.spawnTimeS = BigInt(Math.floor(Date.now() / 1000));
      ws.send(envelope(session, {
        case: 'spawnPointUpdated',
        value: create(SpawnPointUpdatedSchema, { point: sp }),
      }));
    }
  }, TICK_MS);
}

function endSession(ws: WS): void {
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
  ws: WS, s: Session, prev: Map<number, number>,
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

function sendFilterRules(ws: WS, s: Session): void {
  ws.send(envelope(s, {
    case: 'filterRules',
    value: create(FilterRulesUpdateSchema, { rules: toWireRules(s.filters) }),
  }));
}

function addFilter(
  ws: WS, s: Session,
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
  ws: WS, s: Session,
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

const server = Bun.serve<WSData, never>({
  port: PORT,
  fetch(req, srv) {
    // Parse `?m=<short>` from the upgrade URL. pickZone validates
    // against the allowlist and falls back to a random zone if the
    // requested short isn't on the list (or wasn't supplied).
    // `?spawncount=N` controls how many NPCs the session simulates
    // (default 14, capped at MAX_SPAWN_COUNT) — useful for poking at
    // render perf in showeq-web.
    const url = new URL(req.url);
    const picked = pickZone(url.searchParams.get('m'));
    const spawnCount = parseSpawnCount(url.searchParams.get('spawncount'));
    if (srv.upgrade(req, { data: { ...picked, spawnCount } })) return;
    return new Response('showeq-web-demo: WebSocket only', { status: 426 });
  },
  websocket: {
    open(_ws) {
      // Wait for Subscribe before streaming — matches the daemon's
      // SessionAdapter contract; the showeq-web client sends it on open.
    },
    message(ws, data) {
      if (typeof data === 'string') return;
      // Bun's binary message arrives as Buffer (a Uint8Array subclass)
      // — fromBinary accepts Uint8Array directly, so no copy needed.
      const bytes = data;
      try {
        const env = fromBinary(ClientEnvelopeSchema, bytes);
        const session = sessions.get(ws);
        switch (env.payload.case) {
          case 'subscribe':
            if (!session) startSession(ws);
            break;
          case 'addFilterRule':
            if (session) {
              addFilter(
                ws, session,
                env.payload.value.filterType,
                env.payload.value.pattern,
                env.payload.value.perZone,
              );
            }
            break;
          case 'removeFilterRule':
            if (session) {
              removeFilter(
                ws, session,
                env.payload.value.filterType,
                env.payload.value.pattern,
                env.payload.value.perZone,
              );
            }
            break;
          case 'setPref':
            // Mirror PrefsBroker: validate-by-allowlist (we accept
            // anything the client already saw in PrefsSnapshot),
            // overwrite the in-memory copy, then broadcast a
            // PrefChanged echo to the originator. No XML persistence.
            if (session && env.payload.value.pref) {
              const incoming = env.payload.value.pref;
              const k = `${incoming.section}|${incoming.key}`;
              if (session.prefs.has(k)) {
                session.prefs.set(k, incoming);
                ws.send(envelope(session, {
                  case: 'prefChanged',
                  value: create(PrefChangedSchema, { pref: incoming }),
                }));
              }
            }
            break;
          case 'listDevices':
            if (session) {
              ws.send(envelope(session, {
                case: 'devicesList',
                value: create(DevicesListSchema, { devices: buildDevices() }),
              }));
            }
            break;
          case 'renameSpawnPoint':
            // Apply to the in-memory map and echo a SpawnPointUpdated
            // back so the client sees the rename even though the demo
            // doesn't persist anything.
            if (session) {
              const sp = session.spawnPoints.get(env.payload.value.key);
              if (sp) {
                sp.name = env.payload.value.name;
                ws.send(envelope(session, {
                  case: 'spawnPointUpdated',
                  value: create(SpawnPointUpdatedSchema, { point: sp }),
                }));
              }
            }
            break;
        }
      } catch (err) {
        console.warn('[demo] failed to decode ClientEnvelope', err);
      }
    },
    close(ws) {
      endSession(ws);
    },
  },
});

console.log(`[demo] listening on ws://localhost:${server.port}`);
console.log('[demo] point showeq-web at this URL via Settings → Daemon URL');
