// Loads the mit sheet (one tab per phase) and turns it into a plan model.
import { parseCell, parseCellLoose } from './mits.js';

export const DEFAULT_SHEET = {
  id: '10C3ytfH3irHqkb45rchIq5oqdAs-v_OKTj57M-Twi3k',
  // In phase order. Tab names: "P1 | Kefka" ... "P5 | Kefka Reimagined".
  gids: ['161526414', '583362985', '247845947', '2072785902', '696382883'],
};

// Preset mit sheets (both published with the same tab layout and gids).
export const PLANS = {
  ikuya: { name: 'Ikuya', id: '10C3ytfH3irHqkb45rchIq5oqdAs-v_OKTj57M-Twi3k', gids: ['161526414', '583362985', '247845947', '2072785902', '696382883'] },
  lpdu: { name: 'LPDU', id: '1aA_qF_UsoS51MCDZ4PwQHhprpK7eGO8TXOdZ7pQlkV0', gids: ['161526414', '583362985', '247845947', '2072785902', '696382883'] },
};

export const SLOTS = ['MT', 'OT', 'White Mage', 'Astrologian', 'Scholar', 'Sage', 'D1', 'D2', 'D3', 'D4'];

export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function parseTime(s) {
  const m = String(s || '').trim().match(/^(\d+):(\d{2})$/);
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}

/** Turn one phase tab's CSV into {name, rows:[{mechanic, total, phaseTime, cells:{slot:[tokens]}}]}. */
export function parsePhaseTab(csvText, index) {
  const rows = parseCSV(csvText);
  let name = `Phase ${index + 1}`;
  for (const r of rows) {
    const t = r.find(c => /^Phase \d/i.test(c.trim()));
    if (t) { name = t.trim(); break; }
  }
  // Header row: the one with an "MT…" column ("MT", or LPDU's "MT Start Exdeath").
  const hdrIdx = rows.findIndex(r => r.some(c => /^MT\b/.test(c.trim())));
  if (hdrIdx < 0) throw new Error(`Couldn't find the MT/OT header row in tab ${index + 1}`);
  const hdr = rows[hdrIdx].map(c => c.trim());
  // Ikuya names DPS columns D1–D4; LPDU uses M1, M2, R1, R2 (same order: melee, melee, phys ranged, caster).
  const HEADERS = { MT: ['MT'], OT: ['OT'], 'White Mage': ['White Mage'], Astrologian: ['Astrologian'], Scholar: ['Scholar'], Sage: ['Sage'],
    D1: ['D1', 'M1'], D2: ['D2', 'M2'], D3: ['D3', 'R1'], D4: ['D4', 'R2'] };
  const col = Object.fromEntries(SLOTS.map(s => [s, hdr.findIndex(c => HEADERS[s].some(h => c === h || c.startsWith(h + ' ')))]));
  const mtCol = col.MT;
  const loose = hdr.includes('M1') || hdr.includes('R1'); // LPDU-style free-text cells
  // Time columns sit between the mechanic name and MT. Ikuya has two (fight clock, phase clock); LPDU one (fight clock).
  const data = rows.slice(hdrIdx + 1);
  const timeCols = [];
  for (let c = 2; c < mtCol; c++) if (data.filter(r => parseTime(r[c]) != null).length >= 3) timeCols.push(c);
  const clock = timeCols.length >= 2 ? 'phase' : 'total';
  const tCol = timeCols.length >= 2 ? timeCols[1] : timeCols[0];
  const out = [];
  for (const r of data) {
    const mech = (r[1] || '').trim();
    const total = parseTime(r[timeCols[0]]);
    const phaseTime = parseTime(r[tCol]);
    if (!mech || phaseTime == null) continue;
    const cells = {};
    for (const s of SLOTS) if (col[s] >= 0) cells[s] = loose ? parseCellLoose(r[col[s]], s) : parseCell(r[col[s]]);
    out.push({ mechanic: mech.replace(/\s+/g, ' '), total, phaseTime, cells });
  }
  // Notes row (text under "Notes") holds the footnotes; keep it so the UI can show the sheet's own guidance.
  const notesRow = rows.find(r => (r[1] || '').trim() === 'Notes');
  const notes = notesRow ? (notesRow[timeCols[0] ?? 3] || '').trim() : '';
  laterSeraphIsConsolation(out);
  linkCarryOvers(out);
  // A note above the header that moves a tank job to the other column from here on, e.g. LPDU P3: "Paladin is forced
  // chaos start tank and will be OFFTANK (right column) from this point of the fight onwards".
  let tankSwap = null;
  const JOBS = { paladin: 'Paladin', warrior: 'Warrior', gunbreaker: 'Gunbreaker', 'dark knight': 'DarkKnight' };
  for (const r of rows.slice(0, hdrIdx)) for (const c of r) {
    const m = c.match(/\b(paladin|warrior|gunbreaker|dark knight)\b.*\b(off ?tank|main ?tank)\b.*\b(onwards|from (?:this|here))/i);
    if (m) tankSwap = { job: JOBS[m[1].toLowerCase()], slot: /^off/i.test(m[2]) ? 'OT' : 'MT', note: c.trim() };
  }
  // clock: 'phase' = times count from the phase's start; 'total' = from the pull (the per-phase offset absorbs it).
  return { index, name, rows: out, notes, clock, format: loose ? 'free-text' : 'cells', tankSwap };
}

/**
 * A "➔ X" entry means X was pressed for an earlier mechanic and should still be up for this one.
 * Link each carry-over to the row where that slot last pressed X (its origin), so a chain like
 * Reprisal for Mystery Magic ➔ Wave Cannon ➔ Double-Trouble Trap is checked as one press.
 */
export function linkCarryOvers(rows) {
  const keyOf = tok => (tok.party ? `party:${(tok.jobs || []).join('/')}` : (tok.names?.[0] || tok.label)).toLowerCase();
  const keyLoose = tok => (tok.party ? 'party' : (tok.names?.[0] || tok.label)).toLowerCase();
  const last = {}; // slot -> key -> row index of the original press
  rows.forEach((row, ri) => {
    for (const [slot, toks] of Object.entries(row.cells)) {
      last[slot] ||= {};
      for (const tok of toks) {
        if (tok.skip) continue;
        if (!tok.carry) { tok.origin = ri; last[slot][keyOf(tok)] = ri; last[slot][keyLoose(tok)] = ri; continue; }
        // "➔ Party Mit (GNB/DRK)" carries the press made under "Party Mit (WAR/PLD) ➔ ..." or plain "Party Mit".
        const o = last[slot][keyOf(tok)] ?? last[slot][keyLoose(tok)];
        tok.origin = o ?? null;
        // "Sun Sign\n➔ Sun Sign (7-8th Set)": the carry points at sets that aren't rows on the sheet; it would just
        // re-check this row's own press, so it isn't checked.
        if (o === ri) { tok.skip = 'Carries to sets not listed as rows (checked at the original press)'; }
      }
    }
  });
}

/**
 * Summon Seraph has a 120s recast and Seraph stays 22s (official), so a second "Seraph" in the same column within
 * 22s can only mean Seraph's Consolation.
 */
export function laterSeraphIsConsolation(rows) {
  const lastSummon = {};
  for (const row of rows) for (const [slot, toks] of Object.entries(row.cells)) for (const tok of toks) {
    if (tok.skip || tok.carry || tok.names?.[0] !== 'Summon Seraph') continue;
    if (lastSummon[slot] != null && row.phaseTime - lastSummon[slot] <= 22) { tok.names = ['Consolation']; tok.label = 'Consolation'; }
    else lastSummon[slot] = row.phaseTime;
  }
}

export async function loadPlan(sheet = DEFAULT_SHEET) {
  const phases = await Promise.all(sheet.gids.map(async (gid, i) => {
    const url = `https://docs.google.com/spreadsheets/d/${sheet.id}/gviz/tq?tqx=out:csv&headers=0&gid=${gid}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Mit sheet tab ${i + 1}: HTTP ${res.status}`);
    return parsePhaseTab(await res.text(), i);
  }));
  // "From this point onwards": a tank swap carries into every later phase that doesn't state its own.
  for (let i = 1; i < phases.length; i++) if (!phases[i].tankSwap && phases[i - 1].tankSwap) phases[i].tankSwap = { ...phases[i - 1].tankSwap, inherited: true };
  return { phases, loadedAt: Date.now() };
}

/** Name variants for matching a sheet mechanic to FFLogs ability names. */
export function mechanicAliases(mech) {
  // "Towers 1 (Stack)" / "Grand Cross 2": drop notes and trailing counters before matching ability names.
  const clean = mech.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, '');
  const base = clean.replace(/\([^)]*\)/g, '').replace(/\s+\d+$/, '').trim();
  // Names inside parentheses are often the real ability names: "Towers II (Past/Future's End)".
  const inner = [...clean.matchAll(/\(([^)]*)\)/g)].map(m => m[1]).filter(s => !/^(\d+(st|nd|rd|th)|part|stack|baits|chaos|exdeath|all things ending)/i.test(s.trim()))
    .flatMap(s => s.split('/')).map(s => s.trim());
  // "Past/Future's End" means "Past's End" and "Future's End".
  const expanded = inner.flatMap(s => /'s end$/i.test(s) ? [s] : /^\w+$/.test(s) && inner.some(x => /'s end$/i.test(x)) ? [`${s}'s End`] : [s]);
  return [...base.split('/'), ...expanded].map(normName).filter(Boolean);
}

export function normName(s) {
  return String(s).toLowerCase().replace(/judgement/g, 'judgment').replace(/embrance/g, 'embrace').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
