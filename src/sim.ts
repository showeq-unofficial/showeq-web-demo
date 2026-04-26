import { create } from '@bufbuild/protobuf';
import { PosSchema, SpawnSchema, type Spawn } from '@gen/seq/v1/events_pb';

export interface ZoneBounds {
  minX: number; maxX: number; minY: number; maxY: number;
}

export interface MobState {
  spawn: Spawn;
  // Cached velocity in world units per tick (~200ms).
  vx: number;
  vy: number;
  // Wander target. When the mob reaches it, we re-roll a new one near
  // its anchor — keeps movement coherent rather than pure brownian.
  tx: number;
  ty: number;
  anchor: [number, number];
  bounds: ZoneBounds;
}

export function buildMobs(
  names: string[],
  anchors: [number, number][],
  bounds: ZoneBounds,
): MobState[] {
  const mobs: MobState[] = [];
  // If the loaded map didn't expose any usable anchor points, fall
  // back to the zone's bounding box center — the mob still wanders,
  // it just doesn't start clustered at known landmarks.
  const seedAnchors: [number, number][] = anchors.length
    ? anchors
    : [[(bounds.minX + bounds.maxX) >> 1, (bounds.minY + bounds.maxY) >> 1]];
  for (let i = 0; i < names.length; i++) {
    const anchor = seedAnchors[i % seedAnchors.length];
    const x = anchor[0] + jitter(120);
    const y = anchor[1] + jitter(120);
    const level = 8 + Math.floor(Math.random() * 30);
    const hpMax = 100 + level * 25;
    const spawn = create(SpawnSchema, {
      // Stable id starting at 1000 — leaves 0..999 for future PC/group
      // ids without collisions.
      id: 1000 + i,
      name: names[i],
      level,
      race: 1,
      type: 1, // NPC
      hpCur: hpMax,
      hpMax,
      pos: create(PosSchema, {
        x, y, z: 0,
        vx: 0, vy: 0, vz: 0,
        heading: Math.floor(Math.random() * 360),
        deltaHeading: 0,
        animation: 0,
      }),
    });
    mobs.push({
      spawn,
      vx: 0, vy: 0,
      tx: anchor[0] + jitter(200),
      ty: anchor[1] + jitter(200),
      anchor: [anchor[0], anchor[1]],
      bounds,
    });
  }
  return mobs;
}

export function buildPlayer(
  id: number,
  name: string,
  anchor: [number, number],
  bounds: ZoneBounds,
): { spawn: Spawn; mob: MobState } {
  const spawn = create(SpawnSchema, {
    id,
    name,
    level: 25,
    race: 1,
    class: 1,
    type: 2, // PC
    hpCur: 850,
    hpMax: 850,
    pos: create(PosSchema, {
      x: anchor[0], y: anchor[1], z: 0,
      vx: 0, vy: 0, vz: 0,
      heading: 0, deltaHeading: 0, animation: 0,
    }),
  });
  return {
    spawn,
    mob: {
      spawn, vx: 0, vy: 0,
      tx: anchor[0], ty: anchor[1],
      anchor: [anchor[0], anchor[1]],
      bounds,
    },
  };
}

// Advance one mob by one tick. Returns true if the mob's pos changed
// enough to warrant emitting a SpawnUpdated.
export function stepMob(m: MobState, speed: number): boolean {
  const cur = m.spawn.pos!;
  let dx = m.tx - cur.x;
  let dy = m.ty - cur.y;
  const distSq = dx * dx + dy * dy;
  if (distSq < 25 * 25) {
    // Reached target — pick a new one near the anchor, biased toward
    // staying within ~400 units so a mob doesn't drift across the zone.
    m.tx = m.anchor[0] + jitter(380);
    m.ty = m.anchor[1] + jitter(380);
    dx = m.tx - cur.x;
    dy = m.ty - cur.y;
  }
  const dist = Math.sqrt(dx * dx + dy * dy) || 1;
  // Smoothly turn toward the target rather than snapping — gives the
  // canvas dot a bit of inertia.
  const desiredVx = (dx / dist) * speed;
  const desiredVy = (dy / dist) * speed;
  m.vx = m.vx * 0.6 + desiredVx * 0.4;
  m.vy = m.vy * 0.6 + desiredVy * 0.4;

  const nx = clamp(cur.x + m.vx, m.bounds.minX, m.bounds.maxX);
  const ny = clamp(cur.y + m.vy, m.bounds.minY, m.bounds.maxY);
  // Heading from velocity, in degrees with EQ compass convention
  // (0=N, 90=E, 180=S, 270=W). The world coordinate system used by
  // showeq has +X = West and +Y = North (loadSOEMap negates the file
  // axes; MapCanvas's `project` then negates both again when mapping
  // world to screen). So a positive vx is motion *west* and a positive
  // vy is motion *north* — atan2(-vx, vy) maps that into compass
  // degrees. atan2 returns radians measured ccw from +x; we offset by
  // pi/2 implicitly via the argument swap so 0° points north.
  // Skip the update when velocity is near-zero — atan2(0,0) is 0
  // (north), which would visibly snap the FOV cone any time the mob
  // briefly stops.
  const speedSq = m.vx * m.vx + m.vy * m.vy;
  if (speedSq > 0.5) {
    cur.heading = (Math.round(
      (Math.atan2(-m.vx, m.vy) * 180) / Math.PI,
    ) + 360) % 360;
  }

  const moved = Math.abs(nx - cur.x) > 0.5 || Math.abs(ny - cur.y) > 0.5;
  cur.x = Math.round(nx);
  cur.y = Math.round(ny);
  cur.vx = Math.round(m.vx * 8);
  cur.vy = Math.round(m.vy * 8);
  return moved;
}

function jitter(amt: number): number {
  return Math.round((Math.random() - 0.5) * 2 * amt);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
