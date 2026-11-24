// Analysis: report + events + mit sheet -> per-pull wipe causes, death recaps, mit-plan and carry-over checks.
//
// Evidence rules (so nobody gets called out on a guess):
//  - "Was this mit up?" is answered from the log itself: the statuses FFLogs records on each player at the
//    moment a hit lands (the `buffs` field), plus buff/debuff apply/remove events that say who applied it.
//  - Durations and recasts only come from the official Job Guide (jobguide.js); they're used to explain
//    *why* something wasn't up (e.g. "pressed 21s before; lasts 15s") and to compute press windows.
//  - Death categories are inferences and are labelled as such, with the facts that led to them.
import { resolveToken, infoFor, recastOf, CATALOG, TANKS, HEALERS, MELEE, PRANGED, CASTERS, JOB_ABBR, SHIELD_CLASH, DAMAGE_TYPE, TANK_KIT, TANK_STATUSES } from './mits.js';
import { JOB_GUIDE, JOB_GUIDE_PATCH } from './jobguide.js';
import { SLOTS, mechanicAliases, normName } from './plan.js';

const HEALER_SLOT = { WhiteMage: 'White Mage', Astrologian: 'Astrologian', Scholar: 'Scholar', Sage: 'Sage' };
const VULN_RE = /vulnerability|damage down|doom/i;

export const fmt = ms => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const fmt1 = ms => {
  const t = Math.max(0, ms / 1000);
  return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
};
const secs = ms => `${(ms / 1000).toFixed(1)}s`;
const signed = ms => `${ms >= 0 ? '+' : '−'}${Math.abs(ms / 1000).toFixed(1)}s`;
const OFFICIAL = name => `Job Guide, Patch ${JOB_GUIDE_PATCH}`;

/** Guess slot -> actorId from jobs: tanks MT/OT in roster order, healers by job, D1/D2 melee, D3 phys ranged, D4 caster. */
export function autoAssign(players) {
  const a = {};
  const take = (slot, p) => { if (p && !a[slot]) a[slot] = p.id; };
  const tanks = players.filter(p => TANKS.includes(p.job));
  take('MT', tanks[0]); take('OT', tanks[1]);
  for (const p of players) if (HEALER_SLOT[p.job]) take(HEALER_SLOT[p.job], p);
  const melee = players.filter(p => MELEE.includes(p.job));
  const ranged = players.filter(p => PRANGED.includes(p.job));
  const casters = players.filter(p => CASTERS.includes(p.job));
  const dps = [...melee, ...ranged, ...casters];
  take('D1', melee[0]); take('D2', melee[1]); take('D3', ranged[0]); take('D4', casters[0]);
  for (const s of ['D1', 'D2', 'D3', 'D4']) if (!a[s]) take(s, dps.find(p => !Object.values(a).includes(p.id)));
  return a;
}

/**
 * A sheet time with both clocks: "2:54 · 6:11 into pull" (phase clock + the sheet's fight-clock column).
 * Sheets that only have a fight clock (LPDU) give just "6:11 into pull".
 */
export function sheetClock(phaseSec, totalSec, clock) {
  if (clock === 'total') return `${fmt(phaseSec * 1000)} into pull`;
  return totalSec != null ? `${fmt(phaseSec * 1000)} · ${fmt(totalSec * 1000)} into pull` : fmt(phaseSec * 1000);
}

export const median = arr => arr.length ? [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)] : null;

/**
 * Phase clock offset from votes: each vote is (logged time of a same-named hit) − (sheet time). Wrong pairings
 * scatter; the right offset is where most votes pile up (within ±2s). Returns the median of that pile, or 0
 * when fewer than 3 votes agree (too little evidence to shift anything).
 */
function offsetFrom(samples) {
  if (!samples.length) return 0;
  const s = [...samples].sort((a, b) => a - b);
  let best = null, bestN = 0, j = 0;
  for (let i = 0; i < s.length; i++) {
    while (s[i] - s[j] > 4000) j++;
    if (i - j + 1 > bestN) { bestN = i - j + 1; best = [j, i]; }
  }
  if (bestN < 3) return 0;
  const centre = median(s.slice(best[0], best[1] + 1));
  return median(s.filter(v => Math.abs(v - centre) <= 2500));
}

function rowAbilityFrom(votes) {
  const out = {};
  for (const [key, v] of Object.entries(votes)) {
    const [name, n] = Object.entries(v.names).sort((a, b) => b[1] - a[1])[0];
    const total = Object.values(v.names).reduce((a, b) => a + b, 0);
    // byName: matched because the sheet's name matches the log; otherwise only by timing (nearest hit on 4+ players).
    // A mapping learned from fewer than 3 pulls isn't trusted (one odd pull could decide it).
    if (total < 3) continue;
    out[key] = { name, n, total, byName: v.byName >= total / 2 };
  }
  return out;
}

/**
 * Learn the sheet-to-log mapping (per-phase clock offset, and which logged ability each sheet mechanic is)
 * from several reports together, e.g. your pulls plus reference clears, so phases your static hasn't reached
 * yet still get mapped. Each entry: { report, events, fightIds }.
 */
export function learnMapping(entries, plan) {
  const off = plan.phases.map(() => []);
  for (const e of entries) analyze({ ...e, plan, assignments: {}, collect: 'offsets' }).offSamples.forEach((s, k) => off[k].push(...s));
  const phaseOffset = off.map(offsetFrom);
  const votes = {};
  for (const e of entries) {
    const v = analyze({ ...e, plan, assignments: {}, mapping: { phaseOffset }, collect: 'votes' }).votes;
    for (const [key, x] of Object.entries(v)) {
      const t = votes[key] ||= { names: {}, byName: 0 };
      for (const [n, c] of Object.entries(x.names)) t.names[n] = (t.names[n] || 0) + c;
      t.byName += x.byName;
    }
  }
  // offCounts: how many hits agree with the chosen offset (within 2.5s), shown as the evidence for it.
  return { phaseOffset, rowAbility: rowAbilityFrom(votes), offCounts: off.map((s, k) => s.filter(v => Math.abs(v - phaseOffset[k]) <= 2500).length) };
}

/** Encounter IDs in the report, most pulls first. */
export function pickEncounter(report) {
  const counts = {};
  for (const f of report.fights) if (f.encounterID) counts[f.encounterID] = (counts[f.encounterID] || 0) + 1;
  return Object.keys(counts).map(Number).sort((a, b) => counts[b] - counts[a]);
}

export function analyze({ report, plan, events, fightIds, assignments, mapping = null, collect = null }) {
  const abil = new Map(report.masterData.abilities.map(a => [a.gameID, a.name]));
  const aname = id => abil.get(id) || `#${id}`;
  const fights = report.fights.filter(f => fightIds.includes(f.id)).sort((a, b) => a.startTime - b.startTime);
  const encounterID = fights[0]?.encounterID;
  const mainPhases = ((report.phases || []).find(p => p.encounterID === encounterID)?.phases || []).filter(p => !p.isIntermission);

  const playerIds = new Set(fights.flatMap(f => f.friendlyPlayers || []));
  // Real jobs only: FFLogs also lists "Multiple Players (LimitBreak)" and "Unknown" actors.
  const players = report.masterData.actors.filter(a => playerIds.has(a.id) && JOB_ABBR[a.subType]).map(a => ({ id: a.id, name: a.name, job: a.subType }));
  const byId = new Map(players.map(p => [p.id, p]));
  const slotOf = new Map(Object.entries(assignments).map(([s, id]) => [id, s]));
  // Everyone who can appear as a source: players by name, pets as "Eos (Calerie Angelstar's pet)", the Limit Break as such.
  const actorById = new Map(report.masterData.actors.map(a => [a.id, a]));
  const pname = id => {
    const p = byId.get(id); if (p) return p.name;
    const a = actorById.get(id); if (!a) return `actor ${id}`;
    if (a.subType === 'LimitBreak') return 'Limit Break';
    if (a.petOwner != null) return `${a.name} (${byId.get(a.petOwner)?.name || 'a player'}'s pet)`;
    return a.name;
  };

  // Longest official duration of any catalog action that applies this status (caps intervals with no remove).
  const statusSec = name => Math.max(0, ...Object.values(CATALOG).filter(c => c.statuses.includes(name)).map(c => c.sec || 0)) || null;

  // Healing received, compact rows [fight, time, source, target, ability, amount, overheal, isTick, hpAfter, maxHp].
  // FFLogs also logs "Combined HoTs" under the Limit Break actor, repeating the individual HoT ticks: dropped,
  // or every HoT would be counted twice (the HP logged on the next hit proves only one copy was applied).
  const healBy = new Map(fights.map(f => [f.id, []]));
  for (const h of events.heals || []) {
    if (actorById.get(h[2])?.subType === 'LimitBreak' && aname(h[4]) === 'Combined HoTs') continue;
    healBy.get(h[0])?.push(h);
  }
  for (const v of healBy.values()) v.sort((a, b) => a[1] - b[1]);
  const haveHeals = (events.heals || []).length > 0;

  const bucket = (arr = []) => {
    const m = new Map(fights.map(f => [f.id, []]));
    for (const e of arr) m.get(e.fight)?.push(e);
    for (const v of m.values()) v.sort((a, b) => a.timestamp - b.timestamp);
    return m;
  };
  const dmgBy = bucket(events.damage.filter(e => e.type === 'damage'));
  // "calculateddamage" is the server's snapshot; for a fatal hit it's sometimes the only record.
  const calcBy = bucket(events.damage.filter(e => e.type === 'calculateddamage'));
  // Damage type per attack name (FFLogs ability "type"; see DAMAGE_TYPE in mits.js for how it was checked).
  // Keyed by ability ID: one attack name can have several IDs with different types.
  const typeById = new Map(report.masterData.abilities.map(a => [a.gameID, DAMAGE_TYPE[+a.type] || null]));
  // A hit's type: the type every one of its events agrees on (mixed or unknown → null).
  const hitType = evs => { const ts = new Set(evs.map(e => typeById.get(e.abilityGameID) ?? null)); return ts.size === 1 ? [...ts][0] : null; };
  // Attacks the game never reduces: on every snapshot of this attack in the report where a damage-reduction status
  // (mit or enemy debuff) was listed, the game's damage multiplier was still 1.00. Needs 4+ such snapshots.
  const REDUCERS = new Set(Object.values(CATALOG).filter(c => (c.kind === 'mit' || c.kind === 'debuff') && !c.tank).flatMap(c => c.statuses));
  const multStats = new Map();
  for (const e of events.damage) {
    if (e.type !== 'calculateddamage' || e.multiplier == null || byId.has(e.sourceID)) continue;
    const ids = (e.buffs || '').split('.').filter(Boolean);
    if (!ids.some(id => REDUCERS.has(aname(+id)))) continue;
    const n = aname(e.abilityGameID);
    const m = multStats.get(n) || { withMit: 0, one: 0 };
    m.withMit++;
    if (Math.abs(e.multiplier - 1) < 0.005) m.one++;
    multStats.set(n, m);
  }
  // Were tank cooldown presses downloaded? (Older cached downloads only kept party mits.)
  const haveTankCasts = events.casts.some(c => CATALOG[aname(c.abilityGameID)]?.tank);
  const ignoresMit = name => { const m = multStats.get(name); return m && m.withMit >= 4 && m.one === m.withMit ? m : null; };

  // ---------- debuffs that are part of a mechanic ----------
  // Many attacks give a vuln to everyone they hit by design (in DMU: Double-Trouble Trap 561/569 hits, Wave Cannon
  // 167/169, Spellwave 123/132). Those aren't failures. For each (attack, debuff), how often a hit on a player comes
  // with that debuff on them (applied within 1s of the hit, the game applies it at the damage snapshot).
  // Part of the mechanic = the attack hits several players per pull (a routine hit, not a fail-only one such as
  // "Blowout", which only hits whoever failed) and gives the debuff on 60%+ of its hits.
  const FAIL_DEBUFF = /vulnerability|damage down/i;
  const fightSet = new Set(fightIds);
  const enemyHits = events.damage.filter(e => e.type === 'damage' && fightSet.has(e.fight) && byId.has(e.targetID) && !byId.has(e.sourceID) && !actorById.get(e.sourceID)?.petOwner);
  const hitsByTarget = new Map();
  for (const e of enemyHits) { const k = `${e.fight}|${e.targetID}`; if (!hitsByTarget.has(k)) hitsByTarget.set(k, []); hitsByTarget.get(k).push(e); }
  const hitCount = new Map(), hitPulls = new Map(), pairCount = new Map();
  for (const e of enemyHits) {
    const n = aname(e.abilityGameID);
    hitCount.set(n, (hitCount.get(n) || 0) + 1);
    if (!hitPulls.has(n)) hitPulls.set(n, new Set());
    hitPulls.get(n).add(e.fight);
  }
  // The attack a debuff came from: the hit on that player nearest to the apply (within 1s).
  const sourceOfDebuff = e => {
    let best = null;
    for (const h of hitsByTarget.get(`${e.fight}|${e.targetID}`) || []) {
      const dt = Math.abs(h.timestamp - e.timestamp);
      if (dt <= 1000 && (!best || dt < Math.abs(best.timestamp - e.timestamp))) best = h;
    }
    return best ? aname(best.abilityGameID) : null;
  };
  for (const e of events.debuffs) {
    if (!/^apply/.test(e.type) || !fightSet.has(e.fight) || !byId.has(e.targetID) || !FAIL_DEBUFF.test(aname(e.abilityGameID))) continue;
    const src = sourceOfDebuff(e);
    if (src) { const k = `${src}|${aname(e.abilityGameID)}`; pairCount.set(k, (pairCount.get(k) || 0) + 1); }
  }
  // Routine = the attack happens in 30%+ of the pulls that lasted long enough to see it (its median time into the
  // pull). 30%, not 50%: some mechanics pick one of several attacks per pull (Indulgent / Idyllic / Indolent Will).
  // A fail-only attack (Unmitigated Explosion, a "Blowout") shows up in only a few of those, even if it hits all 8.
  const fightById = new Map(report.fights.map(x => [x.id, x]));
  const hitTimes = new Map();
  for (const e of enemyHits) { const n = aname(e.abilityGameID); if (!hitTimes.has(n)) hitTimes.set(n, []); hitTimes.get(n).push(e.timestamp - (fightById.get(e.fight)?.startTime ?? 0)); }
  const routineOf = new Map();
  const routine = src => {
    if (routineOf.has(src)) return routineOf.get(src);
    const ts = (hitTimes.get(src) || []).sort((a, b) => a - b);
    const at = ts[Math.floor(ts.length / 2)] ?? Infinity;
    const lasted = fightIds.filter(id => { const x = fightById.get(id); return x && x.endTime - x.startTime >= at; }).length;
    const r = lasted ? (hitPulls.get(src)?.size || 0) / lasted : 0;
    routineOf.set(src, r);
    return r;
  };
  const debuffDesign = (src, deb) => {
    if (!src || !deb) return null;
    const hits = hitCount.get(src) || 0, pulls = hitPulls.get(src)?.size || 0, n = pairCount.get(`${src}|${deb}`) || 0;
    if (!hits) return null;
    const rate = Math.min(1, n / hits), seen = routine(src);
    return { rate, hits, pulls, seen, designed: hits >= 5 && pulls >= 3 && seen >= 0.3 && rate >= 0.6 };
  };
  const deathBy = bucket(events.deaths.filter(e => e.type === 'death' && byId.has(e.targetID)));
  const castBy = bucket(events.casts.filter(e => e.type === 'cast'));
  const debuffBy = bucket(events.debuffs.filter(e => /^(apply|remove)debuff/.test(e.type)));
  const statusEvBy = bucket([...(events.buffs || []), ...(events.enemyDebuffs || [])]);
  const haveStatusEvents = (events.buffs || []).length + (events.enemyDebuffs || []).length > 0;

  // Positions: FFLogs logs x/y (in 1/100 yalm) on events with resources: every cast (caster) and every hit
  // (target, and the enemy that dealt it). This is the same data the FFLogs/WTFDIG replays draw from.
  const posBy = new Map(); // fight -> Map(actor -> [[t, x, y], ...]) in yalms
  for (const [fight, t, id, x, y] of events.positions || []) {
    let m = posBy.get(fight); if (!m) posBy.set(fight, m = new Map());
    let a = m.get(id); if (!a) m.set(id, a = []);
    a.push([t, x / 100, y / 100]);
  }
  for (const m of posBy.values()) for (const a of m.values()) a.sort((p, q) => p[0] - q[0]);
  const havePositions = posBy.size > 0;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  // Self-centred effects have an official range of "0y/<radius>y" (e.g. Kerachole 0y/30y).
  const radiusOf = name => { const m = (JOB_GUIDE[name]?.range || '').match(/^0y\/(\d+)y$/); return m ? +m[1] : null; };
  // Party-wide actions centred on the caster (official range "0y/Ny"): heals, shields and mits whose reach depends
  // on where people stand. Single-target tools, tank cooldowns, ground circles and cones aren't included.
  const RANGE_ACTIONS = new Set([...Object.entries(CATALOG).filter(([n, c]) => !c.single && !c.tank && c.kind !== 'lb' && c.kind !== 'debuff' && n !== 'Passage of Arms' && radiusOf(n)).map(([n]) => n), 'Helios Conjunction']);

  // ---------- verify status names against this log ----------
  // For each action pressed, which statuses did the presser apply within 1.5s? Confirms the catalog
  // (or corrects it) using this report's own data.
  const learned = {};
  for (const f of fights) {
    const st = statusEvBy.get(f.id);
    for (const c of castBy.get(f.id)) {
      const name = aname(c.abilityGameID);
      const L = learned[name] ||= { casts: 0, seen: {} };
      L.casts++;
      const got = new Set(st.filter(b => /^apply/.test(b.type) && b.sourceID === c.sourceID && b.timestamp >= c.timestamp - 100 && b.timestamp <= c.timestamp + 1500).map(b => aname(b.abilityGameID)));
      got.forEach(s => { L.seen[s] = (L.seen[s] || 0) + 1; });
    }
  }
  const statusesFor = (names, info) => {
    const cat = info.statuses;
    for (const n of names) {
      const L = learned[n];
      if (!L || L.casts < 2) continue;
      if (cat.some(s => (L.seen[s] || 0) >= L.casts * 0.5)) return { list: cat, verified: true };
    }
    return { list: cat, verified: false };
  };

  // ---------- how many players each ability normally hits ----------
  // Grouped by ability NAME, not ID: one mechanic is often logged under several IDs at the same instant
  // (Fell Forces: one ID for tanks, one for healers, one for DPS), and it's one hit for the party.
  function groupHits(enemyDmg) {
    const groups = [], open = new Map();
    for (const e of enemyDmg) {
      const name = aname(e.abilityGameID);
      let g = open.get(name);
      if (!g || e.timestamp - g.t > 1500) {
        g = { ability: e.abilityGameID, name, t: e.timestamp, targets: new Set(), events: [] };
        groups.push(g); open.set(name, g);
      }
      g.targets.add(e.targetID); g.events.push(e);
    }
    return groups;
  }
  // How many players an ability usually hits, by name. Auto-attacks are left out, and with fewer than 5 instances
  // there's no "usually" (typicalOf returns null).
  const sizes = new Map();
  for (const f of fights) for (const g of groupHits(dmgBy.get(f.id).filter(e => !byId.has(e.sourceID)))) {
    if (/^attack$/i.test(g.name)) continue;
    if (!sizes.has(g.name)) sizes.set(g.name, []);
    sizes.get(g.name).push(g.targets.size);
  }
  const typical = new Map([...sizes].filter(([, s]) => s.length >= 5).map(([name, s]) => [name, s.sort((a, b) => a - b)[Math.floor(s.length / 2)]]));
  const typicalN = name => sizes.get(name)?.length || 0;

  // ---------- phase starts ----------
  const phaseStartsOf = f => {
    const trans = [...(f.phaseTransitions || [])].sort((a, b) => a.startTime - b.startTime);
    return plan.phases.map((_, k) => {
      if (mainPhases.length) {
        const ph = mainPhases[k];
        if (!ph) return null;
        const t = trans.find(x => x.id === ph.id);
        return t ? t.startTime : (k === 0 ? f.startTime : null);
      }
      return k === 0 ? f.startTime : (trans[k]?.startTime ?? null);
    });
  };

  // ---------- pass 0: per-phase clock offset between the sheet and the log ----------
  // FFLogs' phase start isn't always the sheet's 0:00 for that phase (P2 here starts ~11s later in the log).
  // Measure it from mechanics whose sheet name matches a logged ability, take the median, and correct for it.
  const nameMatches = (gName, aliases) => { const n = normName(gName); return aliases.some(a => a.length >= 4 && (n === a || n.includes(a) || (n.length >= 6 && a.includes(n)))); };
  const offSamples = plan.phases.map(() => []);
  for (const f of fights) {
    const ps = phaseStartsOf(f);
    const groups = groupHits(dmgBy.get(f.id).filter(e => !byId.has(e.sourceID)));
    plan.phases.forEach((ph, k) => {
      if (ps[k] == null) return;
      for (const row of ph.rows) {
        const exp = ps[k] + row.phaseTime * 1000, al = mechanicAliases(row.mechanic);
        // Every same-named hit within ±90s votes; the offset most rows agree on wins (see offsetFrom).
        // Only hits inside this log phase vote. Phase-clock sheets are within ~90s; fight-clock sheets (LPDU) can be minutes off.
        const lim = ph.clock === 'total' ? Infinity : 90000, end = ps.slice(k + 1).find(v => v != null) ?? f.endTime;
        for (const g of groups) if (g.t >= ps[k] && g.t < end && Math.abs(g.t - exp) <= lim && nameMatches(g.name, al)) offSamples[k].push(g.t - exp);
      }
    });
  }
  if (collect === 'offsets') return { offSamples };
  // A shared mapping (learned from several reports at once, see learnMapping) wins over this report alone.
  const phaseOffset = mapping?.phaseOffset || offSamples.map(offsetFrom);

  // ---------- pass 1: which logged ability is each sheet mechanic? (majority over all pulls) ----------
  const rowKey = (k, ri) => `${k}|${ri}`;
  // How far from the sheet time a hit may be and still count: half the gap to the neighbouring sheet rows,
  // between 2s and 8s, so back-to-back mechanics (Forsaken hits 3-6s apart) can't grab each other's hit.
  const tolOf = (k, ri) => {
    const rows = plan.phases[k].rows, here = rows[ri].phaseTime;
    const gaps = [rows[ri - 1], rows[ri + 1]].filter(Boolean).map(r => Math.abs(r.phaseTime - here) * 1000).filter(g => g > 0);
    return Math.max(2000, Math.min(8000, gaps.length ? Math.min(...gaps) / 2 : 8000));
  };
  const firstPick = (groups, expected, aliases, tol = 8000) => {
    const near = groups.filter(g => Math.abs(g.t - expected) <= tol);
    const byName = near.filter(g => aliases.some(a => a.length >= 4 && (normName(g.name).includes(a) || a.includes(normName(g.name)))))
      .sort((a, b) => Math.abs(a.t - expected) - Math.abs(b.t - expected))[0];
    if (byName) return { g: byName, how: 'name' };
    // Never a failure explosion ("Unmitigated Explosion"): that's a sign the mechanic failed, not the planned hit.
    const big = near.filter(g => g.targets.size >= 4 && !/^unmitigated/i.test(g.name) && Math.abs(g.t - expected) <= Math.min(tol, 6000)).sort((a, b) => Math.abs(a.t - expected) - Math.abs(b.t - expected))[0];
    return big ? { g: big, how: 'big-hit' } : null;
  };
  const votes = {};
  for (const f of fights) {
    const ps = phaseStartsOf(f);
    const groups = groupHits(dmgBy.get(f.id).filter(e => !byId.has(e.sourceID)));
    plan.phases.forEach((ph, k) => {
      if (ps[k] == null) return;
      ph.rows.forEach((row, ri) => {
        const pick = firstPick(groups, ps[k] + row.phaseTime * 1000 + phaseOffset[k], mechanicAliases(row.mechanic), tolOf(k, ri));
        if (!pick) return;
        const v = votes[rowKey(k, ri)] ||= { names: {}, byName: 0 };
        v.names[pick.g.name] = (v.names[pick.g.name] || 0) + 1;
        if (pick.how === 'name') v.byName++;
      });
    });
  }
  if (collect === 'votes') return { votes };
  const rowAbility = mapping?.rowAbility || rowAbilityFrom(votes);

  const pulls = fights.map((f, idx) => analyzePull(f, idx));

  function analyzePull(f, idx) {
    const dmg = dmgBy.get(f.id), casts = castBy.get(f.id), debuffs = debuffBy.get(f.id), statusEv = statusEvBy.get(f.id);
    const enemyDmg = dmg.filter(e => !byId.has(e.sourceID));
    const phaseStart = phaseStartsOf(f);
    const phaseAt = t => { let k = -1; phaseStart.forEach((s, i) => { if (s != null && s <= t) k = i; }); return k; };
    const phaseName = k => k >= 0 ? (plan.phases[k]?.name || `Phase ${k + 1}`) : 'Pre-pull';
    // Times are shown on the sheet's clock (log phase start + measured offset), so they match the sheet's Time column.
    const sheetZero = k => (phaseStart[k] ?? f.startTime) + (phaseOffset[k] || 0);
    // "P2 2:54.0 (6:11 into pull)"; for fight-clock sheets the phase time already is the pull time.
    const P = t => { const k = phaseAt(t); return plan.phases[k]?.clock === 'total' ? `P${k + 1} ${fmt1(t - f.startTime)} into pull` : `P${k + 1} ${fmt1(t - sheetZero(k))} (${fmt(t - f.startTime)} into pull)`; };
    const lastPhaseIdx = phaseAt(f.endTime);

    const groups = groupHits(enemyDmg);
    const groupOf = new Map();
    groups.forEach(g => g.events.forEach(e => groupOf.set(e, g)));

    // Where an actor was at time t: interpolated between the two nearest logged positions if they're
    // ≤3s apart, else the nearest one within maxGap ms. `age` = how far the nearest real sample is from t.
    const track = posBy.get(f.id) || new Map();
    const posAt = (id, t, maxGap = 2000) => {
      const a = track.get(id);
      if (!a || !a.length) return null;
      let lo = 0, hi = a.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (a[mid][0] <= t) lo = mid; else hi = mid - 1; }
      const prev = a[lo][0] <= t ? a[lo] : null, next = prev ? a[lo + 1] : a[0];
      if (prev && next && next[0] - prev[0] <= 3000) {
        const k = (t - prev[0]) / (next[0] - prev[0] || 1);
        return { x: prev[1] + (next[1] - prev[1]) * k, y: prev[2] + (next[2] - prev[2]) * k, age: Math.min(t - prev[0], next[0] - t) };
      }
      const near = [prev, next].filter(Boolean).sort((p, q) => Math.abs(p[0] - t) - Math.abs(q[0] - t))[0];
      return near && Math.abs(near[0] - t) <= maxGap ? { x: near[1], y: near[2], age: Math.abs(near[0] - t) } : null;
    };
    /**
     * For a self-centred effect, who was outside the official radius when it was pressed. Positions are logged
     * centre points and the game also counts hitbox size, so anything within 1y of the edge is called borderline.
     */
    const rangeFacts = (action, casterId, pressT, targetIds) => {
      const R = radiusOf(action);
      if (!R || !havePositions) return [];
      const c = posAt(casterId, pressT, 1500);
      if (!c) return [{ k: 'log', text: `No position logged for ${pname(casterId)} within 1.5s of the press, so range can't be checked.` }];
      const out = [], edge = [], unknown = [];
      for (const id of targetIds) {
        if (id === casterId) continue;
        const p = posAt(id, pressT, 1500);
        if (!p) { unknown.push(pname(id)); continue; }
        const d = dist(c, p);
        if (d > R + 1) out.push(`${pname(id)} ${d.toFixed(1)}y`); else if (d > R - 1) edge.push(`${pname(id)} ${d.toFixed(1)}y`);
      }
      const facts = [];
      if (out.length) facts.push({ k: 'log', text: `When ${action} was pressed (${P(pressT)}), these players were outside its ${R}y radius from ${pname(casterId)}: ${out.join(', ')}.` });
      if (edge.length) facts.push({ k: 'log', text: `Right at the ${R}y edge (can't say for sure): ${edge.join(', ')}.` });
      if (!out.length && !edge.length && !unknown.length) facts.push({ k: 'log', text: `When ${action} was pressed (${P(pressT)}), every one of them was within ${R}y of ${pname(casterId)}.` });
      if (unknown.length) facts.push({ k: 'log', text: `No position logged near the press for: ${unknown.join(', ')}.` });
      facts.push({ k: 'official', text: `${action} affects party members within ${R}y of the caster (range "${JOB_GUIDE[action].range}", ${OFFICIAL()}).`, url: JOB_GUIDE[action].url });
      return facts;
    };

    const deaths = deathBy.get(f.id);
    const isDead = (pid, t) => {
      const d = [...deaths].reverse().find(x => x.targetID === pid && x.timestamp <= t);
      if (!d) return false;
      const back = casts.some(c => c.sourceID === pid && c.timestamp > d.timestamp + 1000 && c.timestamp <= t)
        || dmg.some(e => e.targetID === pid && e.timestamp > d.timestamp + 1000 && e.timestamp <= t);
      return !back;
    };

    // Status intervals: who had which mit status from whom, start..end. Used to say WHO applied a status and when
    // it went on/came off; whether it was on a player at a hit is read from the hit itself (see `has` in evaluate).
    //  - keyed by status ID (some statuses share a name, e.g. Collective Unconscious ring vs mit);
    //  - pets count as their owner (Eos's Fey Illumination is the Scholar's);
    //  - a remove with no open apply is ignored unless it's the first event for that key (status on from before the pull);
    //  - an apply with no remove (e.g. the enemy despawned) is capped at the official duration.
    const intervals = new Map(); // `${statusName}|${target}` -> [{src, start, end, removed, status, id, target}]
    {
      const open = new Map(), seen = new Set();
      const owner = id => actorById.get(id)?.petOwner ?? id;
      const push = iv => { const kk = `${iv.status}|${iv.target}`; if (!intervals.has(kk)) intervals.set(kk, []); intervals.get(kk).push(iv); };
      for (const e of statusEv) {
        const st = aname(e.abilityGameID), src = owner(e.sourceID);
        const k = `${e.abilityGameID}|${e.targetID}|${src}`;
        const first = !seen.has(k); seen.add(k);
        if (/^(apply|refresh)(buff|debuff)$/.test(e.type) || /^apply(buff|debuff)stack$/.test(e.type)) {
          if (!open.has(k)) open.set(k, { src, start: e.timestamp, end: null, status: st, id: e.abilityGameID, target: e.targetID });
        } else if (/^remove(buff|debuff)$/.test(e.type)) {
          let iv = open.get(k);
          if (!iv && first) iv = { src, start: f.startTime, status: st, id: e.abilityGameID, target: e.targetID };
          if (!iv) continue; // duplicate remove: nothing was open
          iv.end = e.timestamp; iv.removed = true; open.delete(k); push(iv);
        }
      }
      for (const iv of open.values()) { const sec = statusSec(iv.status); iv.end = sec ? Math.min(f.endTime, iv.start + sec * 1000 + 1000) : f.endTime; push(iv); }
    }
    const intervalAt = (statuses, target, t, src = null) => {
      for (const s of statuses) for (const iv of intervals.get(`${s}|${target}`) || [])
        if (iv.start <= t + 50 && iv.end >= t - 50 && (src == null || iv.src === src)) return iv;
      return null;
    };
    const intervalAnyTarget = (statuses, t, src = null) => {
      for (const [k, list] of intervals) if (statuses.includes(k.split('|')[0])) for (const iv of list)
        if (iv.start <= t + 50 && iv.end >= t - 50 && (src == null || iv.src === src)) return iv;
      return null;
    };
    // Same status re-applied by someone else while it was up (e.g. two Reprisals): the first one is replaced.
    const overwrittenBy = iv => {
      if (!iv?.removed) return null;
      for (const [k, list] of intervals) if (k.startsWith(iv.status + '|')) for (const o of list)
        if (o.src !== iv.src && Math.abs(o.start - iv.end) <= 150) return o;
      return null;
    };
    const lastIntervalBefore = (statuses, src, t) => {
      let best = null;
      for (const [k, list] of intervals) if (statuses.includes(k.split('|')[0])) for (const iv of list)
        if (iv.src === src && iv.start <= t && (!best || iv.start > best.start)) best = iv;
      return best;
    };
    const buffNames = e => new Set((e.buffs || '').split('.').filter(Boolean).map(id => aname(+id)));
    // The server snapshot of a hit: the calculateddamage event with the same packet and target.
    const snapIndex = new Map(calcBy.get(f.id).map(c => [`${c.packetID}|${c.targetID}`, c]));
    const snapOf = e => (e.type === 'calculateddamage' ? e : snapIndex.get(`${e.packetID}|${e.targetID}`)) || null;
    // Enemy damage-down statuses (Reprisal/Feint/Addle/Dismantled) present on a hit.
    const SHIELD_STATUSES = new Set(Object.values(CATALOG).filter(c => c.kind === 'shield').flatMap(c => c.statuses));
    const ENEMY_DOWN = new Set(Object.values(CATALOG).filter(c => c.kind === 'debuff').flatMap(c => c.statuses));

    // ---------- match each sheet mechanic to its hit ----------
    const rows = [];
    plan.phases.forEach((ph, k) => {
      const ps = phaseStart[k];
      if (ps == null) return;
      ph.rows.forEach((row, ri) => {
        const expected = ps + row.phaseTime * 1000 + phaseOffset[k];
        if (expected > f.endTime + 2000) return;
        const learnedName = rowAbility[rowKey(k, ri)]?.name;
        let g = learnedName && groups.filter(x => x.name === learnedName && Math.abs(x.t - expected) <= tolOf(k, ri))
          .sort((a, b) => Math.abs(a.t - expected) - Math.abs(b.t - expected))[0];
        let how = g ? 'learned' : null;
        // If this mechanic is normally found by its name and that hit isn't here, don't grab another hit instead.
        const byNameUsually = rowAbility[rowKey(k, ri)]?.byName;
        if (!g) { const pick = firstPick(groups, expected, mechanicAliases(row.mechanic), tolOf(k, ri)); if (pick && (pick.how === 'name' || !byNameUsually)) { g = pick.g; how = pick.how; } }
        if (!g) how = 'estimated';
        const t = g ? g.t : expected;
        if (t > f.endTime) return;
        // One entry per player hit (their first event of this hit). Sibling abilities fired at the same instant
        // (Indulgent + Idyllic Will, Spelldriver + Spellwave…) are the same mechanic for the party, so they're merged
        // (±1s, auto-attacks excluded). Statuses come from the server snapshot (calculateddamage with the same
        // packet), which is when the game applied the damage modifiers; the damage row is the fallback.
        const targets = [];
        if (g) {
          const sib = groups.filter(x => x === g || (Math.abs(x.t - g.t) <= 1000 && !/^attack$/i.test(x.name)));
          const evs = sib.flatMap(x => x.events).sort((a, b) => a.timestamp - b.timestamp);
          for (const e of evs) if (byId.has(e.targetID) && !targets.some(x => x.pid === e.targetID)) {
            const snap = snapOf(e);
            const statuses = buffNames(snap || e);
            // Shields often aren't in the hit's status list (they absorb rather than reduce). A shield counts as up when
            // the log's apply/remove rows have it on the player when the damage landed, including one removed at that
            // moment (broken by this hit).
            const logShields = new Set();
            for (const s of SHIELD_STATUSES) if (!statuses.has(s) && (intervals.get(`${s}|${e.targetID}`) || []).some(iv => iv.start <= e.timestamp + 50 && iv.end >= e.timestamp - 50)) { statuses.add(s); logShields.add(s); }
            targets.push({ pid: e.targetID, e, snap, snapT: snap?.timestamp ?? null, statuses, logShields, dmgStatuses: buffNames(e),
              ability: aname(e.abilityGameID), taken: (e.amount || 0) + (e.absorbed || 0), unmit: e.unmitigatedAmount ?? null, more: [] });
          }
          // Multi-hit mechanics: later hits of the same attack on each player (until the next sheet row, max 10s).
          // Verdicts use the first hit; these let a mit that ran out before the last hit be caught.
          const names = new Set(sib.map(x => x.name));
          const nextRow = ph.rows[ri + 1] ? ps + ph.rows[ri + 1].phaseTime * 1000 + phaseOffset[k] : Infinity;
          const until = Math.min(g.t + 10000, nextRow - 1000);
          for (const tg of targets) {
            const later = groups.filter(x => names.has(x.name) && x.t >= g.t - 1000 && x.t < until)
              .flatMap(x => x.events.filter(ev => ev.targetID === tg.pid && ev.timestamp > tg.e.timestamp + 300 && ev.timestamp < until))
              .sort((a, b) => a.timestamp - b.timestamp);
            for (const ev of later) {
              if (tg.more.length && ev.timestamp - tg.more.at(-1).t <= 300) continue; // same instant
              if (ev.timestamp - tg.e.timestamp <= 300) continue;
              tg.more.push({ t: ev.timestamp, statuses: buffNames(snapOf(ev) || ev) });
            }
          }
        }
        rows.push({ key: rowKey(k, ri), phase: k, ri, phaseName: ph.name, mechanic: row.mechanic, sheet: row.phaseTime, total: row.total, clock: ph.clock, pullT: t - f.startTime, t, rel: t - ps - phaseOffset[k],
          how, ability: g?.name || null, bossId: g?.events[0]?.sourceID ?? null, targets, offset: (t - expected) / 1000, items: [],
          damageType: targets.length ? hitType(targets.map(x => x.e)) : null, ignoresMit: g ? ignoresMit(g.name) : null });
      });
    });
    const rowByKey = new Map(rows.map(r => [r.key, r]));

    /**
     * For a press that should still have been running: what do this player's status intervals say happened to
     * the players (or, for Reprisal/Feint/Addle, the enemy) that didn't have it at the hit?
     *  late: it only went on after the hit · used-up: shield came off early · expired: came off before the hit.
     * Returns null when the log shows none of these (then range is checked with positions).
     */
    function timeline(p, st, info, before, t, uncovered, dur) {
      const pool = info.kind === 'debuff'
        ? [...intervals].filter(([k]) => st.list.includes(k.split('|')[0])).flatMap(([, l]) => l)
        : uncovered.flatMap(id => st.list.flatMap(s => intervals.get(`${s}|${id}`) || []));
      const mine = pool.filter(iv => iv.src === p.id && iv.start >= before.timestamp - 500 && iv.start <= t + 3000);
      const need = info.kind === 'debuff' || info.single ? 1 : Math.max(1, Math.ceil(uncovered.length / 2));
      const after = mine.filter(iv => iv.start > t + 50);
      if (after.length >= need) return { status: 'late', iv: after.sort((a, b) => a.start - b.start)[0] };
      const ended = mine.filter(iv => iv.end < t - 50).sort((a, b) => b.end - a.end);
      if (ended.length >= need) {
        const iv = ended[0];
        const early = info.sec != null && iv.end - iv.start < info.sec * 1000 - 1000;
        return { status: info.kind === 'shield' && early ? 'used-up' : 'expired', iv };
      }
      return null;
    }

    // ---------- planned tank Limit Break ----------
    // A party resource (either tank may press it), so it's judged for the party, never as one player's miss.
    function evaluateLb(r) {
      const LB = CATALOG['Tank LB3'].statuses;
      const n = r.targets.length;
      const facts = [];
      const presses = casts.filter(c => LB.includes(aname(c.abilityGameID)) && Math.abs(c.timestamp - r.t) <= 15000);
      let status, covered = 0;
      if (n) {
        const on = r.targets.filter(tg => LB.some(s => tg.statuses.has(s)));
        covered = on.length;
        const names = LB.filter(s => on.some(tg => tg.statuses.has(s)));
        facts.push({ k: 'log', text: `Tank Limit Break${names.length ? ` (${names.join('/')})` : ''} was on ${covered} of ${n} players hit by ${r.ability} (${P(r.t)}, statuses as the game applied them to the hit).` });
        status = covered >= Math.ceil(n / 2) ? 'ok' : 'no-lb';
      } else {
        // No hit logged (often the pull ended before it): only an LB press says anything; without one, don't judge.
        if (!presses.length) return null;
        status = presses.some(c => c.timestamp <= r.t + 300 && r.t - c.timestamp <= 10000) ? 'ok' : 'no-lb';
        facts.push({ k: 'calc', text: 'No hit for this mechanic was found in the log near the sheet time, so this is judged on press timing only.' });
      }
      facts.push(presses.length
        ? { k: 'log', text: presses.map(c => `${pname(c.sourceID)} used ${aname(c.abilityGameID)} at ${P(c.timestamp)} (${signed(c.timestamp - r.t)} vs the hit)`).join('; ') + '.' }
        : { k: 'log', text: 'No tank Limit Break was used within 15s of the hit.' });
      if (status !== 'ok') facts.push({ k: 'calc', text: "The Limit Break is shared by the party and either tank can press it (and the bar may not have been full), so this isn't counted as one player's miss." });
      return { status, facts, covered, n, verified: true, pressedAt: null, lateAt: null };
    }

    // ---------- check every planned mit at every reached mechanic ----------
    const evaluate = (p, names, info, r) => {
      const t = r.t;
      const facts = [];
      const st = statusesFor(names, info);
      // timingSec: effects that reach players later (e.g. Neutral Sect 20s, then a Helios Conjunction shield of 30s).
      const dur = (info.timingSec ?? info.sec) != null ? (info.timingSec ?? info.sec) * 1000 : null;
      const mine = casts.filter(c => c.sourceID === p.id && names.includes(aname(c.abilityGameID)));
      const before = [...mine].reverse().find(c => c.timestamp <= t + 300);
      const after = mine.find(c => c.timestamp > t + 300 && c.timestamp <= t + 5000);
      const n = r.targets.length;
      const officialFact = info.guide ? `${info.name}: effect lasts ${info.sec}s, recast ${info.guide.recast || 'not listed'} (${OFFICIAL()}).${info.note ? ` ${info.note}` : ''}` : null;
      if (info.kind === 'lb') return evaluateLb(r);
      if (isDead(p.id, t)) return { status: 'dead', facts: [{ k: 'log', text: `${p.name} was dead when ${r.ability || r.mechanic} hit (${P(t)}).` }] };
      // The game never reduces this attack (multiplier 1.00 whatever was up), so a damage-reduction mit can't matter.
      if (r.ignoresMit && (info.kind === 'mit' || info.kind === 'debuff')) {
        const m = r.ignoresMit;
        return { status: 'unaffected', covered: 0, n, verified: false, pressedAt: before?.timestamp ?? null, lateAt: after?.timestamp ?? null, facts: [...facts,
          { k: 'log', text: `The game never reduced ${r.ability}: on all ${m.withMit} snapshots of it in this report where a mit or enemy debuff was listed, its damage multiplier was 1.00. This attack ignores damage reduction, so ${info.name} couldn't change it (shields can still absorb it).` }] };
      }
      // Magic-only mits do nothing against a physical attack.
      if (info.dmg === 'magic' && r.damageType === 'physical') {
        return { status: 'unaffected', covered: 0, n, verified: false, pressedAt: before?.timestamp ?? null, lateAt: after?.timestamp ?? null, facts: [...facts,
          { k: 'log', text: `${r.ability} is physical damage (FFLogs damage type).` },
          { k: 'official', text: `${info.name} only reduces magic damage (${OFFICIAL()}), so it can't reduce this attack.`, url: info.guide?.url }] };
      }

      if (before) facts.push({ k: 'log', text: `${p.name} pressed ${aname(before.abilityGameID)} at ${P(before.timestamp)} (${signed(before.timestamp - t)} vs the hit).` });
      else facts.push({ k: 'log', text: `${p.name} didn't press ${names.join('/')} earlier in this pull.` });
      if (after) facts.push({ k: 'log', text: `${p.name} pressed it at ${P(after.timestamp)}, ${secs(after.timestamp - t)} after the hit.` });

      // Was it on each player when the hit landed? The game's own status list on the hit (server snapshot) decides.
      // Status events are only used to say WHO it came from: an interval of this player's overlapping the hit.
      let covered = 0, present = 0;
      const uncovered = [];
      const others = new Map();
      const pressedInTime = before && dur != null && t - before.timestamp <= dur + 300;
      if (n && info.kind !== 'heal') {
        for (const tg of r.targets) {
          const has = st.list.some(s => tg.statuses.has(s));
          if (!has) { uncovered.push(tg.pid); continue; }
          present++;
          const from = tg.snapT ?? t;
          const overlaps = iv => iv.start <= t + 50 && iv.end >= from - 50;
          const pool = info.kind === 'debuff'
            ? [...intervals].filter(([k]) => st.list.includes(k.split('|')[0])).flatMap(([, l]) => l)
            : st.list.flatMap(s => intervals.get(`${s}|${tg.pid}`) || []);
          const live = pool.filter(overlaps);
          const mineLive = live.some(iv => iv.src === p.id);
          const otherSrc = live.find(iv => iv.src !== p.id)?.src;
          // Attribution: theirs if their interval overlaps the hit; someone else's if only another's does;
          // if no interval explains it (status events missing), theirs when they pressed it in time.
          if (mineLive || (!live.length && pressedInTime)) covered++;
          else if (otherSrc != null) { others.set(otherSrc, (others.get(otherSrc) || 0) + 1); uncovered.push(tg.pid); }
          else uncovered.push(tg.pid);
        }
        const where = info.kind === 'debuff' ? 'listed on' : 'on';
        const viaLog = r.targets.some(tg => st.list.some(s => tg.logShields?.has(s)));
        facts.unshift({ k: 'log', text: `${st.list.join('/')} from ${p.name} was ${where} ${covered} of ${n} players hit by ${r.ability} (${P(t)}, ${viaLog ? 'shields read from the log\'s apply/remove rows: on the player when the damage landed, or broken by it' : 'statuses as the game applied them to the hit'}).` });
        if (others.size) facts.push({ k: 'log', text: `${[...others].map(([id, c]) => `${pname(id)}'s ${st.list[0]} covered ${c}`).join(', ')}.` });
      }
      if (officialFact) facts.push({ k: 'official', text: officialFact, url: info.guide?.url });

      // Single-target tools (Aquaveil on the tank…) count when they were on someone that hit landed on.
      const half = info.single ? 1 : Math.ceil(n / 2);
      let status;
      if (info.kind === 'heal' || !n) {
        // No hit data, or a heal: judge by timing only.
        if (before && dur != null && t - before.timestamp <= dur + 300) status = 'ok';
        else if (after) status = 'late';
        else if (before && dur != null && t - before.timestamp <= dur + 30000) status = 'expired';
        else status = 'missing';
        if (!n) facts.push({ k: 'calc', text: 'No hit for this mechanic was found in the log near the sheet time, so this is judged on press timing only.' });
      } else if (covered >= half) status = 'ok';
      else if (present >= half && others.size) status = 'other';
      else if (present >= half) {
        // On the players per the game, but no status event says from whom and they didn't press it in time.
        status = 'other';
        facts.push({ k: 'log', text: `It was on the players at the hit, but the log doesn't show ${p.name} applying it then.` });
      } else {
        // Healer barriers that can't stack: the players who didn't get this one may already have had the other.
        const clashSet = info.kind === 'shield' ? SHIELD_CLASH.find(g => st.list.some(s => g.includes(s))) : null;
        const clashOther = clashSet ? clashSet.filter(s => !st.list.includes(s)) : [];
        const clashing = clashSet ? r.targets.filter(tg => uncovered.includes(tg.pid) && clashOther.some(s => tg.statuses.has(s))) : [];
        const iv = haveStatusEvents && before ? lastIntervalBefore(st.list, p.id, t) : null;
        let tl = null;
        const pressedRecently = before && dur != null && t - before.timestamp <= dur + 300;
        const over = pressedRecently && iv && iv.end < t ? overwrittenBy(iv) : null;
        // This player's own debuff, running on some enemy at the hit, yet not listed on it.
        const own = info.kind === 'debuff' && haveStatusEvents && present === 0 ? intervalAnyTarget(st.list, t, p.id) : null;
        const snapT = r.targets.find(x => x.snapT)?.snapT ?? t;
        const hitHasEnemyDown = r.targets.some(x => [...x.statuses].some(s => ENEMY_DOWN.has(s)));
        if (before && dur != null && t - before.timestamp <= dur + 300 && clashing.length && clashing.length >= Math.ceil(uncovered.length / 2)) {
          // Not this player's miss: the game keeps only one of these barriers on a player.
          status = 'overwritten';
          const had = clashOther.filter(s => clashing.some(tg => tg.statuses.has(s)));
          facts.push({ k: 'log', text: `${clashing.length} of the ${uncovered.length} players without it already had ${had.join('/')} at the hit.` });
          facts.push({ k: 'official', text: `Eukrasian Prognosis II: "Effect cannot be stacked with those of Eukrasian Diagnosis or scholar's Galvanize" (${OFFICIAL()}). Only one of these barriers can be on a player, so the plan (or cast order) decides which one stays.`, url: JOB_GUIDE['Eukrasian Prognosis II']?.url });
        } else if (own && own.start > snapT - 50) {
          status = 'late';
          facts.push({ k: 'log', text: `${own.status} from ${p.name} went on at ${P(own.start)}, after the game had already calculated this hit (${P(snapT)}), so it didn't reduce it.` });
        } else if (own && hitHasEnemyDown) {
          // Other enemy debuffs did reduce this hit, so the attack isn't immune: theirs was on a different enemy.
          status = 'range';
          facts.push({ k: 'log', text: `${own.status} from ${p.name} was on ${pname(own.target)}, but this hit came from ${pname(r.bossId)}, which it wasn't on (other enemy debuffs on that enemy did reduce the hit).` });
        } else if (own) {
          // Their debuff was running, and no enemy debuff at all reduced this hit: this attack isn't reduced by them
          // (e.g. the sheet notes targeted mitigation doesn't work on Wave Cannon).
          status = 'unaffected';
          facts.push({ k: 'log', text: `${own.status} from ${p.name} was on ${pname(own.target)} at ${P(t)}, but the game applied no enemy debuff (Reprisal/Feint/Addle) to ${r.ability} on any of the ${n} players hit: this attack isn't reduced by them.` });
        } else if (over) {
          status = present >= half ? 'other' : 'overwritten';
          facts.push({ k: 'log', text: `${p.name}'s ${iv.status} was replaced at ${P(iv.end)} when ${pname(over.src)} applied the same effect (it doesn't stack)${present >= half ? '' : `, and that one wasn't up for this hit`}.` });
        } else if ((tl = pressedRecently && haveStatusEvents ? timeline(p, st, info, before, t, uncovered, dur) : null)) {
          // The log's own status timeline for the players who didn't have it says what happened.
          status = tl.status;
          const s = tl.iv?.status || st.list[0];
          if (tl.status === 'late') facts.push({ k: 'log', text: `${s} from ${p.name} only went on at ${P(tl.iv.start)}, ${secs(tl.iv.start - t)} after the hit landed (the press was at ${P(before.timestamp)}; effects apply a moment after the press).` });
          else if (tl.status === 'used-up') facts.push({ k: 'log', text: `The shield came off at ${P(tl.iv.end)}, ${secs(tl.iv.end - tl.iv.start)} after it went on (its full time is ${info.sec}s), before this hit: absorbed by earlier damage.` });
          else if (tl.status === 'expired') facts.push({ k: 'log', text: `${s} from ${p.name} came off at ${P(tl.iv.end)}, ${secs(t - tl.iv.end)} before the hit${tl.iv.end - tl.iv.start < (info.sec ?? 0) * 1000 - 1000 ? `, after ${secs(tl.iv.end - tl.iv.start)} instead of its full ${info.sec}s${info.note ? ` (${info.note})` : ''}` : ''}.` });
        } else if (pressedRecently) {
          status = 'range';
          if (info.name !== 'Neutral Sect') facts.push({ k: 'calc', text: info.kind === 'debuff'
            ? "It was pressed recently enough to still be running, but the game didn't list it on this hit: it may have missed (range), gone on a different enemy, or this hit came from an enemy it wasn't on."
            : `It was pressed recently enough to still be running, but only ${covered} of ${n} players hit had it${info.note ? ` (${info.note})` : ''}.` });
          // Range, checked with logged positions against the official radius (self-centred effects only).
          if (info.name === 'Neutral Sect') {
            // The shield is made by Helios Conjunction cast while Neutral Sect is up, so that's the press that matters.
            const helios = casts.filter(c => c.sourceID === p.id && aname(c.abilityGameID) === 'Helios Conjunction' && c.timestamp >= before.timestamp && c.timestamp <= Math.min(t, before.timestamp + 20000));
            if (!helios.length) { status = 'missing'; facts.push({ k: 'log', text: `${p.name} didn't cast Helios Conjunction while Neutral Sect was up (${P(before.timestamp)} to ${P(before.timestamp + 20000)}), so no party-wide Neutral Sect shields were made${covered ? ` (the ${covered} player${covered > 1 ? "s" : ""} who had one likely got it from Aspected Benefic, which shields one target)` : ""}.` }); }
            else facts.push(...rangeFacts('Helios Conjunction', p.id, helios.at(-1).timestamp, uncovered));
          } else if (info.kind !== 'debuff') facts.push(...rangeFacts(aname(before.abilityGameID), p.id, before.timestamp, uncovered));
          // Everyone was in range and nothing in the log explains it: don't blame range (or the player).
          if (status === 'range' && facts.some(x => /every one of them was within/.test(x.text))) {
            status = 'unexplained';
            facts.push({ k: 'calc', text: "Pressed in time with everyone in range, but the log doesn't show it on the players at the hit, and no remove row explains why. Check the replay before treating this as a mistake." });
          }
        } else if (after) status = 'late';
        else if (before && dur != null && t - before.timestamp <= dur + 30000) {
          status = 'expired';
          facts.push({ k: 'calc', text: `${aname(before.abilityGameID)} pressed at ${P(before.timestamp)} + ${dur / 1000}s${info.timingSec ? ' (longest it can last, incl. the follow-up shield)' : ''} = ran out by ${P(before.timestamp + dur)}, ${secs(t - before.timestamp - dur)} before the hit.` });
        } else {
          const rc = recastOf(info.name);
          if (before && rc && before.timestamp + rc * 1000 > t) {
            status = 'cooldown';
            facts.push({ k: 'calc', text: `Still on cooldown: used at ${P(before.timestamp)}, recast ${rc}s, ready again at ${P(before.timestamp + rc * 1000)}.` });
          } else status = 'missing';
        }
      }
      // Multi-hit: up for the first hit, but did it last? Damage reduction and enemy debuffs only (a shield being
      // used up by the hits is expected). Judged on the players hit again, at each later hit.
      if (status === 'ok' && (info.kind === 'mit' || info.kind === 'debuff')) {
        const maxHits = 1 + Math.max(0, ...r.targets.map(tg => tg.more?.length || 0));
        for (let h = 1; h < maxHits; h++) {
          const at = r.targets.filter(tg => tg.more?.[h - 1]);
          // A later hit on only a few of the players (someone taking an extra tower) isn't the party mechanic.
          if (!info.single && at.length < Math.max(2, Math.ceil(n / 2))) continue;
          const lacking = at.filter(tg => !st.list.some(s => tg.more[h - 1].statuses.has(s)));
          if (at.length && lacking.length >= (info.single ? at.length : Math.ceil(at.length / 2))) {
            status = 'expired';
            const hitT = Math.min(...at.map(tg => tg.more[h - 1].t));
            facts.push({ k: 'log', text: `${r.ability} hit ${maxHits} times. ${st.list[0]} was up for the first hit, but ${lacking.length} of the ${at.length} players hit again didn't have it at hit ${h + 1} of ${maxHits} (${P(hitT)}).` });
            break;
          }
        }
      }
      return { status, facts, covered, n, verified: st.verified, pressedAt: before?.timestamp ?? null, lateAt: after?.timestamp ?? null };
    };

    // A sheet can move a tank job to the other column from some phase on (LPDU P3: "Paladin … will be OFFTANK (right
    // column) from this point of the fight onwards"). Then the MT/OT players swap for those phases.
    const pidFor = (slot, phase) => {
      const sw = plan.phases[phase]?.tankSwap;
      if (sw && (slot === 'MT' || slot === 'OT')) {
        const other = slot === 'MT' ? 'OT' : 'MT';
        const here = byId.get(assignments[slot]), there = byId.get(assignments[other]);
        // The named job belongs in sw.slot: swap only when it's sitting in the other column.
        if (here && there && there.job === sw.job && slot === sw.slot) return there.id;
        if (here && there && here.job === sw.job && slot !== sw.slot) return there.id;
      }
      return assignments[slot];
    };

    for (const r of rows) {
      const row = plan.phases[r.phase].rows[r.ri];
      for (const slot of SLOTS) {
        const pid = pidFor(slot, r.phase);
        const p = byId.get(pid);
        if (!p) continue;
        for (const tok of row.cells[slot] || []) {
          if (tok.skip) continue;
          const names = resolveToken(tok, p.job);
          if (!names) continue;
          // One tank LB per mechanic, however many tank columns list it.
          if (tok.lb && r.items.some(x => x.shared)) continue;
          const info = infoFor(names);
          const res = evaluate(p, names, info, r);
          if (!res) continue; // nothing to judge (e.g. a planned LB on a hit that never came)
          const label = tok.lb ? 'Tank LB3 (party, either tank)' : tok.party ? `Party Mit (${names[0]})` : (names.length === 1 ? names[0] : tok.label);
          r.items.push({ slot, player: p, names, info, label, sheetText: tok.raw, carry: tok.carry, origin: tok.origin, shared: !!tok.lb, ...res,
            delta: res.pressedAt != null ? (res.pressedAt - r.t) / 1000 : null, usedFor: null });
        }
      }
    }

    // The sheet sometimes asks one player for the same action twice within its official recast (e.g. the OT's party
    // mit at 0:38 and again at 1:58 when Dark Missionary's recast is 90s). Both can't be done, so the one that wasn't
    // done is marked 'conflict' (not counted as the player's miss) and says so.
    for (const r of rows) for (const it of r.items) {
      if (it.carry || ['ok', 'other', 'used-up', 'unaffected', 'dead'].includes(it.status)) continue;
      const rc = recastOf(it.info.name);
      if (!rc) continue;
      // Checked against the sheet itself (not just mechanics this pull reached): the plan is impossible either way.
      const clashes = plan.phases[r.phase].rows.map((o, oi) => ({ o, oi })).filter(({ o, oi }) => oi !== r.ri && Math.abs(o.phaseTime - r.sheet) < rc
        && (o.cells[it.slot] || []).some(tok => !tok.carry && !tok.skip && (resolveToken(tok, it.player.job) || []).includes(it.info.name)));
      // Only the one that couldn't be done is excused: the partner was done this pull, the pull ended before the
      // partner (so it can't show which of the two the player keeps), or (neither done) the partner comes first on
      // the sheet. Otherwise this one was possible, and stays a miss.
      const doneAt = ({ oi }) => !rowByKey.has(rowKey(r.phase, oi)) || (rowByKey.get(rowKey(r.phase, oi))?.items || []).some(x => x.slot === it.slot && x.info.name === it.info.name && !x.carry && ['ok', 'other', 'used-up', 'unaffected'].includes(x.status));
      const clash = (clashes.find(doneAt) || clashes.find(({ o }) => o.phaseTime < r.sheet))?.o;
      if (!clash) continue;
      it.status = 'conflict';
      it.facts.push({ k: 'calc', text: `The sheet also asks ${it.player.name} for ${it.info.name} at ${clash.mechanic} (${fmt(clash.phaseTime * 1000)}), ${Math.abs(clash.phaseTime - r.sheet)}s apart on the sheet, but its recast is ${rc}s (official): both can't be done.` });
    }

    // Where a mit that wasn't on time was actually used (nearest press, attributed to the next mechanic it reached).
    // Searched within the action's recast, so a press for a much later mechanic is still found.
    for (const r of rows) for (const it of r.items) {
      if (['ok', 'dead', 'other', 'used-up', 'unaffected'].includes(it.status) || it.carry) continue;
      const reach = Math.max(60, recastOf(it.info.name) || 0) * 1000;
      const press = casts.filter(c => c.sourceID === it.player.id && it.names.includes(aname(c.abilityGameID)) && Math.abs(c.timestamp - r.t) <= reach)
        .sort((a, b) => Math.abs(a.timestamp - r.t) - Math.abs(b.timestamp - r.t))[0];
      if (!press) continue;
      const covers = rows.find(x => x.t >= press.timestamp - 500 && x.t - press.timestamp <= (it.info.sec ?? 20) * 1000);
      if (covers && covers !== r) it.usedFor = `${covers.phase !== r.phase ? `P${covers.phase + 1} ` : ''}${covers.mechanic} (${sheetClock(covers.sheet, covers.total, covers.clock)})`;
    }

    // ---------- carry-over chains ----------
    // A chain = the original press (row with "X") + every later row with "➔ X" for the same slot.
    const chains = new Map();
    for (const r of rows) for (const it of r.items) {
      if (it.origin == null) continue;
      const key = `${r.phase}|${it.origin}|${it.slot}|${it.names[0]}`;
      const c = chains.get(key) || { key, phase: r.phase, originRi: it.origin, slot: it.slot, player: it.player, label: it.label, names: it.names, info: it.info, links: [] };
      c.links.push({ row: r, item: it });
      chains.set(key, c);
    }
    const chainList = [...chains.values()].filter(c => c.links.length > 1 || c.links.some(l => l.item.carry));
    for (const c of chainList) {
      c.links.sort((a, b) => a.row.t - b.row.t);
      const first = c.links[0].row, last = c.links[c.links.length - 1].row;
      c.complete = rowByKey.has(`${c.phase}|${c.originRi}`) && c.links.length === countPlannedLinks(c);
      // A chain lasts if the effect was up at every linked hit. A shield used up by an earlier link did its job there,
      // but the later hits went unshielded, so "used up" only counts as lasting on the LAST link.
      const lastI = c.links.length - 1;
      const holds = (l, i) => ["ok", "other", "unaffected"].includes(l.item.status) || (l.item.status === "used-up" && i === lastI);
      c.held = c.links.every(holds);
      c.brokeAt = c.links.find((l, i) => !holds(l, i) && l.item.status !== "dead") || null;
      const dur = c.info.sec != null ? c.info.sec * 1000 : null;
      const press = c.links[0].item.pressedAt;
      c.press = press;
      c.firstT = first.t; c.lastT = last.t;
      if (dur != null && c.links.length > 1 && !c.info.noWindow) {
        c.window = { from: last.t - dur, to: first.t };
        c.windowRel = { from: (last.t - dur - first.t) / 1000, to: 0 };
        c.impossible = c.window.from > c.window.to;
      }
      c.facts = [];
      c.facts.push({ k: 'log', text: `Hits in this chain: ${c.links.map(l => `${l.row.mechanic} at ${P(l.row.t)}`).join(' → ')}.` });
      if (press != null) c.facts.push({ k: 'log', text: `${c.player.name} pressed ${c.names[0]} at ${P(press)} (${signed(press - first.t)} vs ${first.mechanic}).` });
      if (dur != null) c.facts.push({ k: 'official', text: `${c.info.name} lasts ${c.info.sec}s (${OFFICIAL()}).`, url: c.info.guide?.url });
      if (c.window) {
        if (c.impossible) c.facts.push({ k: 'calc', text: `${first.mechanic} to ${last.mechanic} is ${secs(last.t - first.t)}, longer than ${c.info.sec}s: one press can't cover every hit in this pull.` });
        else c.facts.push({ k: 'calc', text: `To cover every hit, press between ${P(c.window.from)} and ${P(c.window.to)} (${Math.abs(c.windowRel.from).toFixed(1)}s to 0s before ${first.mechanic}).` });
      }
    }
    function countPlannedLinks(c) {
      const ph = plan.phases[c.phase];
      let n = 0;
      ph.rows.forEach((row, ri) => { if ((row.cells[c.slot] || []).some(t => t.origin === c.originRi && !t.skip && (t.names?.[0] === c.names[0] || t.party))) n++; });
      return n;
    }

    const rowNear = (t, maxMs = 8000) => {
      let best = null;
      for (const r of rows) { const d = Math.abs(r.t - t); if (d <= maxMs && (!best || d < Math.abs(best.t - t))) best = r; }
      return best;
    };

    // ---------- deaths ----------
    // Timing in the log: the server's damage calculation (calculateddamage, "snapshot") comes ~0.6s before the damage
    // row, and the death event ~2s after it. So HP going in is read from the snapshot, and debuffs are checked at the
    // fatal hit (the game clears them there), not at the death event.
    const applied = debuffs.filter(e => e.type.startsWith('apply') && VULN_RE.test(aname(e.abilityGameID)));
    const sharedVuln = e => applied.filter(x => x.abilityGameID === e.abilityGameID && Math.abs(x.timestamp - e.timestamp) <= 1000).length >= 4;
    const stillOn = (e, T) => !debuffs.some(x => x.type.startsWith('remove') && x.targetID === e.targetID && x.abilityGameID === e.abilityGameID && x.timestamp > e.timestamp && x.timestamp < T - 50);
    // A hit took them to 0: a damage row with overkill / 0 HP after, or (snapshot only) damage at least their HP.
    const fatalEv = e => e.type === 'damage' ? ((e.overkill || 0) > 0 || (e.targetResources || e).hitPoints === 0)
      : (e.amount || 0) > 0 && (e.amount || 0) >= ((e.targetResources || e).hitPoints ?? Infinity);
    const hitsOn = (pid, from, to) => {
      const real = dmg.filter(e => e.targetID === pid && e.timestamp >= from && e.timestamp <= to);
      const snapOnly = calcBy.get(f.id).filter(e => e.targetID === pid && e.timestamp >= from && e.timestamp <= to && (e.amount || 0) > 0 && !real.some(x => x.packetID === e.packetID));
      return [...real, ...snapOnly].sort((a, b) => a.timestamp - b.timestamp);
    };
    const hasFatalHit = d => hitsOn(d.targetID, d.timestamp - 5000, d.timestamp + 300).some(fatalEv);
    // Official % damage reduction from a tooltip ("by 10%", "only suffer 90%"); the smaller one when it lists two.
    const mitPct = name => {
      const txt = JOB_GUIDE[name]?.text || '';
      const by = [...txt.matchAll(/by (\d+)%/g)].map(m => +m[1]);
      const suffer = txt.match(/only suffer (\d+)%/);
      const v = by.length ? Math.min(...by) : suffer ? 100 - +suffer[1] : null;
      return v != null ? v / 100 : null;
    };
    // A tank cooldown's own damage reduction from its tooltip ("Reduces damage taken by 40%"). Only the "damage taken"
    // figure counts (Great Nebula's "maximum HP by 20%" or Camouflage's "parry rate by 50%" aren't reduction);
    // Dark Mind's "physical … by 10%" is the smaller of its two, so the estimate stays on the safe side.
    const tankPct = name => { const m = (JOB_GUIDE[name]?.text || '').match(/reduc\w* (?:target's |physical |magic )?damage taken (?:by [a-z ]+? )?by (\d+)%/i); return m ? +m[1] / 100 : null; };

    /**
     * For a tank's death: Walking Dead that wasn't healed off, and otherwise which tank cooldowns were on them at the
     * fatal hit, which were on cooldown, and which were ready and unused (with what the official % would have done).
     */
    function tankAtDeath(v, d, killing, vStatuses, { burstTotal, hpIn, maxHp, lowHp }) {
      const facts = [];
      const t = d.timestamp;
      const statusOnHits = (name, from, to) => hitsOn(v.id, from, to).filter(e => buffNames(snapOf(e) || e).has(name) || buffNames(e).has(name)).map(e => e.timestamp);
      const statusApplied = (name, from, to) => statusEv.filter(b => b.targetID === v.id && /^apply/.test(b.type) && aname(b.abilityGameID) === name && b.timestamp >= from && b.timestamp <= to).map(b => b.timestamp);

      // Walking Dead: Living Dead's 0 HP state. It kills when it runs out unless max HP worth of healing came in.
      // FFLogs doesn't log Walking Dead itself (in real DMU logs: 34 Living Deads triggered, 0 Walking Dead rows), so
      // its start is read from Living Dead coming off early: removed well before its 10s, at the moment HP hit 0.
      if (v.job === 'DarkKnight') {
        const ldTriggered = (intervals.get(`Living Dead|${v.id}`) || [])
          .filter(iv => iv.removed && iv.end - iv.start < 9500 && iv.end <= t && t - iv.end <= 10800).map(iv => iv.end);
        const wdDebuff = debuffs.filter(b => b.targetID === v.id && /^apply/.test(b.type) && aname(b.abilityGameID) === 'Walking Dead' && b.timestamp >= t - 11500 && b.timestamp <= t).map(b => b.timestamp);
        const wd = [...ldTriggered, ...wdDebuff, ...statusApplied('Walking Dead', t - 11500, t), ...statusOnHits('Walking Dead', t - 11500, t + 300)];
        const rebirth = statusApplied('Undead Rebirth', t - 11500, t).length + statusOnHits('Undead Rebirth', t - 11500, t + 300).length > 0;
        if (wd.length && !rebirth) {
          const from = Math.min(...wd);
          const got = (healBy.get(f.id) || []).filter(h => h[3] === v.id && h[1] >= from && h[1] <= t);
          const healed = got.reduce((a, h) => a + h[5] + h[6], 0);
          const max = maxHp ?? got.find(h => h[9])?.[9] ?? null;
          facts.push({ k: 'log', text: `${ldTriggered.length ? `Living Dead came off ${v.name} early at ${P(from)} (their HP hit 0), so Walking Dead started then; no Undead Rebirth followed` : `Walking Dead was on ${v.name} from ${P(from)}`}. Healing that landed on them from then until death: ${num(healed)} (incl. overheal)${max ? `, vs ${num(max)} max HP needed` : ''}.` });
          facts.push({ k: 'official', text: `Living Dead: "If, before the Walking Dead timer runs out, an amount of HP totaling your maximum HP is restored, the effect will change to Undead Rebirth. If this amount is not restored, you will be KO'd." Walking Dead Duration: 10s (${OFFICIAL()}).`, url: JOB_GUIDE['Living Dead']?.url });
          return { facts, summary: null, walkingDead: `Living Dead turned into Walking Dead (on from ${P(from)}). It only ends safely if ${v.name} is healed for their max HP within 10s; ${num(healed)} healing landed, so it ran out and killed them. A healing (or Living Dead timing) issue, not one hit.` };
        }
      }
      if (!killing) return facts.length ? { facts, summary: null } : null;
      const T = killing.timestamp;

      // What was on them at the hit: the game's status list, plus barriers from the apply/remove rows.
      const onAt = statuses => {
        const s = new Set([...vStatuses].filter(x => statuses.has(x)));
        for (const x of statuses) if ((intervals.get(`${x}|${v.id}`) || []).some(iv => iv.start <= T + 50 && iv.end >= T - 50)) s.add(x);
        return s;
      };
      const up = onAt(TANK_STATUSES);
      facts.push({ k: 'log', text: up.size ? `Tank cooldowns on ${v.name} at the fatal hit: ${[...up].join(', ')}.` : `No tank cooldown was on ${v.name} at the fatal hit (statuses as the game applied them to the hit).` });
      const need = lowHp ? hpIn : maxHp;
      // What a ready tool would have done, by its official %: invulns always save; barriers have no % to work with.
      const judge = (name, info, who = '') => {
        if (info.invuln) return { name, who, saves: true, text: `${name}${who} (invuln)` };
        const p = tankPct(name);
        if (p == null || !burstTotal || !need) return { name, who, saves: null, text: `${name}${who}` };
        const left = burstTotal * (1 - p);
        return { name, who, saves: left < need, left, text: `${name}${who} (−${Math.round(p * 100)}%: ${num(left)} would have got through vs ${num(need)} HP${lowHp ? ' going in' : ''})` };
      };

      // Healers' single-target tools on the tank. "Ready" only for single-charge tools with a 45s+ recast
      // (Aquaveil, Exaltation, Haima, Taurochole): charge tools (Benison, Intersection) can't be tracked from presses.
      const HEAL_SINGLE = Object.entries(CATALOG).filter(([, c]) => c.single && !c.tank && (c.kind === 'mit' || c.kind === 'shield'));
      const healUp = onAt(new Set(HEAL_SINGLE.flatMap(([, c]) => c.statuses)));
      if (healUp.size) facts.push({ k: 'log', text: `Healer single-target tools on ${v.name} at the fatal hit: ${[...healUp].join(', ')}.` });
      const healReady = [];
      for (const h of players.filter(p => HEALERS.includes(p.job) && !isDead(p.id, T - 50))) {
        for (const [name, c] of HEAL_SINGLE) {
          const g = JOB_GUIDE[name];
          const rc = recastOf(name);
          if (!g || g.job !== h.job.toLowerCase() || !rc || rc < 45 || /Maximum Charges/.test(g.text)) continue;
          if (c.statuses.some(s => healUp.has(s))) continue;
          const last = [...casts].reverse().find(x => x.sourceID === h.id && aname(x.abilityGameID) === name && x.timestamp <= T + 300);
          if (!last || T - last.timestamp >= rc * 1000) healReady.push(judge(name, c, ` (${h.name})`));
        }
      }
      if (healReady.length) facts.push({ k: 'calc', text: `Healer tools ready and not used on ${v.name}: ${healReady.map(x => x.text).join('; ')}. Recast and % from the official tooltips (${OFFICIAL()}).${healReady.some(x => x.name === 'Taurochole') ? ' Taurochole also needs Addersgall, which the log doesn\'t show.' : ''}` });
      const healSavers = healReady.filter(x => x.saves);
      const healNote = healSavers.length ? ` Healer tool${healSavers.length > 1 ? 's' : ''} also ready that alone would have saved them: ${healSavers.map(x => x.name + x.who).join(', ')}.` : '';

      if (!haveTankCasts) {
        facts.push({ k: 'calc', text: 'Tank cooldown presses aren\'t in this download (clear the cached events and analyze again), so which ones were ready isn\'t known.' });
        return { facts, summary: healNote.trim() || null };
      }
      // Long cooldowns only (60s+): short gauge/charge tools (Sheltron, Bloodwhetting, TBN, Oblation…) aren't "saved".
      const ready = [], cd = [];
      for (const name of TANK_KIT[v.job] || []) {
        const rc = recastOf(name);
        if (!rc || rc < 60 || name === 'Oblation') continue;
        const info = CATALOG[name];
        if (info.statuses.some(s => up.has(s))) continue;
        const last = [...casts].reverse().find(c => c.sourceID === v.id && aname(c.abilityGameID) === name && c.timestamp <= T + 300);
        if (last && T - last.timestamp < rc * 1000) cd.push(`${name} (used ${P(last.timestamp)}, recast ${rc}s)`);
        else ready.push(judge(name, info));
      }
      if (cd.length) facts.push({ k: 'log', text: `On cooldown at the hit: ${cd.join('; ')}.` });
      if (!ready.length) return { facts, summary: (up.size ? `Up at the hit: ${[...up].join(', ')}; every bigger tank cooldown was already used.` : 'Every big tank cooldown was already used.') + healNote };

      facts.push({ k: 'calc', text: `Ready and not used: ${ready.map(x => x.text).join('; ')}. Recasts and % from the official tooltips (${OFFICIAL()}); ready means not pressed within its recast before the hit.` });
      const savers = ready.filter(x => x.saves);
      const summary = savers.length
        ? savers.length === 1
          ? `${savers[0].name} was ready and not used; by its official tooltip it alone would have kept them alive.`
          : `${savers.slice(0, -1).map(x => x.name).join(', ')} and ${savers.at(-1).name} were ready and not used; by the official tooltips any one of them alone would have kept them alive.`
        : `Ready and not used: ${ready.map(x => x.name).join(', ')}; by their official %, none alone would have saved this hit.`;
      return { facts, summary: summary + healNote };
    }

    const deathInfo = deaths.map(d => {
      const v = byId.get(d.targetID);
      const t = d.timestamp;
      const facts = [];
      const wipeOut = players.filter(p => p.id !== v.id && isDead(p.id, t - 50)).length >= 4;
      const recent = hitsOn(v.id, t - 10000, t + 300);
      // The killing hit: the last hit that took them to 0 (FFLogs' named killing ability first). If none did, the
      // last hit is kept only as a lead and the death is "Unclear".
      const kId = d.killingAbilityGameID;
      const fatals = recent.filter(e => fatalEv(e) && e.timestamp >= t - 5000);
      const killing = (kId && [...fatals].reverse().find(e => e.abilityGameID === kId)) || fatals.at(-1)
        || [...recent].reverse().find(e => (e.amount || 0) > 0 && e.timestamp >= t - 8000) || null;
      const notFatal = !!killing && !fatalEv(killing);
      const touch = [...recent, ...calcBy.get(f.id).filter(e => e.targetID === v.id && e.timestamp >= t - 15000 && e.timestamp < t - 10000)]
        .sort((a, b) => a.timestamp - b.timestamp).at(-1);
      const killName = killing ? aname(killing.abilityGameID) : (kId ? aname(kId) : null);
      const fromPlayer = killing && byId.has(killing.sourceID);
      let g = killing ? groupOf.get(killing) : null;
      if (killing && !g) {
        const same = calcBy.get(f.id).filter(e => aname(e.abilityGameID) === killName && Math.abs(e.timestamp - killing.timestamp) <= 1000);
        g = { t: killing.timestamp, name: killName, targets: new Set(same.map(e => e.targetID)), events: same };
      }
      const alive = players.filter(p => !isDead(p.id, (g?.t ?? t) - 1)).length;
      const k = phaseAt(t);
      // Part of a sheet mechanic only if that mechanic's hit (or a sibling fired with it) killed them.
      const nearRow = rowNear(g?.t ?? t);
      const row = nearRow && killName && !notFatal && (nearRow.ability === killName || nearRow.targets.some(x => x.ability === killName)) ? nearRow : null;
      const T = killing?.timestamp ?? t;
      const vulns = applied.filter(e => e.targetID === v.id && e.timestamp >= T - 30000 && e.timestamp <= T && stillOn(e, T))
        .map(e => {
          const src = sourceOfDebuff(e) || groups.find(x => x.targets.has(v.id) && Math.abs(x.t - e.timestamp) <= 1600)?.name || null;
          const design = debuffDesign(src, aname(e.abilityGameID));
          return { name: aname(e.abilityGameID), at: e.timestamp, from: src, shared: sharedVuln(e), dmgDown: /damage down/i.test(aname(e.abilityGameID)), design, designed: !!design?.designed };
        });
      // A debuff the mechanic gives by design isn't a sign of an earlier failure.
      const ownVulns = vulns.filter(x => !x.shared && !x.designed);
      // HP: from the killing hit's snapshot when there is one (HP when the game calculated it).
      const ks = killing ? snapOf(killing) || killing : null;
      const res = killing ? (killing.targetResources || killing) : null;
      const maxHp = res?.maxHitPoints || (ks?.targetResources || {}).maxHitPoints || null;
      const snapHp = ks && ks !== killing ? (ks.targetResources || ks).hitPoints : killing?.type === 'calculateddamage' ? (killing.targetResources || killing).hitPoints : null;
      const hpBefore = snapHp ?? (maxHp ? (res.hitPoints ?? 0) + (killing.type === 'damage' ? (killing.amount || 0) : 0) : null);
      const overkill = killing ? (killing.type === 'damage' ? (killing.overkill || 0) : Math.max(0, (killing.amount || 0) - (hpBefore ?? Infinity))) : 0;
      const hpPct = hpBefore != null && maxHp ? Math.max(0, Math.min(100, Math.round(100 * hpBefore / maxHp))) : null;
      const vStatuses = ks ? buffNames(ks) : new Set();
      const n = g ? g.targets.size : 0;
      const typ = killName && !fromPlayer ? typical.get(killName) ?? null : null;

      // Everything that hit them in the 1.5s up to the killing hit: two hits at once can kill from full HP even
      // when neither would alone.
      const burst = killing && !notFatal ? recent.filter(e => e.timestamp >= killing.timestamp - 1500 && e.timestamp <= killing.timestamp + 50) : [];
      const thru = e => (e.amount || 0) + (e === killing ? overkill : e.type === 'damage' ? (e.overkill || 0) : 0);
      const burstTotal = burst.reduce((a, e) => a + thru(e), 0);
      const burstNames = [...new Set(burst.map(e => aname(e.abilityGameID)))];
      const firstOfBurst = burst[0];
      const fs = firstOfBurst ? snapOf(firstOfBurst) || firstOfBurst : null;
      const hpIn = burst.length > 1 && fs ? ((fs.type === 'calculateddamage' ? (fs.targetResources || fs).hitPoints : null) ?? ((fs.targetResources || fs).hitPoints + (fs.amount || 0))) : hpBefore;
      const hpInPct = hpIn != null && maxHp ? Math.max(0, Math.min(100, Math.round(100 * hpIn / maxHp))) : null;
      const fullHpSurvives = maxHp && burst.length ? burstTotal < maxHp : null;
      const lowHp = fullHpSurvives && hpInPct != null && hpInPct < 99;

      // ---- facts (log / math) ----
      if (killing) {
        facts.push({ k: 'log', text: `${notFatal ? 'Last logged hit' : 'Killing hit'}: ${killName} at ${P(killing.timestamp)}: ${num(killing.amount)} damage${killing.absorbed ? `, ${num(killing.absorbed)} absorbed by shields` : ''}${overkill ? `, ${num(overkill)} overkill` : ''}${killing.unmitigatedAmount ? ` (${num(killing.unmitigatedAmount)} before mitigation)` : ''}${killing.type === 'calculateddamage' ? ' (only the server\'s damage calculation is logged for this hit)' : ''}.` });
        if (notFatal) facts.push({ k: 'log', text: `That hit left ${v.name} at ${num((killing.targetResources || killing).hitPoints)} HP. No hit in the log took them to 0, so what finished them isn't recorded.` });
        if (hpInPct != null) facts.push({ k: 'log', text: `HP going in: ${num(hpIn)} / ${num(maxHp)} (${hpInPct}%)${burst.length > 1 ? `, before ${burstNames.join(' + ')}` : ''}, as the game had it when it calculated the hit.` });
        if (burst.length > 1) facts.push({ k: 'log', text: `Hits in the 1.5s up to the kill: ${burst.map(e => `${aname(e.abilityGameID)} ${num(thru(e))}`).join(' + ')} = ${num(burstTotal)}.` });
        if (typ != null) facts.push({ k: 'log', text: `${killName} hit ${n} player${n === 1 ? '' : 's'} here; across ${typicalN(killName)} instances in these pulls it hit ${typ} (median).` });
        else if (fromPlayer) facts.push({ k: 'log', text: `${killName} came from ${pname(killing.sourceID)}, a player.` });
        // Others hit by the same ability at the same moment, counted once each.
        const otherIds = [...new Set((g?.events || []).map(e => e.targetID).filter(id => id !== v.id && byId.has(id)))];
        if (otherIds.length && !notFatal) {
          const firstEv = id => g.events.find(e => e.targetID === id);
          const diedToIt = id => fatalEv(firstEv(id));
          const survived = otherIds.filter(id => !diedToIt(id)).length;
          const taken = otherIds.map(id => thru(firstEv(id))).sort((a, b) => a - b);
          facts.push({ k: 'log', text: `${survived} of the ${otherIds.length} other players hit by ${killName} survived it. Damage that got through to them: ${num(taken[Math.floor(taken.length / 2)])} (median) vs ${num(thru(killing))} for ${v.name}.` });
          // Statuses most others had at the hit but the victim didn't (e.g. out of range of Kerachole).
          const counts = {};
          otherIds.forEach(id => { const e = firstEv(id); buffNames(snapOf(e) || e).forEach(s => { counts[s] = (counts[s] || 0) + 1; }); });
          const miss = Object.entries(counts).filter(([s, c]) => c >= Math.max(2, otherIds.length * 0.75) && !vStatuses.has(s) && !VULN_RE.test(s));
          if (miss.length) {
            facts.push({ k: 'log', text: `${v.name} didn't have: ${miss.map(([s, c]) => `${s} (${c}/${otherIds.length} others had it)`).join(', ')}.` });
            for (const [s] of miss) {
              const press = [...casts].reverse().find(c => c.timestamp <= killing.timestamp && killing.timestamp - c.timestamp <= 30000 && (CATALOG[aname(c.abilityGameID)]?.statuses || []).includes(s));
              if (press) facts.push(...rangeFacts(aname(press.abilityGameID), press.sourceID, press.timestamp, [v.id]).filter(x => x.k === 'log' || x.k === 'official'));
            }
          }
        }
        if (vStatuses.size) facts.push({ k: 'log', text: `On ${v.name} at the hit: ${[...vStatuses].join(', ')}.` });
        if (maxHp && burst.length) facts.push({ k: 'calc', text: `${burst.length > 1 ? 'Together that' : `${killName}`} did ${num(burstTotal)} after mits and shields; ${v.name}'s max HP is ${num(maxHp)}. ${fullHpSurvives ? `At full HP they'd have survived with ${num(maxHp - burstTotal)} HP left.` : 'Even at full HP that kills: healing couldn\'t have saved this one.'}` });
      } else if (touch) facts.push({ k: 'log', text: `No fatal hit logged. The last thing that hit them was ${aname(touch.abilityGameID)} at ${P(touch.timestamp)}, ${secs(t - touch.timestamp)} before death.` });
      else facts.push({ k: 'log', text: 'No hit logged on them in the 15s before death.' });
      vulns.forEach(x => facts.push({ k: 'log', text: `Had ${x.name} (applied ${P(x.at)}${x.from ? ` by ${x.from}` : ''}${x.shared ? ', to 4+ players at once' : ''}), still on when the fatal hit landed${x.designed ? `. ${x.from} gives it on ${Math.round(100 * x.design.rate)}% of its hits in these pulls (${x.design.hits} hits), so it's part of the mechanic, not a sign of a failure` : ''}.` }));

      // Healing in the 15s before, when HP going in matters.
      if (killing && !notFatal && hpInPct != null && hpInPct < 99) {
        const W = 15000, from = (firstOfBurst?.timestamp ?? killing.timestamp) - W, to = firstOfBurst?.timestamp ?? killing.timestamp;
        const got = (healBy.get(f.id) || []).filter(h => h[3] === v.id && h[1] >= from && h[1] < to);
        const took = dmg.filter(e => e.targetID === v.id && e.timestamp >= from && e.timestamp < to);
        const healed = got.reduce((a, h) => a + h[5], 0), over = got.reduce((a, h) => a + h[6], 0);
        const bySrc = {};
        got.forEach(h => { bySrc[h[2]] = (bySrc[h[2]] || 0) + h[5]; });
        const srcText = Object.entries(bySrc).filter(([, a]) => a > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([id, a]) => `${+id === v.id ? `${v.name} (self)` : pname(+id)} ${num(a)}`).join(', ');
        if (haveHeals) facts.push({ k: 'log', text: `In the ${W / 1000}s before: took ${num(took.reduce((a, e) => a + (e.amount || 0), 0))} damage from ${took.length} hit${took.length === 1 ? '' : 's'}; received ${num(healed)} healing${over ? ` (+${num(over)} overheal)` : ''}${srcText ? ` from ${srcText}` : ''}.` });
        const samples = [...took.map(e => [e.timestamp, (e.targetResources || e).hitPoints, (e.targetResources || e).maxHitPoints]), ...got.map(h => [h[1], h[8], h[9]])]
          .filter(s => s[1] != null && s[2]).sort((a, b) => a[0] - b[0]);
        const full = [...samples].reverse().find(s => s[1] >= s[2] * 0.99);
        if (samples.length) facts.push({ k: 'log', text: full ? `Last at full HP: ${P(full[0])}, ${secs(to - full[0])} before the hit.` : `Not at full HP at any point in those ${W / 1000}s (lowest logged: ${Math.round(100 * Math.min(...samples.map(s => s[1] / s[2])))}%).` });
        const deadHealers = players.filter(p => HEALERS.includes(p.job) && p.id !== v.id && isDead(p.id, to - 50)).map(p => p.name);
        if (deadHealers.length) facts.push({ k: 'log', text: `Healer${deadHealers.length > 1 ? 's' : ''} already dead: ${deadHealers.join(', ')}.` });
      }

      // Planned mits for this mechanic that weren't up, and whether they'd have changed the outcome by their
      // official %. Heal tools are kept apart so they're never called missing mitigation.
      const missedAll = row ? row.items.filter(i => ['missing', 'late', 'expired', 'range', 'cooldown'].includes(i.status) && i.status !== 'conflict') : [];
      const missedMits = missedAll.filter(i => i.info.kind !== 'heal');
      const missedHeals = missedAll.filter(i => i.info.kind === 'heal');
      const pcts = missedMits.map(m => mitPct(m.info.name));
      const knownFactor = pcts.reduce((a, p) => a * (1 - (p || 0)), 1);
      const unknownPct = pcts.some(p => p == null); // shields etc.: no % to compute with
      const withMits = burstTotal * knownFactor;
      const mitsWouldChange = missedMits.length && burst.length && (withMits < (lowHp ? hpIn : maxHp));

      // ---- tanks: Walking Dead, and which cooldowns were up / ready at the fatal hit ----
      const isTank = TANKS.includes(v.job);
      const tank = isTank && !wipeOut ? tankAtDeath(v, d, killing && !notFatal ? killing : null, vStatuses, { burstTotal, hpIn, maxHp, lowHp }) : null;
      // A hit above max HP after mits is a failed mechanic: tank cooldowns don't matter there (Walking Dead still does).
      const overMaxHp = killing && maxHp && overkill > maxHp;
      if (tank && (tank.walkingDead || !overMaxHp)) facts.push(...tank.facts);

      // ---- category: the likely explanation, from the facts above ----
      let category, why, confidence = 'medium', mitWhy = null;
      const sameInstant = deaths.filter(x => x !== d && Math.abs(x.timestamp - t) <= 1500 && !hasFatalHit(x)).length;
      const missText = list => list.map(m => `${m.label} (${m.player.name}, ${STATUS_TEXT[m.status]})`).join(', ');
      const mitSentence = () => {
        if (!missedMits.length) return '';
        const items = missedMits.map(m => ({ key: missKey(m, row), text: `${m.label} (${m.player.name}, ${STATUS_TEXT[m.status]})` }));
        const text = mitsWouldChange
          ? `Planned mits not up that would have changed it (by their official %): ${items.map(x => x.text).join(', ')}.`
          : `Also not up: ${items.map(x => x.text).join(', ')}${unknownPct ? '' : `; by their official % they wouldn't have changed this death (${num(withMits)} would still get through)`}.`;
        mitWhy = { fallback: '', items, text };
        return text;
      };
      const groupHit = n >= Math.max(4, Math.ceil(alive * 0.6)) || (typ != null && typ > 2 && n >= typ);
      if (wipeOut) { category = 'Wipe-out'; why = 'Died after 4+ players were already down; the pull was already lost.'; confidence = 'high'; }
      else if (tank?.walkingDead) { category = 'Walking Dead not healed'; confidence = 'high'; why = tank.walkingDead; }
      else if (notFatal) { category = 'Unclear'; confidence = 'low'; why = `No fatal hit in the log: the last logged hit (${killName}) left them alive. Check the replay.`; }
      else if (!killing && killName) { category = 'Mechanic fail'; why = `Killed by ${killName} with no damage number logged: an instant-death mechanic or debuff.`; confidence = 'high'; }
      else if (killing && maxHp && overkill > maxHp) {
        category = 'Mechanic fail'; confidence = 'high';
        why = `${killName} hit for about ${Math.round(((killing.amount || 0) + overkill) / maxHp)}× their max HP. No mitigation covers that, so the mechanic itself went wrong (wrong spot, wrong number of people, or wrong debuff).`;
      } else if (!killing && sameInstant > 0) {
        category = 'Mechanic fail'; confidence = 'high';
        why = `${sameInstant + 1} players died within 1.5s of each other with no damage logged on any of them: a failed mechanic that kills outright.`;
      } else if (!killing) {
        category = 'No damage logged'; confidence = 'low';
        why = 'No fatal hit in the log. Usually a knockback/fall off the platform or an instant-death mechanic; check the replay.';
      } else if (ownVulns.length && !ownVulns[0].dmgDown) {
        category = groupHit ? 'Raidwide' : 'Mechanic fail'; confidence = 'high';
        why = `Had ${ownVulns[0].name} from an earlier hit${ownVulns[0].from ? ` (${ownVulns[0].from})` : ''}: that earlier mechanic went wrong, and ${killName} then killed them.`;
      } else if (ownVulns.length) {
        category = 'Mechanic fail'; confidence = 'medium';
        why = `Had Damage Down from ${ownVulns[0].from || 'an earlier hit'} shortly before: a sign that mechanic was failed, then ${killName} killed them.`;
      } else if (lowHp) {
        category = 'Low HP going in'; confidence = 'high';
        why = `Would have survived at full HP (${num(burstTotal)} got through vs ${num(maxHp)} max HP), but went in at ${hpInPct}%: HP going in decided it (healing, or damage taken just before).`;
        if (missedHeals.length) why += ` Planned heal tools for ${row.mechanic} not used: ${missText(missedHeals)}.`;
        if (missedMits.length) why += ` ${mitSentence()}`;
      } else if (fullHpSurvives === false && burstNames.length > 1) {
        category = 'Several hits at once';
        const sharedNote = vulns.some(x => x.shared && !x.designed) ? ` ${vulns.find(x => x.shared && !x.designed).name} was on 4+ players from the hit just before, a sign that mechanic went wrong.` : '';
        why = `${burstNames.join(' and ')} landed within 1.5s for ${num(burstTotal)} together, more than their max HP (${num(maxHp)}): even at full HP that kills.${sharedNote}`;
      } else if (groupHit && fullHpSurvives === false && mitsWouldChange) {
        category = 'Under-mitigated';
        why = `Even at full HP this kills (${num(burstTotal)} vs ${num(maxHp)} max HP). ${mitSentence()}`;
      } else if (groupHit) {
        category = 'Raidwide';
        why = `Even at full HP this kills (${num(burstTotal)} vs ${num(maxHp)} max HP). ${missedMits.length ? mitSentence() : 'The planned mits were up; look at shields and extra damage taken.'}`;
      } else if (typ != null && n < typ && typ >= 2) { category = 'Short stack/tower'; why = `Only ${n} took ${killName}, which hit ${typ} (median) in ${typicalN(killName)} instances: a stack or tower was likely short on people.`; }
      else if (isTank && (typ == null || typ <= 2)) {
        category = 'Tank damage';
        why = `Tank died to ${killName}${fullHpSurvives === false ? ', which kills even at full HP' : ''}. ${tank?.summary || 'Check tank cooldowns and invulns.'}`;
      }
      else if (typ != null && typ <= 2) { category = 'Mechanic fail'; why = `Took ${killName}, which hit only ${typ} player${typ === 1 ? '' : 's'} (median of ${typicalN(killName)}): likely their own mechanic or standing in it.`; }
      else { category = 'Other hit'; confidence = 'low'; why = `Killed by ${killName}${fromPlayer ? ` (from ${pname(killing.sourceID)})` : ''}; not enough instances in these pulls to say how this hit normally goes.`; }

      // Positions at the moment of the killing hit (or the death, if no hit was logged).
      let snapshot = null;
      const at = killing?.timestamp ?? t;
      if (havePositions) {
        const ps = players.map(p => ({ id: p.id, name: p.name, job: p.job, victim: p.id === v.id,
          // The victim may have no event near the death (e.g. a fall): use their last logged position (age is shown).
          dead: p.id !== v.id && isDead(p.id, at - 50), pos: posAt(p.id, at, p.id === v.id ? 10000 : 2500) }));
        const enemyIds = [...new Set([killing?.sourceID, ...(g?.events || []).map(e => e.sourceID)].filter(id => id != null && !byId.has(id)))];
        const enemies = enemyIds.map(id => ({ id, pos: posAt(id, at, 2500) })).filter(e => e.pos);
        const trail = (track.get(v.id) || []).filter(s => s[0] >= at - 6000 && s[0] <= at + 200).map(s => ({ x: s[1], y: s[2] }));
        snapshot = { t: at, players: ps, enemies, trail };
        const me = ps.find(p => p.victim)?.pos;
        const aliveP = ps.filter(p => !p.victim && !p.dead && p.pos);
        if (me && aliveP.length) {
          const near = aliveP.map(p => ({ p, d: dist(me, p.pos) })).sort((a, b) => a.d - b.d);
          const cx = aliveP.reduce((a, p) => a + p.pos.x, 0) / aliveP.length, cy = aliveP.reduce((a, p) => a + p.pos.y, 0) / aliveP.length;
          facts.push({ k: 'log', text: `Position at the hit: ${near[0].d.toFixed(1)}y from the nearest other player (${near[0].p.name}), ${dist(me, { x: cx, y: cy }).toFixed(1)}y from the middle of the other ${aliveP.length} living players${me.age > 1000 ? ` (nearest logged position ${secs(me.age)} away from the hit)` : ''}.` });
          if (killing && n > 1) {
            const hitIds = new Set(g.targets);
            const together = aliveP.filter(p => hitIds.has(p.id)).map(p => `${p.name} ${dist(me, p.pos).toFixed(1)}y`);
            if (together.length) facts.push({ k: 'log', text: `Others hit by ${killName}, and how far they were from ${v.name}: ${together.join(', ')}.` });
          }
        } else if (!me) facts.push({ k: 'log', text: `No position logged for ${v.name} in the 10s before this.` });
      }

      // Planned mits / heal tools for this mechanic, listed as facts when the death was to damage the party should survive.
      if (['Raidwide', 'Low HP going in', 'Under-mitigated', 'Several hits at once'].includes(category) && row) {
        missedMits.forEach(m => facts.push({ k: 'log', text: `Planned for ${row.mechanic}: ${m.label} (${m.player.name}) — ${STATUS_TEXT[m.status]}${mitPct(m.info.name) != null ? ` (official: ${Math.round(mitPct(m.info.name) * 100)}%)` : ''}.` }));
        if (category === 'Low HP going in') missedHeals.forEach(m => facts.push({ k: 'log', text: `Planned heal tool for ${row.mechanic}: ${m.label} (${m.player.name}) — ${STATUS_TEXT[m.status]}.` }));
      }
      return {
        player: v, slot: slotOf.get(v.id) || null, t, rel: t - sheetZero(k), pullT: t - f.startTime,
        phase: k, phaseName: phaseName(k),
        mechanic: row?.mechanic || (killName ? `${killName}${nearRow ? ` (near ${nearRow.mechanic})` : ''}` : nearRow ? `No hit logged (near ${nearRow.mechanic})` : touch ? `after ${aname(touch.abilityGameID)}` : 'Unknown'),
        // For "where pulls end": the nearest sheet mechanic (by time), with its sheet time so repeats stay apart.
        nearMechanic: nearRow ? `${nearRow.mechanic} (${fmt(nearRow.sheet * 1000)})` : null,
        rowKey: row?.key || null, wipeOut, ability: killName, hitT: killing?.timestamp ?? t,
        amount: killing?.amount ?? null, absorbed: killing?.absorbed ?? null, overkill: killing ? overkill : null,
        hpPct: hpInPct ?? hpPct, hitCount: n, category, why, confidence, mitWhy, facts, snapshot,
      };
    });

    // ---------- out of range: party heals / shields / mits pressed while someone stood outside the radius ----------
    // Every press of a party-wide, self-centred action (official range "0y/Ny"): who was alive and more than N+1y
    // from the caster (positions are centre points; the game adds hitbox size, so the last 1y isn't counted).
    // Players who got the status anyway are dropped (the log beats a position estimate).
    const rangeMisses = [];
    if (havePositions) for (const c of casts) {
      const action = aname(c.abilityGameID);
      if (!RANGE_ACTIONS.has(action) || !byId.has(c.sourceID)) continue;
      const R = radiusOf(action);
      const cp = posAt(c.sourceID, c.timestamp, 1500);
      if (!R || !cp) continue;
      const info = CATALOG[action];
      const st = info?.statuses || (action === 'Helios Conjunction' ? ['Neutral Sect'] : []);
      for (const p of players) {
        if (p.id === c.sourceID || isDead(p.id, c.timestamp)) continue;
        const pp = posAt(p.id, c.timestamp, 1500);
        if (!pp) continue;
        const d = dist(cp, pp);
        if (d <= R + 1) continue;
        const got = st.length && statusEv.some(b => b.targetID === p.id && b.sourceID === c.sourceID && /^(apply|refresh)/.test(b.type) && st.includes(aname(b.abilityGameID)) && b.timestamp >= c.timestamp - 100 && b.timestamp <= c.timestamp + 2500);
        if (got) continue;
        rangeMisses.push({ player: p, action, caster: byId.get(c.sourceID), t: c.timestamp, dist: d, radius: R, kind: info?.kind || 'heal' });
      }
    }

    // ---------- failure signals: vulns / Damage Down that aren't part of the mechanic, on anyone, dead or alive ----------
    // The person who fails a mechanic often survives it (a missed tower kills others), so these say more about
    // who to look at than who died first.
    const allFail = debuffs.filter(e => /^apply/.test(e.type) && byId.has(e.targetID) && FAIL_DEBUFF.test(aname(e.abilityGameID))).map(e => {
      const from = sourceOfDebuff(e);
      const design = debuffDesign(from, aname(e.abilityGameID));
      return { e, player: byId.get(e.targetID), name: aname(e.abilityGameID), at: e.timestamp, from, shared: sharedVuln(e), designed: !!design?.designed,
        died: deaths.some(d => d.targetID === e.targetID && d.timestamp >= e.timestamp && d.timestamp - e.timestamp <= 10000) };
    });
    // The same debuff landing on 4+ players at once is one event: if most of those came from a by-design attack,
    // all of them did (one may be credited to an auto-attack that landed at the same moment).
    for (const x of allFail) if (x.shared && !x.designed) {
      const same = allFail.filter(y => y.e.abilityGameID === x.e.abilityGameID && Math.abs(y.at - x.at) <= 1000);
      if (same.filter(y => y.designed).length * 2 > same.length) x.designed = true;
    }
    const failures = allFail.filter(x => !x.designed).map(({ e, ...x }) => x);

    // ---------- wipe cause ----------
    const first = deathInfo[0] || null;
    // A chain wipe: 5+ players dead within 3s of the first death. The first to go is a victim of a party-wide failure.
    const chainDeaths = first ? deathInfo.filter(d => d.t - first.t <= 3000) : [];
    const chainWipe = chainDeaths.length >= 5 ? { n: chainDeaths.length, kills: [...new Set(chainDeaths.map(d => d.ability).filter(Boolean))] } : null;
    const signalsBefore = first ? failures.filter(x => x.at <= first.t && first.t - x.at <= 30000) : [];
    const signalText = list => {
      const by = new Map();
      for (const x of list) { const k = `${x.player.name}|${x.name}|${x.from || ''}`; by.set(k, x); }
      return [...by.values()].map(x => `${x.player.name} (${x.name}${x.from ? ` from ${x.from}` : ''} at ${P(x.at)}${x.shared ? ', with 4+ others' : ''})`).join(', ');
    };
    let cause, causeDetail;
    if (f.kill) { cause = 'Clear'; causeDetail = ''; }
    else if (!first) {
      const r = rowNear(f.endTime, 15000);
      cause = `${phaseName(lastPhaseIdx)}: ${r ? r.mechanic : 'no deaths'}`;
      causeDetail = 'No deaths recorded: wipe call, enrage, or a mechanic that ended the pull.';
    } else {
      cause = `${first.phaseName}: ${first.nearMechanic || first.mechanic}`;
      const cascade = deathInfo.filter(d => d.t - first.t <= 8000).length;
      causeDetail = chainWipe
        ? `${chainWipe.n} players died within 3s${chainWipe.kills.length ? ` (${chainWipe.kills.join(', ')})` : ''}: a party-wide failure, so who died first says little about who caused it.`
        : `${first.player.name} died first (likely ${first.category.toLowerCase()})${cascade > 1 ? `, ${cascade - 1} more within 8s` : ''}.`;
      // Personal signals only: a debuff on 4+ at once is the party failing together, and the attack that caused the
      // chain itself isn't an "earlier" signal.
      const others = signalsBefore.filter(x => !x.shared && !(chainWipe && chainWipe.kills.includes(x.from)) && (chainWipe || x.player.id !== first.player.id));
      if (others.length) causeDetail += ` Failure debuffs in the 30s before${chainWipe ? '' : ' on others'}: ${signalText(others)}.`;
      else if (chainWipe) causeDetail += ' No failure debuff on anyone in the 30s before it: check the replay for who was out of place.';
    }
    // Where the pull really ended: the last phase reached and the boss HP left (FFLogs' boss %), apart from where
    // the first death was. A pull that recovered and got close to pushing a phase is worth knowing about.
    const endedAt = { phase: lastPhaseIdx, phaseName: phaseName(lastPhaseIdx), bossPct: f.bossPercentage ?? null,
      recovered: !!first && first.phase != null && lastPhaseIdx > first.phase };
    const mitStats = {};
    rows.forEach(r => r.items.forEach(i => { mitStats[i.status] = (mitStats[i.status] || 0) + 1; }));

    return {
      id: f.id, n: idx + 1, kill: f.kill, start: f.startTime, end: f.endTime, duration: f.endTime - f.startTime, reportCode: report.code,
      fightPct: f.fightPercentage, bossPct: f.bossPercentage, progress: f.fightPercentage != null ? Math.max(0, 100 - f.fightPercentage) : null,
      phase: lastPhaseIdx, phaseName: phaseName(lastPhaseIdx), deaths: deathInfo, first, cause, causeDetail, rows, chains: chainList, mitStats,
      failures, chainWipe, endedAt, rangeMisses,
      abs: (report.startTime || 0) + f.startTime, phaseStarts: phaseStart.map(s => s == null ? null : s - f.startTime),
    };
  }

  return {
    players: players.map(p => ({ ...p, slot: slotOf.get(p.id) || null })),
    pulls, learned, rowAbility, haveStatusEvents, havePositions, phaseOffset: phaseOffset.map((o, k) => ({ phase: k, ms: o, samples: mapping?.offCounts?.[k] ?? offSamples[k].filter(v => Math.abs(v - o) <= 2500).length })),
  };
}

const num = v => v == null ? '?' : Math.round(v).toLocaleString();
export const STATUS_TEXT = {
  ok: 'up when it hit', other: 'up, but from someone else', unaffected: "running, but this attack isn't reduced by it", 'used-up': 'shield already used up by earlier damage',
  range: 'pressed in time, but not on most players hit (range, or the wrong enemy)', overwritten: "replaced by someone else's same effect", late: 'pressed after the hit', expired: 'ran out before the hit',
  cooldown: 'on cooldown (used earlier)', missing: 'not pressed', dead: 'player was dead',
  conflict: 'sheet asks for it twice within its recast',
  unexplained: "pressed in time and in range, but the log doesn't show why it wasn't on the players",
  'no-lb': "no tank Limit Break on this hit (a party call, not one player's miss)",
};
// Statuses that count as the player's mistake when it comes to the plan.
export const BAD = ['late', 'expired', 'missing', 'range'];
export const missKey = (it, r) => `${it.player.name}|${it.label}|${it.carry ? 1 : 0}|${r?.phase}|${r?.sheet}`;
// Party damage reduction (mits and enemy debuffs, not tank cooldowns): counted per player in "died vs lived".
const PARTY_REDUCERS = new Set(Object.values(CATALOG).filter(c => (c.kind === 'mit' || c.kind === 'debuff') && !c.tank && !c.single).flatMap(c => c.statuses));
// Party mits, enemy debuffs and party shields: what a player standing in the right place should have on them.
const PARTY_COVER = new Set(Object.values(CATALOG).filter(c => (c.kind === 'mit' || c.kind === 'debuff' || c.kind === 'shield') && !c.tank && !c.single).flatMap(c => c.statuses));

/** Combine pulls from one or more reports (players matched by name) and build the summaries. */
export function aggregate(parts, { renumber = true } = {}) {
  const pulls = parts.flatMap(x => x.pulls).sort((a, b) => a.abs - b.abs);
  // A phase view passes renumber:false so pull numbers stay the same as in the full list.
  if (renumber) pulls.forEach((p, i) => { p.n = i + 1; });
  const players = [];
  for (const x of parts) for (const p of x.players) if (!players.some(q => q.name === p.name)) players.push(p);
  // countCause:false = the pull is in this view but its wipe started in another phase.
  const wipes = pulls.filter(p => !p.kill && p.countCause !== false);

  // Where pulls end.
  const causes = new Map();
  for (const p of wipes) {
    const c = causes.get(p.cause) || { cause: p.cause, phase: p.first?.phase ?? p.phase, count: 0, pulls: [], players: {}, cats: {} };
    c.count++; c.pulls.push(p.n);
    if (p.first) {
      // In a chain wipe the first to go is a victim, so no name is counted for it.
      if (!p.chainWipe) c.players[p.first.player.name] = (c.players[p.first.player.name] || 0) + 1;
      const cat = p.chainWipe ? 'Party-wide (chain wipe)' : p.first.category;
      c.cats[cat] = (c.cats[cat] || 0) + 1;
    }
    causes.set(p.cause, c);
  }

  // Per player and per mit assignment.
  const perPlayer = new Map(players.map(p => [p.name, { player: p, slot: p.slot, deaths: 0, firsts: 0, chainFirsts: 0, wipeOuts: 0, cats: {}, mit: {}, chainsHeld: 0, chainsTotal: 0, fails: 0, failsSurvived: 0, failsBy: {}, outOfRange: 0, outOfRangeBy: {} }]));
  const misses = new Map();
  for (const p of pulls) {
    p.deaths.forEach((d, i) => {
      const s = perPlayer.get(d.player.name);
      if (!s) return;
      if (d === p.first) { if (p.chainWipe) s.chainFirsts++; else s.firsts++; }
      if (d.wipeOut) { s.wipeOuts++; return; }
      s.deaths++;
      s.cats[d.category] = (s.cats[d.category] || 0) + 1;
    });
    for (const r of p.rows) for (const it of r.items) {
      // The tank LB belongs to the party, so it's left out of per-player numbers and the miss list.
      if (it.shared) continue;
      const s = perPlayer.get(it.player.name);
      s.mit[it.status] = (s.mit[it.status] || 0) + 1;
      if (['dead', 'unaffected', 'conflict'].includes(it.status) || (it.carry && it.status === 'missing')) continue;
      const key = missKey(it, r);
      const lbl = it.carry ? `${it.label} (carried over)` : it.label;
      const m = misses.get(key) || { key, refKey: `${r.key}|${it.slot}|${(it.sheetText || it.label).replace(/\s+/g, ' ').trim()}|${it.carry ? 1 : 0}`, player: it.player, slot: it.slot, label: lbl, phaseName: r.phaseName, mechanic: `${r.mechanic} (${sheetClock(r.sheet, r.total, r.clock)})`, counts: {}, deltas: [], usedFor: {}, pulls: [] };
      m.counts[it.status] = (m.counts[it.status] || 0) + 1;
      if (it.delta != null) m.deltas.push(it.delta);
      if (it.usedFor) m.usedFor[it.usedFor] = (m.usedFor[it.usedFor] || 0) + 1;
      if (BAD.includes(it.status)) m.pulls.push(p.n);
      misses.set(key, m);
    }
    for (const c of p.chains) {
      const s = perPlayer.get(c.player.name);
      if (!c.links.every(l => l.item.status !== 'dead')) continue;
      s.chainsTotal++; if (c.held) s.chainsHeld++;
    }
    // Failure debuffs (not part of the mechanic, not given to 4+ at once), including on players who lived:
    // a mistake that didn't kill still costs damage (Damage Down) or the next hit (vuln).
    for (const x of p.failures || []) {
      if (x.shared) continue;
      const s = perPlayer.get(x.player.name);
      if (!s) continue;
      s.fails++;
      if (!x.died) s.failsSurvived++;
      const k = `${x.name}${x.from ? ` (${x.from})` : ''}`;
      s.failsBy[k] = (s.failsBy[k] || 0) + 1;
    }
    // Outside the radius of a party heal / shield / mit when it was pressed (and didn't get it).
    for (const x of p.rangeMisses || []) {
      const s = perPlayer.get(x.player.name);
      if (!s) continue;
      s.outOfRange++;
      s.outOfRangeBy[x.action] = (s.outOfRangeBy[x.action] || 0) + 1;
    }
  }
  const missList = [...misses.values()].map(m => {
    const bad = BAD.reduce((a, s) => a + (m.counts[s] || 0), 0);
    const ok = (m.counts.ok || 0) + (m.counts.other || 0) + (m.counts['used-up'] || 0);
    const [where, n] = Object.entries(m.usedFor).sort((a, b) => b[1] - a[1])[0] || [];
    return { ...m, bad, ok, total: bad + ok + (m.counts.cooldown || 0), usedForTop: where ? { where, n } : null,
      // (Almost) never on time, but consistently pressed for another mechanic = the static plans it differently.
      differentPlan: ok <= (ok + bad) * 0.1 && !!where && n >= Math.max(2, bad * 0.6) };
  }).filter(m => m.bad > 0);
  const planKeys = new Set(missList.filter(m => m.differentPlan).map(m => m.key));
  for (const p of pulls) for (const d of p.deaths) {
    if (!d.mitWhy) continue;
    const left = d.mitWhy.items.filter(x => !planKeys.has(x.key));
    const moved = d.mitWhy.items.length - left.length;
    if (!moved) continue;
    d.why = d.why.replace(d.mitWhy.text, (left.length ? `Missing planned mits: ${left.map(x => x.text).join(', ')}.` : d.mitWhy.fallback)
      + ` (Not counting ${moved} sheet mit${moved > 1 ? 's' : ''} your static always uses elsewhere.)`);
  }

  // Carry-over chains across pulls.
  const chainAgg = new Map();
  for (const p of pulls) for (const c of p.chains) {
    const origin = c.links[0].row;
    const key = `${c.player.name}|${c.phase}|${c.originRi}|${c.names[0]}`;
    const a = chainAgg.get(key) || { key, player: c.player, slot: c.slot, label: c.label, info: c.info, phase: c.phase, phaseName: origin.phaseName,
      linkNames: [], linkOk: [], linkSeen: [], full: 0, held: 0, offsets: [], windows: [], impossible: 0, pulls: [], broke: {} };
    c.links.forEach((l, i) => {
      a.linkNames[i] ||= `${l.row.mechanic} (${sheetClock(l.row.sheet, l.row.total, l.row.clock)})`;
      (a.linkKeys ||= [])[i] ||= l.row.key;
      a.linkSeen[i] = (a.linkSeen[i] || 0) + (l.item.status === 'dead' ? 0 : 1);
      a.linkOk[i] = (a.linkOk[i] || 0) + (['ok', 'other', 'unaffected'].includes(l.item.status) || (l.item.status === 'used-up' && i === c.links.length - 1) ? 1 : 0);
    });
    if (c.complete && c.links.every(l => l.item.status !== 'dead')) {
      a.full++; if (c.held) a.held++; else a.pulls.push(p.n);
      if (c.brokeAt) { const k = `${c.brokeAt.row.mechanic}: ${STATUS_TEXT[c.brokeAt.item.status]}`; a.broke[k] = (a.broke[k] || 0) + 1; }
      // Only presses that could plausibly be meant for this chain (within duration + 30s of the first hit).
      if (c.press != null && c.firstT - c.press <= ((c.info.sec ?? 20) + 30) * 1000) a.offsets.push((c.press - c.firstT) / 1000);
      if (c.windowRel) a.windows.push(c.windowRel.from);
      if (c.impossible) a.impossible++;
    }
    chainAgg.set(key, a);
  }
  const chains = [...chainAgg.values()].filter(a => a.linkNames.length > 1).map(a => {
    const med = arr => arr.length ? [...arr].sort((x, y) => x - y)[Math.floor(arr.length / 2)] : null;
    return { ...a, medOffset: med(a.offsets), medWindowFrom: med(a.windows) };
  }).sort((a, b) => (a.full ? a.held / a.full : 1) - (b.full ? b.held / b.full : 1) || b.full - a.full);

  // Per sheet mechanic: how often reached, survived, mitigated.
  const mech = new Map();
  for (const p of pulls) for (const r of p.rows) {
    const m = mech.get(r.key) || { key: r.key, phase: r.phase, phaseName: r.phaseName, mechanic: r.mechanic, sheet: r.sheet, total: r.total, clock: r.clock, reached: 0, ended: 0, deaths: 0, firsts: 0, items: {}, taken: [], unmit: [], abilities: {}, how: {} };
    m.reached++;
    m.abilities[r.ability || '—'] = (m.abilities[r.ability || '—'] || 0) + 1;
    m.how[r.how] = (m.how[r.how] || 0) + 1;
    if (r.ability && r.damageType) (m.types ||= {})[r.ability] = r.damageType;
    if (r.ability && r.ignoresMit) (m.ignores ||= {})[r.ability] = r.ignoresMit;
    r.items.forEach(i => { m.items[i.status] = (m.items[i.status] || 0) + 1; });
    r.targets.forEach(x => { m.taken.push(x.taken); if (x.unmit) m.unmit.push(x.unmit); });
    // Died vs lived on this hit: what was different for the players this hit killed (deaths before the wipe-out
    // only) and the ones it didn't. All as a share of each player's max HP, from the hit and its snapshot.
    for (const x of r.targets) {
      const res = x.e.targetResources || x.e, snapRes = (x.snap || x.e).targetResources || x.snap || x.e;
      const max = res.maxHitPoints;
      if (!max) continue;
      const died = p.deaths.some(d => d.player.id === x.pid && !d.wipeOut && d.rowKey === r.key);
      const wiped = p.deaths.some(d => d.player.id === x.pid && d.wipeOut && d.rowKey === r.key);
      if (wiped) continue; // the pull was already lost: says nothing about the hit
      const hpIn = x.snap && snapRes.hitPoints != null ? snapRes.hitPoints : (res.hitPoints ?? 0) + (x.e.amount || 0);
      const g = (m.dl ||= { died: [], lived: [], deaths: [] })[died ? 'died' : 'lived'];
      const entry = { hpIn: Math.min(1, hpIn / max), shield: (x.e.absorbed || 0) / max, through: ((x.e.amount || 0) + (x.e.overkill || 0)) / max,
        raw: x.unmit ? x.unmit / max : null, mits: [...x.statuses].filter(s => PARTY_REDUCERS.has(s)).length };
      g.push(entry);
      if (died) {
        // Each death on this hit: what was on them, and what most of the others hit in the same pull had that they
        // didn't (party mits, enemy debuffs and party shields), e.g. out of Kerachole range or missed by E.Prog.
        const others = r.targets.filter(y => y.pid !== x.pid && !p.deaths.some(d => d.player.id === y.pid && d.rowKey === r.key));
        const count = {};
        others.forEach(y => y.statuses.forEach(s => { if (PARTY_COVER.has(s)) count[s] = (count[s] || 0) + 1; }));
        const lacked = Object.entries(count).filter(([s, c]) => c >= Math.max(2, Math.ceil(others.length / 2)) && !x.statuses.has(s)).map(([s, c]) => ({ status: s, had: c, of: others.length }));
        const d = p.deaths.find(y => y.player.id === x.pid && y.rowKey === r.key);
        m.dl.deaths.push({ ...entry, pull: p.n, pullId: p.id, reportCode: p.reportCode, t: x.e.timestamp, player: d.player, category: d.category,
          ability: x.ability, on: [...x.statuses].filter(s => PARTY_COVER.has(s)), lacked, alive: others.length });
      }
    }
    mech.set(r.key, m);
  }
  for (const p of pulls) {
    p.deaths.filter(d => !d.wipeOut && d.rowKey).forEach(d => { const m = mech.get(d.rowKey); if (m) m.deaths++; });
    if (p.first?.rowKey && mech.get(p.first.rowKey)) { mech.get(p.first.rowKey).firsts++; }
  }
  const mechanics = [...mech.values()].sort((a, b) => a.phase - b.phase || a.sheet - b.sheet).map(m => {
    const med = arr => arr.length ? [...arr].sort((x, y) => x - y)[Math.floor(arr.length / 2)] : null;
    // Died vs lived: medians per group, and the clearest difference between them, in this order: far more raw damage
    // (an extra hit or wrong spot: a mechanic problem), less shield, fewer mits, lower HP going in.
    if (m.dl && m.dl.died.length >= 2 && m.dl.lived.length >= 3) {
      const sum = list => ({ n: list.length, hpIn: med(list.map(x => x.hpIn)), shield: med(list.map(x => x.shield)), through: med(list.map(x => x.through)),
        raw: med(list.map(x => x.raw).filter(v => v != null)), mits: med(list.map(x => x.mits)) });
      const D = sum(m.dl.died), L = sum(m.dl.lived);
      const reasons = [];
      if (D.raw != null && L.raw != null && D.raw > L.raw * 1.5) reasons.push(`they took ${(D.raw / L.raw).toFixed(1)}× the raw damage (extra hits or the wrong spot: a mechanic problem, not mitigation)`);
      if (D.shield < L.shield - 0.05) reasons.push(`they had less shield (${Math.round(100 * D.shield)}% vs ${Math.round(100 * L.shield)}% of max HP)`);
      // Mits are whole counts, so one fewer is noise: at least 2 fewer.
      if (D.mits <= L.mits - 2) reasons.push(`they had fewer mits on them (${D.mits} vs ${L.mits})`);
      if (D.hpIn < L.hpIn - 0.1) reasons.push(`they went in with less HP (${Math.round(100 * D.hpIn)}% vs ${Math.round(100 * L.hpIn)}%)`);
      // Every death on this hit, each with its own read-out against the survivors' medians.
      const deaths = m.dl.deaths.sort((a, b) => a.pull - b.pull).map(d => {
        const why = [];
        if (d.raw != null && L.raw != null && d.raw > L.raw * 1.5) why.push(`took ${(d.raw / L.raw).toFixed(1)}× the survivors' raw damage`);
        if (d.lacked.length) why.push(`didn't have ${d.lacked.map(x => `${x.status} (${x.had}/${x.of} others did)`).join(', ')}`);
        else if (d.shield < L.shield - 0.05) why.push(`less shield (${Math.round(100 * d.shield)}% vs ${Math.round(100 * L.shield)}%)`);
        if (d.hpIn < L.hpIn - 0.1) why.push(`went in at ${Math.round(100 * d.hpIn)}% HP`);
        return { ...d, why };
      });
      m.diedVsLived = { died: D, lived: L, reasons, deaths };
    }
    delete m.dl;
    return { ...m, medTaken: med(m.taken), medUnmit: med(m.unmit) };
  });

  return {
    players, pulls,
    causes: [...causes.values()].sort((a, b) => b.count - a.count),
    perPlayer: [...perPlayer.values()],
    misses: missList.sort((a, b) => (a.differentPlan - b.differentPlan) || (b.bad - a.bad)),
    chains, mechanics,
    learned: parts[0]?.learned || {}, rowAbility: parts[0]?.rowAbility || {}, phaseOffset: parts[0]?.phaseOffset || [], haveStatusEvents: parts.every(x => x.haveStatusEvents), havePositions: parts.some(x => x.havePositions),
  };
}
