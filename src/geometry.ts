import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create } from '@bufbuild/protobuf';
import {
  MapGeometrySchema,
  MapLineSchema,
  MapLocationSchema,
  type MapGeometry,
  type MapLine,
  type MapLocation,
} from '@gen/seq/v1/events_pb';

// Parses the SOE/Brewall .txt map format used by ~/.showeq/maps.
// The format and coalescing rules mirror showeq-daemon's
// MapData::loadSOEMap (mapcore.cpp:940). Specifically:
//   - The file's raw X/Y axes are already in screen convention
//     (+X right = East, +Y down = South). The daemon historically
//     negated on load into its world (EQ runtime) convention, then
//     re-negated at proto-serialization time to put coords back into
//     screen convention on the wire (see showeq-daemon/src/protoencoder.cpp
//     fillPos / fillMapGeometry, and the seq.v1 Pos message comment).
//     The demo skips the round-trip — load → emit is identity, no
//     negation. Z (height) is the same in both conventions and ships raw.
//   - Each L record is a single segment (x1,y1,z1)→(x2,y2,z2). The
//     loader coalesces consecutive segments into a polyline when the
//     previous segment's first endpoint matches the new segment's
//     second endpoint AND colors match; otherwise a new polyline
//     starts with [(x2,y2,z2), (x1,y1,z1)].
//   - P records are POI labels at (x,y,z) with rgb + a size hint and a
//     label whose spaces are encoded as underscores.
//
// Real-game zones often have three layer files (`<zone>.txt`,
// `<zone>_1.txt`, `<zone>_2.txt`). We assign them layers 0/1/2 and
// merge into a single MapGeometry for the wire — the showeq-web
// MapCanvas can already toggle individual layers.

type Pt = { x: number; y: number; z: number };

// Mirror of SEQMAP_COLOR_TABLE in showeq-daemon/src/mapcolors.h. The
// daemon's getMapConvertColor (mapcore.h:746) maps the file's raw rgb
// to one of 64 named CSS colors, then emits the resolved color (in
// QColor::name() hex form) on the wire. We replicate the same table
// here so a demo running off raw map files looks the same as a real
// daemon session — without it, the ~1700 (0,0,0) lines in
// nektulos.txt all render as solid black instead of the white lattice
// the daemon sends.
const SEQMAP_COLOR_HEX: string[] = [
  /*  0 Black          */ '#000000',
  /*  1 DarkRed        */ '#8b0000',
  /*  2 FireBrick      */ '#b22222',
  /*  3 Red            */ '#ff0000',
  /*  4 DarkGreen      */ '#006400',
  /*  5 Orange         */ '#ffa500',
  /*  6 DarkOrange     */ '#ff8c00',
  /*  7 DarkOrange     */ '#ff8c00',
  /*  8 Green          */ '#008000',
  /*  9 Chartreuse     */ '#7fff00',
  /* 10 Gold           */ '#ffd700',
  /* 11 Gold           */ '#ffd700',
  /* 12 Green          */ '#008000',
  /* 13 Chartreuse     */ '#7fff00',
  /* 14 Goldenrod      */ '#daa520',
  /* 15 Yellow         */ '#ffff00',
  /* 16 DarkBlue       */ '#00008b',
  /* 17 Magenta        */ '#ff00ff',
  /* 18 DeepPink       */ '#ff1493',
  /* 19 DeepPink       */ '#ff1493',
  /* 20 DarkCyan       */ '#008b8b',
  /* 21 Grey           */ '#808080',
  /* 22 IndianRed      */ '#cd5c5c',
  /* 23 LightCoral     */ '#f08080',
  /* 24 SpringGreen    */ '#00ff7f',
  /* 25 LightGreen     */ '#90ee90',
  /* 26 DarkKhaki      */ '#bdb76b',
  /* 27 Khaki          */ '#f0e68c',
  /* 28 SpringGreen    */ '#00ff7f',
  /* 29 PaleGreen      */ '#98fb98',
  /* 30 DarkOliveGreen */ '#556b2f',
  /* 31 Khaki          */ '#f0e68c',
  /* 32 MediumBlue     */ '#0000cd',
  /* 33 DarkViolet     */ '#9400d3',
  /* 34 Magenta        */ '#ff00ff',
  /* 35 Maroon         */ '#800000',
  /* 36 RoyalBlue      */ '#4169e1',
  /* 37 SlateBlue      */ '#6a5acd',
  /* 38 Orchid         */ '#da70d6',
  /* 39 HotPink        */ '#ff69b4',
  /* 40 Turquoise      */ '#40e0d0',
  /* 41 SkyBlue        */ '#87ceeb',
  /* 42 Snow           */ '#fffafa',
  /* 43 LightPink      */ '#ffb6c1',
  /* 44 Cyan           */ '#00ffff',
  /* 45 Aquamarine     */ '#7fffd4',
  /* 46 DarkSeaGreen   */ '#8fbc8f',
  /* 47 Beige          */ '#f5f5dc',
  /* 48 Blue           */ '#0000ff',
  /* 49 Purple         */ '#800080',
  /* 50 Purple         */ '#800080',
  /* 51 Magenta        */ '#ff00ff',
  /* 52 DodgerBlue     */ '#1e90ff',
  /* 53 SlateBlue      */ '#6a5acd',
  /* 54 MediumPurple   */ '#9370db',
  /* 55 Orchid         */ '#da70d6',
  /* 56 DeepSkyBlue    */ '#00bfff',
  /* 57 LightBlue      */ '#add8e6',
  /* 58 Plum           */ '#dda0dd',
  /* 59 Cyan           */ '#00ffff',
  /* 60 CadetBlue      */ '#5f9ea0',
  /* 61 PaleTurquoise  */ '#afeeee',
  /* 62 LightCyan      */ '#e0ffff',
  /* 63 White          */ '#ffffff',
];

function convertMapColor(r: number, g: number, b: number): string {
  // Mirrors mapcore.h:736's index formula. The "if index == 0 → 63"
  // rule is what turns the file's near-black lines into white on the
  // canvas — without it, most of nektulos.txt's lines would draw as
  // pure black.
  let idx = Math.floor(r / 80) + Math.floor(g / 80) * 4 + Math.floor(b / 80) * 16;
  if (idx === 0) idx = 63;
  return SEQMAP_COLOR_HEX[idx] ?? '#ffffff';
}

function parseMapFile(text: string, layer: number): {
  lines: MapLine[];
  locations: MapLocation[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
} {
  const lines: MapLine[] = [];
  const locations: MapLocation[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  // Polyline coalescing state, mirrors mapcore.cpp's currentLineM.
  let cur: MapLine | null = null;
  let curColor = '';

  const expand = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const kind = line[0];
    if (kind !== 'L' && kind !== 'P') continue;
    const fields = line.slice(1).split(',').map((s) => s.trim());

    if (kind === 'L') {
      if (fields.length !== 9) continue;
      // File coords are already in screen convention; pass through as
      // the wire value. Round to ints to match the int16 storage on
      // the daemon side.
      const x1 = Math.round(parseFloat(fields[0]));
      const y1 = Math.round(parseFloat(fields[1]));
      const z1 = Math.round(parseFloat(fields[2]));
      const x2 = Math.round(parseFloat(fields[3]));
      const y2 = Math.round(parseFloat(fields[4]));
      const z2 = Math.round(parseFloat(fields[5]));
      const r = parseInt(fields[6], 10) | 0;
      const g = parseInt(fields[7], 10) | 0;
      const b = parseInt(fields[8], 10) | 0;
      const color = convertMapColor(r, g, b);

      // Last point of the open polyline, if any.
      const last: Pt | null = cur ? lastPoint(cur) : null;
      const continues = cur && last && last.x === x2 && last.y === y2 && last.z === z2 && curColor === color;

      if (!continues) {
        // Start a new polyline. Per daemon behavior, both endpoints of
        // the segment are pushed in order [point2, point1].
        cur = create(MapLineSchema, {
          color,
          layer,
          x: [x2, x1],
          y: [y2, y1],
          z: [z2, z1],
        });
        curColor = color;
        lines.push(cur);
      } else {
        cur!.x.push(x1);
        cur!.y.push(y1);
        cur!.z.push(z1);
      }

      expand(x1, y1);
      expand(x2, y2);
    } else {
      // P record. The label may legitimately contain commas (e.g.
      // "(Mission,Roam)"); rejoin trailing fields so we don't truncate.
      if (fields.length < 8) continue;
      const x = Math.round(parseFloat(fields[0]));
      const y = Math.round(parseFloat(fields[1]));
      const z = Math.round(parseFloat(fields[2]));
      const r = parseInt(fields[3], 10) | 0;
      const g = parseInt(fields[4], 10) | 0;
      const b = parseInt(fields[5], 10) | 0;
      // fields[6] is a size hint (1..3) we don't carry on the wire.
      const name = fields.slice(7).join(',').replace(/_/g, ' ').trim();
      locations.push(create(MapLocationSchema, {
        name, color: convertMapColor(r, g, b),
        x, y, z, zValid: !Number.isNaN(z), layer,
      }));
      expand(x, y);
    }
  }

  return {
    lines, locations,
    bounds: {
      minX: minX === Infinity ? 0 : minX,
      minY: minY === Infinity ? 0 : minY,
      maxX: maxX === -Infinity ? 0 : maxX,
      maxY: maxY === -Infinity ? 0 : maxY,
    },
  };
}

function lastPoint(l: MapLine): Pt {
  const i = l.x.length - 1;
  return { x: l.x[i], y: l.y[i], z: l.z[i] ?? 0 };
}

export interface LoadResult {
  geometry: MapGeometry;
  // Anchor coordinates the simulation can use to seed mob positions.
  // Pulled from the parsed P locations so mobs land at meaningful
  // spots (camps, quest givers, road exits) rather than random voids.
  spawnAnchors: [number, number][];
}

// `<repo>/maps/`. Maps are vendored alongside the demo so it doesn't
// depend on a populated ~/.showeq/maps install — the curl-and-run
// experience is just `bun install && bun run gen && bun run start`.
const MAPS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'maps');

export function loadZoneGeometry(zoneShort: string): LoadResult | null {
  const dir = MAPS_DIR;
  // Layer order: base → _1 → _2. Files that don't exist are skipped.
  const candidates: { path: string; layer: number }[] = [
    { path: resolve(dir, `${zoneShort}.txt`),   layer: 0 },
    { path: resolve(dir, `${zoneShort}_1.txt`), layer: 1 },
    { path: resolve(dir, `${zoneShort}_2.txt`), layer: 2 },
  ];

  let found = false;
  const allLines: MapLine[] = [];
  const allLocs: MapLocation[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const { path, layer } of candidates) {
    if (!existsSync(path)) continue;
    found = true;
    const txt = readFileSync(path, 'utf8');
    const parsed = parseMapFile(txt, layer);
    for (const ln of parsed.lines) allLines.push(ln);
    for (const lc of parsed.locations) allLocs.push(lc);
    if (parsed.bounds.minX < minX) minX = parsed.bounds.minX;
    if (parsed.bounds.minY < minY) minY = parsed.bounds.minY;
    if (parsed.bounds.maxX > maxX) maxX = parsed.bounds.maxX;
    if (parsed.bounds.maxY > maxY) maxY = parsed.bounds.maxY;
    console.log(
      `[demo] loaded ${path} — layer=${layer} lines=${parsed.lines.length} ` +
      `locs=${parsed.locations.length}`,
    );
  }

  if (!found) return null;

  const geometry = create(MapGeometrySchema, {
    minX: minX === Infinity ? -1000 : minX,
    minY: minY === Infinity ? -1000 : minY,
    maxX: maxX === -Infinity ? 1000 : maxX,
    maxY: maxY === -Infinity ? 1000 : maxY,
    lines: allLines,
    locations: allLocs,
  });

  // Pick anchors from locations — prefer named camps/quest spots
  // (size 2 in the file, which we no longer carry, so fall back on
  // string matching). If we can't find enough flavorful ones, top up
  // from any location.
  const interesting = allLocs.filter((l) =>
    l.name && !/^to /.test(l.name) && !/^https?:|^Original |^Revised |^Return /i.test(l.name),
  );
  const pool = interesting.length >= 8 ? interesting : allLocs;
  const anchors: [number, number][] = pool.map((l) => [l.x, l.y]);

  return { geometry, spawnAnchors: anchors };
}
