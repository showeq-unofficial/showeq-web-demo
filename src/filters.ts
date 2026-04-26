import { create } from '@bufbuild/protobuf';
import {
  FilterRuleSchema,
  type FilterRule,
  type Spawn,
} from '@gen/seq/v1/events_pb';

// One in-memory rule. Mirrors seq.v1.FilterRule on the wire but adds
// the parsed regex + level range so we don't re-parse on every match.
//
// Pattern syntax (matches showeq-daemon's FilterItem, filter.cpp:92):
//   <regex>[;<minlevel>[-<maxlevel>]]
//   - "skeleton"      → match any name containing "skeleton"
//   - "skeleton;5"    → also require level == 5
//   - "skeleton;5-25" → also require level in [5, 25]
//   - "skeleton;5-"   → also require level >= 5 (open upper bound)
// We accept ":" as an alternate separator because the FilterRulesPanel
// placeholder text uses that form ("Name:1-50") and the showeq-c
// docs show ":" too.
export interface CompiledRule {
  filterType: number; // 0..6 (Hunt..Tracer)
  pattern: string;    // original pattern as the user typed it
  perZone: boolean;
  // Match function returning true if the spawn matches this rule.
  match: (spawn: Spawn) => boolean;
}

export interface FilterState {
  rules: CompiledRule[];
}

export function emptyFilterState(): FilterState {
  return { rules: [] };
}

export function compileRule(
  filterType: number,
  pattern: string,
  perZone: boolean,
): CompiledRule {
  // Split off the optional level suffix. We accept either separator
  // (":" or ";") since the UI uses ":" but the daemon parses ";".
  const sepIdx = pattern.search(/[;:]/);
  let regexPart = pattern;
  let minLevel = 0;
  let maxLevel = 0;
  if (sepIdx !== -1) {
    regexPart = pattern.slice(0, sepIdx);
    const levelPart = pattern.slice(sepIdx + 1).trim();
    const dashIdx = levelPart.indexOf('-');
    if (dashIdx === -1) {
      const n = parseInt(levelPart, 10);
      if (!Number.isNaN(n)) { minLevel = n; maxLevel = n; }
    } else {
      const lo = parseInt(levelPart.slice(0, dashIdx), 10);
      const hiStr = levelPart.slice(dashIdx + 1);
      if (!Number.isNaN(lo)) minLevel = lo;
      if (hiStr === '') maxLevel = Number.MAX_SAFE_INTEGER;
      else {
        const hi = parseInt(hiStr, 10);
        if (!Number.isNaN(hi)) maxLevel = hi;
      }
    }
    if (maxLevel < minLevel) maxLevel = minLevel;
  }

  // Try to compile as a regex. If invalid, fall back to a literal
  // case-insensitive substring search so a typo'd pattern doesn't
  // throw on every match call.
  let test: (s: string) => boolean;
  try {
    const re = new RegExp(regexPart, 'i');
    test = (s) => re.test(s);
  } catch {
    const lit = regexPart.toLowerCase();
    test = (s) => s.toLowerCase().includes(lit);
  }

  return {
    filterType, pattern, perZone,
    match: (spawn) => {
      if (!test(spawn.name)) return false;
      if (minLevel === 0 && maxLevel === 0) return true;
      const lvl = spawn.level;
      return lvl >= minLevel && lvl <= maxLevel;
    },
  };
}

// Recompute the filter_flags bitmask for a spawn against the current
// rule set. Each rule type gets bit `(1 << filterType)` if any rule
// of that type matches. Per-zone vs global rules are both applied —
// the demo only has one zone so the distinction is just for round-
// tripping in the panel.
export function computeFlags(state: FilterState, spawn: Spawn): number {
  let flags = 0;
  for (const r of state.rules) {
    const bit = 1 << r.filterType;
    if (flags & bit) continue; // already matched by an earlier rule
    if (r.match(spawn)) flags |= bit;
  }
  return flags;
}

// Convert the in-memory rules back to wire FilterRule messages so the
// FilterRulesPanel can render them. We re-extract the level range for
// the wire because the proto separates pattern from min/max.
export function toWireRules(state: FilterState): FilterRule[] {
  return state.rules.map((r) => {
    const sepIdx = r.pattern.search(/[;:]/);
    let min = 0, max = 0;
    if (sepIdx !== -1) {
      const lvl = r.pattern.slice(sepIdx + 1).trim();
      const dash = lvl.indexOf('-');
      if (dash === -1) {
        const n = parseInt(lvl, 10);
        if (!Number.isNaN(n)) { min = n; max = n; }
      } else {
        const lo = parseInt(lvl.slice(0, dash), 10);
        const hiStr = lvl.slice(dash + 1);
        if (!Number.isNaN(lo)) min = lo;
        if (hiStr !== '') {
          const hi = parseInt(hiStr, 10);
          if (!Number.isNaN(hi)) max = hi;
        }
      }
    }
    return create(FilterRuleSchema, {
      filterType: r.filterType,
      pattern: r.pattern,
      minLevel: min,
      maxLevel: max,
      perZone: r.perZone,
    });
  });
}
