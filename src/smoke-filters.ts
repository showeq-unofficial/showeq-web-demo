import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  AddFilterRuleSchema,
  ClientEnvelopeSchema,
  RemoveFilterRuleSchema,
  SubscribeSchema,
  Topic,
} from '@gen/seq/v1/client_pb';
import { EnvelopeSchema } from '@gen/seq/v1/events_pb';

const URL = process.env.URL ?? 'ws://localhost:9091';

const ws = new WebSocket(URL);
ws.binaryType = 'arraybuffer';

interface SpawnSnap { id: number; name: string; level: number; filterFlags: number }

const spawns = new Map<number, SpawnSnap>();
let ruleCount = 0;
const events: string[] = [];

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

function send(env: ReturnType<typeof create<typeof ClientEnvelopeSchema>>): void {
  ws.send(toBinary(ClientEnvelopeSchema, env));
}

ws.onmessage = (ev) => {
  if (!(ev.data instanceof ArrayBuffer)) return;
  const env = fromBinary(EnvelopeSchema, new Uint8Array(ev.data));
  const p = env.payload;
  if (p.case === 'snapshot') {
    spawns.clear();
    for (const s of p.value.spawns) {
      spawns.set(s.id, { id: s.id, name: s.name, level: s.level, filterFlags: s.filterFlags });
    }
    events.push(`snapshot spawns=${spawns.size}`);
    events.push(`names: ${[...spawns.values()].map((s) => `${s.name}(L${s.level})`).join(' | ')}`);
    setTimeout(runFlow, 200);
  } else if (p.case === 'spawnAdded' && p.value.spawn) {
    const s = p.value.spawn;
    spawns.set(s.id, { id: s.id, name: s.name, level: s.level, filterFlags: s.filterFlags });
  } else if (p.case === 'filterRules') {
    ruleCount = p.value.rules.length;
    events.push(`filterRules n=${ruleCount} (${p.value.rules.map((r) => `${r.filterType}:${r.pattern}@${r.perZone ? 'zone' : 'global'}`).join(',')})`);
  }
};

async function runFlow() {
  const flagged = () => [...spawns.values()].filter((s) => s.filterFlags !== 0);

  // Step 1: add Hunt rule for "Guard" with no level filter
  send(create(ClientEnvelopeSchema, {
    payload: { case: 'addFilterRule', value: create(AddFilterRuleSchema, {
      filterType: 0 /* Hunt */, pattern: 'Guard', perZone: false }) },
  }));
  await sleep(150);
  const hits1 = flagged();
  events.push(`after add Hunt:Guard — flagged=${hits1.length}: ${hits1.map((s) => s.name).join('|')}`);

  // Step 2: add Caution rule for "Felton;1-50"
  send(create(ClientEnvelopeSchema, {
    payload: { case: 'addFilterRule', value: create(AddFilterRuleSchema, {
      filterType: 1 /* Caution */, pattern: 'Felton;1-50', perZone: false }) },
  }));
  await sleep(150);
  const hits2 = flagged();
  events.push(`after add Caution:Felton;1-50 — flagged=${hits2.length}: ${hits2.map((s) => `${s.name}(0x${s.filterFlags.toString(16)})`).join('|')}`);

  // Step 3: remove Hunt:Guard
  send(create(ClientEnvelopeSchema, {
    payload: { case: 'removeFilterRule', value: create(RemoveFilterRuleSchema, {
      filterType: 0, pattern: 'Guard', perZone: false }) },
  }));
  await sleep(150);
  const hits3 = flagged();
  events.push(`after remove Hunt:Guard — flagged=${hits3.length}: ${hits3.map((s) => s.name).join('|')}`);

  // Step 4: dup-add — should be a no-op
  send(create(ClientEnvelopeSchema, {
    payload: { case: 'addFilterRule', value: create(AddFilterRuleSchema, {
      filterType: 1, pattern: 'Felton;1-50', perZone: false }) },
  }));
  await sleep(150);
  events.push(`after dup-add — ruleCount=${ruleCount}`);

  for (const e of events) console.log('[filters]', e);
  ws.close();
  process.exit(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

setTimeout(() => {
  console.error('[filters] timed out');
  for (const e of events) console.log('[filters]', e);
  process.exit(2);
}, 5000);
