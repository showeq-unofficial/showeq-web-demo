// Static seed data used by the demo to populate panels that would
// otherwise sit empty (Buffs, Group, Categories, AA, Skills, Inventory,
// Prefs). All numeric ids/values are picked to look plausible at level
// ~25 — they don't try to mirror any specific real character.
import { create } from '@bufbuild/protobuf';
import {
  AAEntrySchema, type AAEntry,
  BuffSchema, type Buff,
  CategorySchema, type Category,
  GroupMemberSchema, type GroupMember,
  ItemSchema, type Item,
  NetworkDeviceSchema, type NetworkDevice,
  PrefSchema, type Pref,
  SkillEntrySchema, type SkillEntry,
} from '@gen/seq/v1/events_pb';

// FilterTypeDefs index → pretty name; used below to build categories
// that visually resemble the legacy showeq groupings.
export const CATEGORIES: { name: string; color: string; matches: RegExp }[] = [
  { name: 'Casters',  color: '#7faaff', matches: /priest|wisp|nightblood|treant/i },
  { name: 'Undead',   color: '#9966cc', matches: /skeleton|corpse|undead|dread/i },
  { name: 'Animals',  color: '#5fbf5f', matches: /snake|wolf|grizzly|spider|bear/i },
  { name: 'Humanoid', color: '#d4a14b', matches: /orc|lizardman|man|pirate|scout|pawn/i },
  { name: 'Giants',   color: '#c87f7f', matches: /cyclops|kraken|ravager/i },
];

export function buildCategories(): Category[] {
  return CATEGORIES.map((c, i) =>
    create(CategorySchema, { id: i, name: c.name, color: c.color }),
  );
}

export function categoryIdsForName(name: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < CATEGORIES.length; i++) {
    if (CATEGORIES[i].matches.test(name)) out.push(i);
  }
  return out;
}

// Six-slot party. Slots 0–2 are in-zone (resolve to spawn ids when a
// matching mob exists at session start), slots 3–4 are out of zone,
// slot 5 is empty so the panel renders an unfilled row too.
export const GROUP_TEMPLATE: { slot: number; name: string; level: number; class_: number; inZone: boolean }[] = [
  { slot: 0, name: 'Marrik',  level: 27, class_: 1,  inZone: true  }, // Warrior
  { slot: 1, name: 'Sylvana', level: 24, class_: 5,  inZone: true  }, // Shadow Knight
  { slot: 2, name: 'Bremen',  level: 26, class_: 6,  inZone: true  }, // Druid
  { slot: 3, name: 'Ystra',   level: 25, class_: 11, inZone: false }, // Cleric
  { slot: 4, name: 'Daskar',  level: 23, class_: 9,  inZone: false }, // Magician
];

export function buildGroup(): GroupMember[] {
  const filled = GROUP_TEMPLATE.map((g) =>
    create(GroupMemberSchema, {
      slot: g.slot,
      name: g.name,
      inZone: g.inZone,
      spawnId: 0,
      level: g.level,
      class: g.class_,
    }),
  );
  // Pad to MAX_GROUP_MEMBERS = 6 with a single empty slot so the
  // GroupPanel renders an unfilled row.
  filled.push(create(GroupMemberSchema, { slot: 5, name: '', inZone: false }));
  return filled;
}

// Spell-id / display-name pairs. The web client renders by spell_name
// when present, so the ids only need to be stable within a session.
export const PLAYER_BUFFS: { spellId: number; spellName: string; durationS: number }[] = [
  { spellId: 173, spellName: 'Spirit of Wolf',         durationS: 1080 },
  { spellId: 278, spellName: 'Skin like Steel',        durationS: 1620 },
  { spellId:  29, spellName: 'Strength of Earth',      durationS: 1500 },
  { spellId: 388, spellName: 'See Invisible',          durationS: 540  },
];

export function buildBuffs(playerId: number, playerName: string): Buff[] {
  return PLAYER_BUFFS.map((b) =>
    create(BuffSchema, {
      spellId: b.spellId,
      spellName: b.spellName,
      durationS: b.durationS,
      casterId: playerId,
      casterName: playerName,
      targetId: playerId,
      targetName: playerName,
    }),
  );
}

// Sparse skill list — only learned skills, mirroring how the daemon
// filters value=255 entries before sending. Skill ids match the
// SKILL_* enum in showeq-daemon/src/skills.h (also vendored at
// showeq-web/src/ui/skills.ts).
export const PLAYER_SKILLS: { id: number; value: number }[] = [
  { id:  0, value: 145 }, // 1H Blunt
  { id:  1, value: 130 }, // 1H Slashing
  { id: 19, value:  85 }, // Defense
  { id: 28, value:  72 }, // Offense
  { id: 36, value: 100 }, // Swimming
  { id: 38, value:  60 }, // Tracking
  { id: 39, value:  90 }, // Pick Lock
  { id: 51, value: 150 }, // Hand to Hand
];

export function buildSkills(): SkillEntry[] {
  return PLAYER_SKILLS.map((s) =>
    create(SkillEntrySchema, { skillId: s.id, value: s.value }),
  );
}

// Ability ids match arbitrary low values — the AA window keys off the
// id but renders the rank count, so any stable mapping works for a
// demo. Real ability_id values come from OP_SendAATable on the wire.
export const PLAYER_AA: { abilityId: number; rank: number }[] = [
  { abilityId:   1, rank: 3 },
  { abilityId:   2, rank: 3 },
  { abilityId:  17, rank: 1 },
  { abilityId:  42, rank: 2 },
  { abilityId: 100, rank: 5 },
];

export function buildAA(): AAEntry[] {
  return PLAYER_AA.map((a) =>
    create(AAEntrySchema, { abilityId: a.abilityId, rank: a.rank }),
  );
}

// 7 entries: STR, STA, AGI, DEX, CHA, INT, WIS — matches ItemStatIndex.
// 5 resists: CR, DR, PR, MR, FR.
export interface WornItemSeed {
  slot: number;     // worn-slot index (see WornSet doc)
  item: {
    id: number;
    name: string;
    slotMask: number;
    weight: number;
    hp: number; mana: number; endurance: number; ac: number;
    stats: number[]; resists: number[];
  };
}

export const WORN_SEED: WornItemSeed[] = [
  { slot:  2, item: { id: 1001, name: 'Crested Mistmoore Helm',  slotMask: 0x4,    weight: 1.5, hp: 35, mana: 15, endurance: 0, ac: 12, stats: [3, 4, 0, 0, 0, 2, 0], resists: [5, 0, 0, 5, 5] } },
  { slot:  5, item: { id: 1002, name: 'Polished Steel Gorget',   slotMask: 0x20,   weight: 1.0, hp: 20, mana: 0,  endurance: 0, ac:  9, stats: [2, 2, 0, 0, 0, 0, 0], resists: [0, 0, 0, 0, 0] } },
  { slot: 13, item: { id: 1003, name: 'Runed Bronze Bastard Sword', slotMask: 0x2000, weight: 7.5, hp: 0, mana: 0, endurance: 0, ac: 0, stats: [4, 4, 0, 2, 0, 0, 0], resists: [0, 0, 0, 0, 0] } },
  { slot: 14, item: { id: 1004, name: 'Shield of the Sentry',    slotMask: 0x4000, weight: 6.0, hp: 30, mana: 0,  endurance: 0, ac: 14, stats: [0, 3, 0, 0, 0, 0, 0], resists: [0, 5, 0, 0, 0] } },
  { slot: 17, item: { id: 1005, name: 'Banded Mail Tunic',       slotMask: 0x20000, weight: 8.0, hp: 45, mana: 0,  endurance: 0, ac: 22, stats: [2, 4, 0, 0, 0, 0, 0], resists: [0, 0, 0, 0, 0] } },
  { slot: 18, item: { id: 1006, name: 'Banded Mail Greaves',     slotMask: 0x80000, weight: 6.0, hp: 30, mana: 0,  endurance: 0, ac: 18, stats: [0, 3, 0, 2, 0, 0, 0], resists: [0, 0, 0, 0, 0] } },
  { slot: 19, item: { id: 1007, name: 'Banded Mail Boots',       slotMask: 0x200000, weight: 4.0, hp: 18, mana: 0, endurance: 0, ac: 11, stats: [0, 2, 2, 0, 0, 0, 0], resists: [0, 0, 0, 0, 0] } },
  { slot: 20, item: { id: 1008, name: 'Belt of the Forest Walker', slotMask: 0x400000, weight: 1.0, hp: 15, mana: 10, endurance: 0, ac: 6, stats: [1, 1, 1, 1, 1, 1, 1], resists: [3, 3, 3, 3, 3] } },
  { slot:  8, item: { id: 1009, name: 'Cloak of the Watchman',   slotMask: 0x100,    weight: 1.5, hp: 20, mana: 5,  endurance: 0, ac:  8, stats: [0, 2, 2, 0, 0, 0, 0], resists: [0, 0, 0, 5, 0] } },
  { slot: 15, item: { id: 1010, name: 'Band of Tarnished Silver', slotMask: 0x8000,  weight: 0.1, hp: 10, mana: 20, endurance: 0, ac:  3, stats: [0, 0, 0, 0, 0, 4, 0], resists: [0, 0, 0, 0, 0] } },
];

export function buildItems(): Item[] {
  return WORN_SEED.map((w) =>
    create(ItemSchema, {
      id: w.item.id,
      name: w.item.name,
      slotMask: w.item.slotMask,
      weight: w.item.weight,
      hp: w.item.hp,
      mana: w.item.mana,
      endurance: w.item.endurance,
      ac: w.item.ac,
      stats: w.item.stats,
      resists: w.item.resists,
    }),
  );
}

export function summedTotals(): {
  itemCount: number;
  hp: number; mana: number; endurance: number; ac: number;
  stats: number[]; resists: number[]; corruption: number;
} {
  const stats = [0, 0, 0, 0, 0, 0, 0];
  const resists = [0, 0, 0, 0, 0];
  let hp = 0, mana = 0, endurance = 0, ac = 0;
  for (const w of WORN_SEED) {
    hp += w.item.hp; mana += w.item.mana;
    endurance += w.item.endurance; ac += w.item.ac;
    for (let i = 0; i < 7; i++) stats[i] += w.item.stats[i];
    for (let i = 0; i < 5; i++) resists[i] += w.item.resists[i];
  }
  return {
    itemCount: WORN_SEED.length,
    hp, mana, endurance, ac, stats, resists, corruption: 0,
  };
}

export function buildPrefs(): Pref[] {
  // Section/key pairs match what showeq-web's PreferencesPanel reads
  // (Interface.DateTimeFormat, Network.Device, Network.IP). The demo
  // doesn't sniff a real interface, so Network.Device defaults to the
  // first entry of the simulated DevicesList.
  return [
    create(PrefSchema, {
      section: 'Interface', key: 'DateTimeFormat',
      value: { case: 'stringValue', value: 'ddd MMM dd hh:mm' },
    }),
    create(PrefSchema, {
      section: 'Network', key: 'Device',
      value: { case: 'stringValue', value: 'sniff0' },
    }),
    create(PrefSchema, {
      section: 'Network', key: 'IP',
      value: { case: 'stringValue', value: '' },
    }),
  ];
}

export function buildDevices(): NetworkDevice[] {
  return [
    create(NetworkDeviceSchema, { name: 'sniff0', description: 'Mirror port (demo)', isLoopback: false }),
    create(NetworkDeviceSchema, { name: 'eth0',   description: 'Primary uplink (demo)', isLoopback: false }),
    create(NetworkDeviceSchema, { name: 'lo',     description: 'Loopback', isLoopback: true }),
  ];
}
