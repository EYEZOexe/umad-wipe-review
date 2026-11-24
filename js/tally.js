// Death ledger: every death from every analyzed report, kept in this browser across nights, so deaths can be
// tallied per player by raid week and by month. Each death can carry a raid callout ("Forsaken - stack not there"),
// who it's blamed on, and whether it was a mechanical death (someone's own mistake) or not.

/** Deaths the analysis calls a personal mechanic mistake are marked mechanical until someone says otherwise. */
const AUTO_MECH = new Set(['Mechanic fail', 'Short stack/tower']);

export const deathKey = (reportCode, fightId, name, t) => `${reportCode}:${fightId}:${name}:${Math.round(t)}`;

/**
 * Add the deaths of analyzed pulls to the ledger. Existing entries keep their callout, blame and
 * mechanical flag; only the log facts (pull number, mechanic, category) are refreshed.
 */
export function mergeDeaths(ledger, pulls) {
  const out = { ...ledger };
  for (const p of pulls) {
    for (const d of p.deaths) {
      const key = deathKey(p.reportCode, p.id, d.player.name, d.t);
      const prev = out[key];
      const base = {
        // No pull number: it depends on which reports are loaded together. The page looks it up from report + fight.
        key, report: p.reportCode, fight: p.id, abs: Math.round(p.abs - p.start + d.t), pullT: Math.round(d.pullT),
        player: d.player.name, job: d.player.job, phase: d.phase, phaseName: d.phaseName, mechanic: d.mechanic,
        ability: d.ability || null, nearMechanic: d.nearMechanic || null, category: d.category, wipeOut: !!d.wipeOut,
      };
      // Only touch an existing entry when a log fact really changed, so re-analyzing doesn't re-send it.
      out[key] = prev
        ? (Object.keys(base).every(k => prev[k] === base[k]) ? prev : { ...prev, ...base })
        : { ...base, note: '', blame: d.player.name, mech: !d.wipeOut && AUTO_MECH.has(d.category), src: 'auto' };
    }
  }
  return out;
}

// ---------- matching raid callouts to logged deaths ----------

const lev = (a, b) => {
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
};

/** The roster player a word refers to: a first or last name, a 4+ letter prefix of one ("Reimui" → Reimu), or one typo. */
export function nameMatcher(names) {
  const parts = names.map(n => ({ n, words: n.toLowerCase().split(/\s+/) }));
  return word => {
    const w = word.toLowerCase().replace(/[^a-z'\-]/g, '');
    if (w.length < 3) return null;
    const hit = test => { const xs = parts.filter(p => p.words.some(test)); return xs.length === 1 ? xs[0].n : null; };
    return hit(x => x === w)
      || (w.length >= 4 ? hit(x => x.length >= 4 && (x.startsWith(w) || w.startsWith(x))) : null)
      || (w.length >= 5 ? hit(x => x.length >= 5 && lev(x, w) <= 1) : null);
  };
}

const STOP = new Set(['died', 'dies', 'with', 'from', 'when', 'that', 'into', 'too', 'and', 'the', 'for', 'got', 'had', 'not', 'there', 'didn', 'back', 'went', 'late', 'wrong', 'side', 'stood', 'close', 'first', 'mechanic', 'confused', 'position', 'arena', 'map']);

/**
 * One callout line → who died (the names it starts with), who it's blamed on ("… due to Ryujin …"), and words to
 * look for in the logged mechanic. Lines that start with no player name are party notes ("Arrows too far apart").
 */
export function parseCallout(line, isName) {
  const text = line.trim();
  const words = text.split(/[\s,]+/).filter(Boolean);
  const victims = [];
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i];
    if (['+', '&', 'and', '/', '-'].includes(w.toLowerCase())) { if (victims.length) continue; else break; }
    const n = isName(w);
    if (!n) break;
    if (!victims.includes(n)) victims.push(n);
  }
  const rest = words.slice(i).join(' ');
  const due = rest.match(/\b(?:due to|because of|caused by|fault of)\s+([A-Za-z'\-]+)/i);
  const blame = due ? isName(due[1]) : null;
  const keywords = rest.toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 4 && !STOP.has(w) && !isName(w));
  return { text, victims, blame, keywords };
}

/**
 * Your static's names for mechanics, one per line: "statue, gaze = Flagrant Fire III, Mystery Magic". Left of "=" are
 * words used in callouts, right of "=" are words in the logged ability, sheet mechanic or phase name.
 * Returns [[nickname, [targets]]], all lower case.
 */
export function parseNicknames(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^([^=#]+)=(.+)$/);
    if (!m) continue;
    const targets = m[2].split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    m[1].split(',').map(s => s.trim().toLowerCase()).filter(Boolean).forEach(n => out.push([n, targets]));
  }
  return out;
}

/** Words to look for in a death's mechanic: the callout's own words plus what its nicknames stand for. */
const termsFor = (c, nicknames) => {
  const lower = ` ${c.text.toLowerCase().replace(/[^a-z']+/g, ' ')} `;
  const extra = nicknames.filter(([n]) => lower.includes(` ${n} `)).flatMap(([, t]) => t);
  return [...new Set([...c.keywords, ...extra])];
};

const hayOf = d => `${d.mechanic} ${d.ability || ''} ${d.nearMechanic || ''} ${d.phaseName || ''}`.toLowerCase();
const score = (d, terms) => {
  const hay = hayOf(d);
  return terms.filter(k => hay.includes(k) || (k.length >= 5 && hay.includes(k.slice(0, -1)))).length;
};

/** "8th tower" → the sheet's "Towers VIII": a numbered tower in a callout pins the exact set of towers. */
const ROMAN = ['', 'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'];
const towerNumber = text => { const m = text.toLowerCase().match(/\b(\d{1,2})(?:st|nd|rd|th)\s+towers?\b/); return m && ROMAN[+m[1]] ? new RegExp(`towers ${ROMAN[+m[1]]}(?![a-z])`) : null; };

/** "Deaths:" and similar heading lines aren't callouts. */
const isHeading = line => /:\s*$/.test(line) && line.split(/\s+/).length <= 3;

/**
 * Match callout lines, in the order they were written (the order of the night), to logged deaths.
 * Each callout takes that player's first unclaimed death in the same pull as the previous callout or later whose
 * mechanic fits the callout (its words, or what its nicknames stand for). With no fitting death it takes their
 * first unclaimed death from that point ("order only"). If nothing is left after that point, the earliest
 * unclaimed death of that player anywhere is used. Returns one row per line.
 */
export function matchCallouts(text, deaths, names, nicknames = []) {
  const isName = nameMatcher(names);
  const list = [...deaths].sort((a, b) => a.abs - b.abs);
  const pullOrder = [...new Set(list.map(d => `${d.report}:${d.fight}`))];
  const order = d => pullOrder.indexOf(`${d.report}:${d.fight}`);
  const taken = new Set();
  let at = 0;
  const rows = [];
  for (const line of text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
    if (isHeading(line)) continue;
    const c = parseCallout(line, isName);
    const terms = termsFor(c, nicknames);
    const tower = towerNumber(c.text);
    const matched = [];
    for (const v of c.victims) {
      const mine = list.filter(d => d.player === v && !taken.has(d.key));
      const ahead = mine.filter(d => order(d) >= at);
      const pool = ahead.length ? ahead : mine;
      // "Calerie + Arune died to statue": the second name goes to the same pull as the first when they died there.
      const first = matched.find(x => x.death)?.death;
      const samePull = first ? pool.filter(d => d.report === first.report && d.fight === first.fight) : [];
      const fit = (tower && pool.find(d => tower.test(hayOf(d))))
        || (first && (samePull.find(d => score(d, terms) > 0) || samePull[0]))
        || (terms.length ? pool.find(d => score(d, terms) > 0) : null);
      const pick = fit || pool[0];
      if (!pick) { matched.push({ victim: v, death: null }); continue; }
      taken.add(pick.key);
      matched.push({ victim: v, death: pick, fit: !!fit });
    }
    const found = matched.filter(m => m.death);
    if (found.length) at = Math.max(at, ...found.map(m => order(m.death)));
    rows.push({ ...c, terms, matched });
  }
  return rows;
}

/** A death with its callout taken off: back to what the log analysis says. */
export const clearCallout = e => ({ ...e, note: '', blame: e.player, mech: !e.wipeOut && AUTO_MECH.has(e.category), src: 'auto' });

/** Write matched callouts into the ledger: note, blame and "mechanical". Earlier callouts on these reports are cleared first. */
export function applyCallouts(ledger, rows, reports) {
  const out = { ...ledger };
  for (const [k, e] of Object.entries(out)) if (reports.includes(e.report) && e.src === 'callout') {
    out[k] = clearCallout(e);
  }
  for (const r of rows) for (const m of r.matched) if (m.death) {
    out[m.death.key] = { ...out[m.death.key], note: r.text, blame: r.blame || m.victim, mech: true, src: 'callout' };
  }
  return out;
}

// ---------- weekly / monthly tally ----------

/** FFXIV's weekly reset: Tuesday 08:00 UTC. A raid week runs from one reset to the next. */
export function weekStart(ms) {
  const d = new Date(ms);
  const reset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8);
  const back = (d.getUTCDay() - 2 + 7) % 7; // days since Tuesday
  let s = reset - back * 86400000;
  if (s > ms) s -= 7 * 86400000;
  return s;
}
export const monthStart = ms => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };

/** The last `n` periods up to `now`, newest first: [{start, end, label}]. */
export function periods(kind, now, n) {
  const out = [];
  if (kind === 'week') {
    let s = weekStart(now);
    for (let i = 0; i < n; i++, s -= 7 * 86400000) {
      const label = new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      out.push({ start: s, end: s + 7 * 86400000, label: i === 0 ? `This week (${label})` : i === 1 ? `Last week (${label})` : `Week of ${label}` });
    }
  } else {
    const d = new Date(now);
    for (let i = 0; i < n; i++) {
      const s = new Date(d.getFullYear(), d.getMonth() - i, 1), e = new Date(d.getFullYear(), d.getMonth() - i + 1, 1);
      const label = s.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
      out.push({ start: s.getTime(), end: e.getTime(), label: i === 0 ? `This month (${label})` : label });
    }
  }
  return out;
}

/** Does this ledger entry count for this view? Mechanical: blamed on someone. All: every death before the wipe-out. */
export const counts = (e, mode) => mode === 'mech' ? e.mech && !!e.blame : (!e.wipeOut || e.src === 'callout');
export const ownerOf = (e, mode) => mode === 'mech' ? e.blame : e.player;

/** Per player: count in each period and all time. Rows sorted by the newest period, then all time. */
export function tally(entries, mode, ps) {
  const by = new Map();
  for (const e of entries) {
    if (!counts(e, mode)) continue;
    const who = ownerOf(e, mode);
    if (!by.has(who)) by.set(who, { player: who, job: e.player === who ? e.job : null, per: ps.map(() => 0), total: 0 });
    const r = by.get(who);
    if (!r.job && e.player === who) r.job = e.job;
    r.total++;
    ps.forEach((p, i) => { if (e.abs >= p.start && e.abs < p.end) r.per[i]++; });
  }
  return [...by.values()].sort((a, b) => b.per[0] - a.per[0] || b.total - a.total || a.player.localeCompare(b.player));
}
