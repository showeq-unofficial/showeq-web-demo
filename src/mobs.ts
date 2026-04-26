import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromBinary } from '@bufbuild/protobuf';
import { EnvelopeSchema } from '@gen/seq/v1/events_pb';

// Curated Nektulos Forest NPC pool used when the recorded fixture isn't
// available. Names follow the EQ "transformedName" convention (article
// after the noun, no underscore) — see protoencoder.cpp:88.
const FALLBACK_POOL = [
  'decaying skeleton, a',
  'venomous snake, a',
  'large skeleton, a',
  'shadowed man',
  'oashim',
  'tunare priest, a',
  'lizardman scout, a',
  'orc pawn, an',
  'will o wisp, a',
  'forest ravager, a',
  'undead pirate, an',
  'lesser kraken, a',
  'corrupted treant, a',
  'cyclops drone, a',
  'nightblood, a',
  'shadowwolf, a',
  'forest grizzly, a',
  'dread corpse, a',
];

const PC_FIRST_NAMES = [
  'Aldric', 'Brina', 'Cael', 'Dalen', 'Elara', 'Fennrick', 'Gwen', 'Halric',
  'Ilyara', 'Jorrik', 'Kaela', 'Loras', 'Mirra', 'Nessa', 'Orin', 'Pelian',
  'Quinn', 'Ronen', 'Sylas', 'Thalia', 'Veren', 'Wynn', 'Xara', 'Zephyr',
];

const __dirname = dirname(fileURLToPath(import.meta.url));

// Returns up to `max` distinct NPC names. Tries to read names out of
// the local recorded `combat.pbstream` golden if present (the file
// is gitignored — see CLAUDE.md / replay README), falls back to the
// curated pool otherwise.
export function loadMobNames(max = 24): string[] {
  const candidate = resolve(
    __dirname,
    '../../showeq-daemon/tests/replay/combat.pbstream',
  );

  const fromFile = existsSync(candidate) ? extractNames(candidate) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of [...fromFile, ...FALLBACK_POOL]) {
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
      if (out.length >= max) break;
    }
  }
  return out;
}

export function randomPlayerName(): string {
  const first = PC_FIRST_NAMES[Math.floor(Math.random() * PC_FIRST_NAMES.length)];
  // Two-digit suffix mimics live EQ's anti-collision naming on busy servers
  // and keeps each demo session feeling distinct.
  const suffix = Math.floor(Math.random() * 100).toString().padStart(2, '0');
  return `${first}${suffix}`;
}

// Read a length-delimited Envelope stream (uint32_le length + bytes per
// record — see filesink.h) and pull out NPC names from any Snapshot or
// SpawnAdded payload encountered.
function extractNames(path: string): string[] {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch {
    return [];
  }
  const names: string[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32LE(off);
    off += 4;
    if (len === 0 || off + len > buf.length) break;
    const slice = buf.subarray(off, off + len);
    off += len;
    try {
      const env = fromBinary(EnvelopeSchema, slice);
      const p = env.payload;
      if (p.case === 'snapshot') {
        for (const s of p.value.spawns) {
          // type 1 == NPC (events.proto SpawnType.NPC).
          if (s.type === 1 && s.name) names.push(s.name);
        }
      } else if (p.case === 'spawnAdded' && p.value.spawn) {
        const s = p.value.spawn;
        if (s.type === 1 && s.name) names.push(s.name);
      }
    } catch {
      // Best-effort: skip records we can't decode (e.g. proto evolved).
      continue;
    }
  }
  return names;
}
