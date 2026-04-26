import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  ClientEnvelopeSchema,
  SubscribeSchema,
  Topic,
} from '@gen/seq/v1/client_pb';
import { EnvelopeSchema } from '@gen/seq/v1/events_pb';

const ws = new WebSocket('ws://localhost:9091');
ws.binaryType = 'arraybuffer';

const seen = new Map<string, number>();
let updates = 0;
let snapshotMobs = 0;
let playerId = 0;
const playerHeadings: number[] = [];

ws.onopen = () => {
  const env = create(ClientEnvelopeSchema, {
    payload: {
      case: 'subscribe',
      value: create(SubscribeSchema, {
        topics: [Topic.SPAWNS, Topic.ZONE, Topic.PLAYER],
      }),
    },
  });
  ws.send(toBinary(ClientEnvelopeSchema, env));
};

ws.onmessage = (ev) => {
  if (!(ev.data instanceof ArrayBuffer)) return;
  const env = fromBinary(EnvelopeSchema, new Uint8Array(ev.data));
  const c = env.payload.case ?? 'unknown';
  seen.set(c, (seen.get(c) ?? 0) + 1);
  if (env.payload.case === 'snapshot') {
    snapshotMobs = env.payload.value.spawns.length;
    playerId = env.payload.value.playerId;
    const geom = env.payload.value.geometry;
    console.log(
      `[smoke] snapshot — zone=${env.payload.value.zoneShort} spawns=${snapshotMobs} ` +
      `lines=${geom?.lines.length ?? 0} locs=${geom?.locations.length ?? 0}`,
    );
    if (geom) {
      const colorCounts = new Map<string, number>();
      for (const ln of geom.lines) {
        colorCounts.set(ln.color, (colorCounts.get(ln.color) ?? 0) + 1);
      }
      const top = [...colorCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([c, n]) => `${c}=${n}`)
        .join(' ');
      console.log(`[smoke] line colors (top 5): ${top}`);
    }
  } else if (env.payload.case === 'spawnUpdated') {
    updates++;
    if (env.payload.value.id === playerId && env.payload.value.pos) {
      playerHeadings.push(env.payload.value.pos.heading);
    }
  }
};

setTimeout(() => {
  console.log(`[smoke] envelopes by type: ${JSON.stringify(Object.fromEntries(seen))}`);
  console.log(`[smoke] mobs in snapshot=${snapshotMobs} updates=${updates}`);
  const distinctSorted = [...new Set(playerHeadings)].sort((a, b) => a - b);
  const first = playerHeadings.slice(0, 6).join(',');
  const last = playerHeadings.slice(-6).join(',');
  console.log(
    `[smoke] player heading n=${playerHeadings.length} ` +
    `distinct=${distinctSorted.length} ` +
    `range=${distinctSorted[0]}..${distinctSorted[distinctSorted.length - 1]}`,
  );
  console.log(`[smoke] first=${first}  last=${last}`);
  ws.close();
  process.exit(0);
}, 2500);
