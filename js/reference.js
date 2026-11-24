// Reference clears: what successful kills actually did at each mechanic, compared with the Ikuya sheet and with
// your pulls.
//
// Two separate questions, kept apart on purpose:
//  1. Plan-independent: at each mechanic, which mit statuses were on the players when the hit landed, how much
//     of the raw damage the mits and shields removed, and what HP people had going in. This is true whatever
//     mit plan a group uses (Ikuya, LPDU or their own), so it's the fair "good reference".
//  2. Plan agreement: how closely each clear followed the Ikuya sheet. Where several clears consistently do
//     something else at a mechanic, that's a different plan (not a mistake), and it's shown as such.
import { CATALOG } from './mits.js';
import { median, fmt, sheetClock } from './analyze.js';

const MIT_STATUSES = new Set(Object.values(CATALOG).filter(c => c.kind !== 'heal' && !c.tank).flatMap(c => c.statuses));
const MATCH = ['ok', 'other', 'used-up'];
const IGNORE = ['dead', 'unaffected'];
const genericLabel = it => (it.sheetText || it.label).replace(/\s+/g, ' ').trim();

/**
 * How closely one pull followed a plan: of the plan's checkable entries for that comp's jobs, the share whose
 * status was on the players when the hit landed (read from the log). Also per phase.
 */
export function agreementOf(pull) {
  const items = pull.rows.flatMap(r => r.items.map(it => ({ r, it }))).filter(x => !IGNORE.includes(x.it.status) && !(x.it.carry && x.it.status === 'missing'));
  const byPhase = {};
  items.forEach(({ r, it }) => { const b = byPhase[r.phase] ||= { ok: 0, n: 0 }; b.n++; if (MATCH.includes(it.status)) b.ok++; });
  const ok = items.filter(x => MATCH.includes(x.it.status)).length;
  // Party-wide mits only (no single-target tank tools, no heal tools): the part every plan has, so scores
  // from sheets with different amounts of detail can be compared fairly.
  const party = items.filter(x => !x.it.info.single && x.it.info.kind !== 'heal');
  const partyOk = party.filter(x => MATCH.includes(x.it.status)).length;
  return { agreement: items.length ? ok / items.length : null, checked: items.length, byPhase,
    party: party.length ? partyOk / party.length : null, partyChecked: party.length };
}

/** Per-hit numbers for one sheet mechanic in one pull. */
function hitStats(r) {
  const ts = r.targets.filter(x => x.unmit);
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  // amount = HP lost (excludes overkill), so overkill is added back: otherwise a hit that killed looks more mitigated.
  const unmit = sum(ts, x => x.unmit), absorbed = sum(ts, x => x.e.absorbed || 0), amount = sum(ts, x => (x.e.amount || 0) + (x.e.overkill || 0));
  const hpBefore = r.targets.map(x => {
    const res = x.e.targetResources || x.e;
    return res.maxHitPoints ? Math.min(1, ((res.hitPoints ?? 0) + (x.e.type === 'damage' ? (x.e.amount || 0) : 0)) / res.maxHitPoints) : null;
  }).filter(v => v != null);
  // Statuses on at least half of the players hit = what the party had up for this hit.
  const counts = {};
  r.targets.forEach(x => x.statuses.forEach(s => { if (MIT_STATUSES.has(s)) counts[s] = (counts[s] || 0) + 1; }));
  const up = new Set(Object.entries(counts).filter(([, c]) => c >= Math.ceil(r.targets.length / 2)).map(([s]) => s));
  return {
    n: r.targets.length,
    mitigated: unmit ? 1 - (amount + absorbed) / unmit : null, // removed by damage reduction (mits, Reprisal etc.)
    shielded: unmit ? absorbed / unmit : null,                 // soaked by shields
    through: unmit ? amount / unmit : null,                    // what got through to HP (incl. overkill)
    prevented: unmit ? 1 - amount / unmit : null,              // kept off by mits and shields together
    sums: { unmit, absorbed, amount },                          // raw totals, for pooled shares that add up
    takenMed: median(r.targets.map(x => x.taken)),
    hpBefore: median(hpBefore),
    up, mitCount: median(r.targets.map(x => [...x.statuses].filter(s => MIT_STATUSES.has(s)).length)),
  };
}

/**
 * refs: [{ label, url, jobs, pull (one analyzed pull), report }]
 * ours: aggregate() result for your pulls.
 */
export function buildReference(refs, ours, plan) {
  // ---------- 1. plan agreement per clear ----------
  const clears = refs.map(ref => {
    const items = ref.pull.rows.flatMap(r => r.items.map(it => ({ r, it }))).filter(x => !IGNORE.includes(x.it.status) && !(x.it.carry && x.it.status === 'missing'));
    const byPhase = {};
    items.forEach(({ r, it }) => { const b = byPhase[r.phase] ||= { ok: 0, n: 0 }; b.n++; if (MATCH.includes(it.status)) b.ok++; });
    const ok = items.filter(x => MATCH.includes(x.it.status)).length;
    const deaths = ref.pull.deaths.length;
    const phases = (ref.fight.phaseTransitions || []).map(t => ({ id: t.id, at: t.startTime - ref.fight.startTime }));
    return { ...ref, agreement: items.length ? ok / items.length : null, checked: items.length, byPhase, deaths, phases,
      duration: ref.fight.endTime - ref.fight.startTime, kill: ref.fight.kill };
  });

  // ---------- 2. where clears depart from the sheet (per sheet cell) ----------
  const cells = new Map();
  for (const c of clears) for (const r of c.pull.rows) for (const it of r.items) {
    if (IGNORE.includes(it.status) || (it.carry && it.status === 'missing')) continue;
    const key = `${r.key}|${it.slot}|${genericLabel(it)}|${it.carry ? 1 : 0}`;
    const x = cells.get(key) || { key, rowKey: r.key, phase: r.phase, phaseName: r.phaseName, mechanic: r.mechanic, sheet: r.sheet, total: r.total, clock: r.clock, slot: it.slot, label: genericLabel(it), carry: it.carry, n: 0, ok: 0, how: {}, usedFor: {}, actions: {}, clears: [] };
    x.n++;
    if (MATCH.includes(it.status)) x.ok++;
    else { x.how[it.status] = (x.how[it.status] || 0) + 1; x.clears.push(c.label); if (it.usedFor) x.usedFor[it.usedFor] = (x.usedFor[it.usedFor] || 0) + 1; }
    x.actions[it.info.name] = (x.actions[it.info.name] || 0) + 1;
    cells.set(key, x);
  }
  // At least 4 clears with that job before calling it "most clears" or "split" (2–3 is too few to judge).
  const cellList = [...cells.values()].filter(x => x.n >= 4).map(x => ({ ...x, rate: x.ok / x.n }));
  // Most clears (≥ 2/3) don't do what the sheet says here: the field plays it differently.
  const consensus = cellList.filter(x => x.rate <= 1 / 3).sort((a, b) => a.phase - b.phase || a.sheet - b.sheet);
  // Clears split: some follow the sheet, some don't = different plans in use (e.g. LPDU vs Ikuya).
  const split = cellList.filter(x => x.rate > 1 / 3 && x.rate < 2 / 3).sort((a, b) => a.phase - b.phase || a.sheet - b.sheet);

  // ---------- 3. plan-independent mechanic profile: clears vs you ----------
  const prof = new Map();
  const addRow = (who, r, deathsHere) => {
    const p = prof.get(r.key) || { key: r.key, phase: r.phase, phaseName: r.phaseName, mechanic: r.mechanic, sheet: r.sheet, total: r.total, clock: r.clock, ref: [], ours: [], refDeaths: 0, ourDeaths: 0 };
    p[who].push(hitStats(r));
    if (who === 'ref') p.refDeaths += deathsHere; else p.ourDeaths += deathsHere;
    prof.set(r.key, p);
  };
  for (const c of clears) for (const r of c.pull.rows) if (r.targets.length) addRow('ref', r, c.pull.deaths.filter(d => d.rowKey === r.key && !d.wipeOut).length);
  for (const p of ours.pulls) for (const r of p.rows) if (r.targets.length) addRow('ours', r, p.deaths.filter(d => d.rowKey === r.key && !d.wipeOut).length);
  const pooled = list => {
    const u = list.reduce((a, h) => a + (h.sums?.unmit || 0), 0);
    if (!u) return { mitigated: null, shielded: null, through: null, prevented: null };
    const ab = list.reduce((a, h) => a + (h.sums?.absorbed || 0), 0), am = list.reduce((a, h) => a + (h.sums?.amount || 0), 0);
    return { mitigated: 1 - (am + ab) / u, shielded: ab / u, through: am / u, prevented: 1 - am / u };
  };
  const summarize = list => {
    if (!list.length) return null;
    const freq = {};
    list.forEach(h => h.up.forEach(s => { freq[s] = (freq[s] || 0) + 1; }));
    return {
      n: list.length,
      // Pooled over every hit (total kept off / total raw damage), not three separate medians: separate medians come
      // from different pulls and needn't add up (one showed 113%). Pooled, mitigated + shielded = prevented and
      // prevented + through = 100%.
      ...pooled(list),
      takenMed: median(list.map(h => h.takenMed).filter(v => v != null)),
      hpBefore: median(list.map(h => h.hpBefore).filter(v => v != null)),
      mitCount: median(list.map(h => h.mitCount).filter(v => v != null)),
      freq: Object.fromEntries(Object.entries(freq).map(([s, c]) => [s, c / list.length])),
    };
  };
  const mechanics = [...prof.values()].sort((a, b) => a.phase - b.phase || a.sheet - b.sheet).map(p => {
    const ref = summarize(p.ref), you = summarize(p.ours);
    // Mits most clears had up for this hit that you usually didn't (job-dependent ones are noted in the UI).
    const missing = ref && you ? Object.entries(ref.freq).filter(([s, f]) => f >= 0.75 && (you.freq[s] || 0) < 0.5).map(([s, f]) => ({ status: s, ref: f, you: you.freq[s] || 0 })) : [];
    return { ...p, ref, you, missing };
  });

  // ---------- 4. carry-overs: clears vs you ----------
  const generic = label => label.startsWith('Party Mit') ? 'Party Mit' : label;
  const chainKey = c => `${c.phase}|${c.originRi}|${c.slot}|${generic(c.label)}`;
  const chains = new Map();
  const addChain = (who, c) => {
    const k = chainKey(c);
    const x = chains.get(k) || { key: k, phase: c.phase, slot: c.slot, label: c.label.startsWith('Party Mit') ? 'Party Mit' : c.label, links: c.links.map(l => `${l.row.mechanic} (${sheetClock(l.row.sheet, l.row.total, l.row.clock)})`), ref: { n: 0, held: 0, offsets: [] }, ours: { n: 0, held: 0, offsets: [] } };
    if (!c.complete || c.links.some(l => l.item.status === 'dead')) { chains.set(k, x); return; }
    const s = x[who]; s.n++; if (c.held) s.held++;
    if (c.press != null && c.firstT - c.press <= ((c.info.sec ?? 20) + 30) * 1000) s.offsets.push((c.press - c.firstT) / 1000);
    chains.set(k, x);
  };
  clears.forEach(c => c.pull.chains.forEach(ch => addChain('ref', ch)));
  ours.pulls.forEach(p => p.chains.forEach(ch => addChain('ours', ch)));
  const chainList = [...chains.values()].filter(x => x.ref.n || x.ours.n).map(x => ({ ...x, refOffset: median(x.ref.offsets), ourOffset: median(x.ours.offsets) }));

  // ---------- 5. phase timing ----------
  const phaseTimes = plan.phases.map((ph, k) => {
    const id = k + 1;
    const refAt = clears.map(c => c.phases.find(p => p.id === id)?.at).filter(v => v != null);
    const ourAt = ours.pulls.map(p => p.phaseStarts?.[k]).filter(v => v != null);
    return { phase: k, name: ph.name, refMin: refAt.length ? Math.min(...refAt) : null, refMax: refAt.length ? Math.max(...refAt) : null, refN: refAt.length,
      ourMed: median(ourAt), ourN: ourAt.length };
  });

  // Every sheet cell, so your own misses can be compared with what the clears did there.
  const cellMap = Object.fromEntries([...cells.values()].map(x => [x.key, { ok: x.ok, n: x.n }]));
  return { clears, consensus, split, mechanics, chains: chainList, phaseTimes, cellMap };
}
