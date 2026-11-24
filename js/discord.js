// Discord export: a short team recap for the raid channel, and one note per player to send as a DM.
//
// Discord rules this follows:
//  - a message is cut at 2,000 characters, so every text is split into parts of at most LIMIT characters, on line
//    breaks, with a "(1/2)" marker;
//  - it renders "## heading", "### heading", "- bullet", "**bold**" and "-# small grey text", but not tables;
//  - a link in <angle brackets> doesn't make a preview card, and [text](<url>) is a masked link without one.
//
// The team recap names nobody by default (plan items use the sheet column: "OT", "D3"): the page's own advice is
// 1:1 feedback, not public callouts. Everything personal goes in the player notes.
import { fmt, STATUS_TEXT, BAD } from './analyze.js';
import { JOB_ABBR } from './mits.js';

const LIMIT = 1900;
const phaseShort = n => (n || '').replace(/^Phase (\d+):?\s*/, 'P$1 ').trim();
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const pullList = (ns, max = 8) => {
  const s = [...new Set(ns)].sort((a, b) => a - b);
  return s.slice(0, max).map(n => `#${n}`).join(', ') + (s.length > max ? ` +${s.length - max}` : '');
};
const fflUrl = (reportCode, fightId, t) => reportCode && !String(reportCode).startsWith('DEMO')
  ? `https://www.fflogs.com/reports/${reportCode}#fight=${fightId}&type=damage-taken${t ? `&start=${Math.round(t - 6000)}&end=${Math.round(t + 2000)}` : ''}` : null;
const masked = (text, url) => (url ? `[${text}](<${url}>)` : text);

/** Split a text into Discord-sized parts on line breaks; each part gets "(i/n)" when there's more than one. */
export function splitForDiscord(text, limit = LIMIT) {
  const parts = [];
  let cur = '';
  for (const line of text.split('\n')) {
    // A single line longer than the limit (rare) is cut at the limit.
    for (let rest = line; ; ) {
      const piece = rest.slice(0, limit);
      if (cur && cur.length + 1 + piece.length > limit) { parts.push(cur); cur = ''; }
      cur = cur ? `${cur}\n${piece}` : piece;
      rest = rest.slice(limit);
      if (!rest) break;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts.length > 1 ? parts.map((p, i) => `${p}\n-# (${i + 1}/${parts.length})`) : parts;
}

const label = (m, names) => (names ? m.player.name : m.slot || m.player.name);
// "Mystery Magic (3:07 · 3:07 into pull)" → "Mystery Magic (3:07)": the sheet time tells repeats apart.
const shortTime = s => String(s).replace(/ \((\d+:\d{2})( · [^)]*)?\)$/, ' ($1)');
const mechAt = m => shortTime(m.mechanic);

/**
 * Team recap. opts: { names (name players in plan items), url (page link), phaseLabel (when a phase filter is on) }.
 */
export function teamRecap(r, opts = {}) {
  const { names = false, url = null, phaseLabel = '' } = opts;
  const pulls = r.pulls, L = [];
  const best = [...pulls].sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0))[0];
  const deathsPer = pulls.length ? (pulls.reduce((s, p) => s + p.deaths.filter(d => !d.wipeOut).length, 0) / pulls.length).toFixed(1) : '0';
  const items = pulls.flatMap(p => p.rows.flatMap(x => x.items)).filter(i => !['dead', 'unaffected', 'conflict'].includes(i.status) && !i.shared);
  const up = items.filter(i => ['ok', 'other', 'used-up'].includes(i.status)).length;
  const chainsDone = r.chains.reduce((a, c) => a + c.full, 0), chainsHeld = r.chains.reduce((a, c) => a + c.held, 0);

  L.push(`## Wipe review · ${pulls.length} pulls${phaseLabel ? ` · ${phaseLabel} only` : ''}`);
  if (best) L.push(`**Best pull:** #${best.n}, ${phaseShort(best.phaseName)}${best.endedAt?.bossPct != null ? ` (${best.endedAt.bossPct.toFixed(1)}% boss HP left)` : ''} · **Clears:** ${pulls.filter(p => p.kill).length}`);
  L.push(`**Deaths per pull** (before the wipe-out): ${deathsPer} · **Planned mits up:** ${pct(up, items.length)}% · **Carry-overs held:** ${pct(chainsHeld, chainsDone)}%`);

  // Where the first death happens.
  const causes = r.causes.slice(0, 3);
  if (causes.length) {
    L.push('', '### Where pulls go wrong (first death)');
    for (const c of causes) {
      const cats = Object.entries(c.cats).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k.toLowerCase()} ×${v}`).join(', ');
      L.push(`- **${phaseShort(c.cause.split(': ')[0])}: ${c.cause.split(': ').slice(2).join(': ') || c.cause.split(': ').slice(1).join(': ')}**: ${c.count} pull${c.count > 1 ? 's' : ''} (${cats})`);
    }
  }

  // Closest to pushing.
  const close = pulls.filter(p => !p.kill && p.endedAt?.bossPct != null && p.endedAt.bossPct <= 10)
    .sort((a, b) => b.endedAt.phase - a.endedAt.phase || a.endedAt.bossPct - b.endedAt.bossPct).slice(0, 3);
  if (close.length) {
    L.push('', '### Closest to pushing');
    for (const p of close) L.push(`- #${p.n}: ${phaseShort(p.endedAt.phaseName)} with **${p.endedAt.bossPct.toFixed(1)}%** left${p.endedAt.recovered ? ' (recovered from an earlier death)' : ''}`);
  }

  // Party-wide: chain wipes, and what differed for the players a hit killed.
  const chains = pulls.filter(p => p.chainWipe);
  const dvl = r.mechanics.filter(m => m.diedVsLived?.reasons?.length).sort((a, b) => b.diedVsLived.died.n - a.diedVsLived.died.n).slice(0, 3);
  if (chains.length || dvl.length) {
    L.push('', '### Party-wide');
    if (chains.length) L.push(`- **${chains.length} chain wipe${chains.length > 1 ? 's' : ''}** (5+ dead within 3s): ${pullList(chains.map(p => p.n))}. Whoever dies first there is a victim; check the replay for who was out of place.`);
    for (const m of dvl) L.push(`- **${phaseShort(m.phaseName).split(' ')[0]} ${m.mechanic}**: the ${m.diedVsLived.died.n} who died ${m.diedVsLived.reasons[0].replace(/^they /, '')}`);
  }

  // Plan / sheet: carry-overs several players break together, and assignments never pressed (a plan difference?).
  const plan = [];
  const weak = r.chains.filter(c => c.full >= 3 && c.held / c.full < 0.5);
  const byBreak = {};
  // A break is keyed "Mechanic (m:ss · m:ss into pull): why"; split on ": " (the time has a colon of its own).
  weak.forEach(c => { const [b] = Object.entries(c.broke).sort((a, x) => x[1] - a[1])[0] || []; if (b) { const at = b.split(': ')[0]; const k = `${c.phase}|${c.linkNames[0]}|${at}`; (byBreak[k] ||= Object.assign([], { at })).push(c); } });
  for (const g of Object.values(byBreak).filter(g => g.length >= 3).sort((a, b) => b.length - a.length)) {
    // The break label has no sheet time; take it from the chain's own later hit with that name ("Wings of Destruction
    // (2:54)" carried to the next Wings of Destruction).
    const atName = g.at.replace(/ \([^)]*\)$/, '');
    const atLink = g[0].linkNames.slice(1).find(n => n.startsWith(atName));
    const where = atLink ? `don't reach ${shortTime(atLink)}` : `aren't up in time for the first hit`;
    plan.push(`- Carry-overs from **${shortTime(g[0].linkNames[0])}** ${where} for ${g.length} players (${g.map(c => `${label(c, names)} ${c.label}`).join(', ')}): press timing or the sheet's spacing.`);
  }
  const never = r.misses.filter(m => (m.counts.missing || 0) === m.total && m.total >= 5 && !/carried over/.test(m.label)).sort((a, b) => b.total - a.total).slice(0, 2);
  for (const m of never) plan.push(`- **${label(m, names)} ${m.label}** for ${mechAt(m)}: never pressed (${m.total} pulls). Plan difference, or should it be there?`);
  // Kept to 3 so the recap usually fits in one Discord message; the rest is on the page.
  if (plan.length) L.push('', '### Plan / sheet', ...plan.slice(0, 3));

  L.push('', `-# From the FFLogs log and the official Job Guide. Causes are likely explanations, not verdicts: check the replay before raising anything. Personal notes go out by DM.${url ? ` Full page: <${url}>` : ''}`);
  return splitForDiscord(L.join('\n'));
}

/** One note per player, to send as a DM. Returns [{ player, parts }]. */
export function playerNotes(r, opts = {}) {
  const { url = null, phaseLabel = '' } = opts;
  return r.perPlayer.map(s => {
    const p = s.player, L = [];
    const job = JOB_ABBR[p.job] || '';
    L.push(`**Wipe review: your notes** (${p.name}${s.slot ? ` · ${s.slot}` : ''}${job ? ` · ${job}` : ''}) · ${r.pulls.length} pulls${phaseLabel ? ` · ${phaseLabel} only` : ''}`);

    // Deaths.
    const cats = Object.entries(s.cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.toLowerCase()} ×${v}`).join(', ');
    L.push(`**Deaths before the wipe-out:** ${s.deaths}${s.deaths ? ` (${cats})` : ''}. First death of the pull: ${s.firsts}${s.chainFirsts ? ` (+${s.chainFirsts} as the first victim of a chain wipe, not counted)` : ''}.`);
    const own = r.pulls.flatMap(pl => pl.deaths.filter(d => d.player.name === p.name && !d.wipeOut && !(pl.chainWipe && d === pl.first)).map(d => ({ pl, d })));
    const worth = own.filter(({ d }) => d.confidence !== 'low').sort((a, b) => (a.d === a.pl.first ? -1 : 0) - (b.d === b.pl.first ? -1 : 0) || a.pl.n - b.pl.n).slice(0, 3);
    if (worth.length) {
      L.push('**Deaths worth a look:**');
      for (const { pl, d } of worth) L.push(`- ${masked(`#${pl.n}`, fflUrl(pl.reportCode, pl.id, d.hitT))} ${d.nearMechanic || d.mechanic}: ${d.category.toLowerCase()}${d.hpPct != null ? `, ${d.hpPct}% HP going in` : ''}`);
    }

    // Planned mits.
    const misses = r.misses.filter(m => m.player.name === p.name && !/carried over/.test(m.label) && m.bad >= 2).slice(0, 3);
    if (misses.length) {
      L.push('**Planned mits often not up:**');
      for (const m of misses) {
        const top = Object.entries(m.counts).filter(([k]) => BAD.includes(k)).sort((a, b) => b[1] - a[1])[0];
        const never = (m.counts.missing || 0) === m.total && m.total >= 5;
        L.push(`- ${m.label} for ${mechAt(m)}: not up ${m.bad}/${m.total} (mostly ${STATUS_TEXT[top[0]]})${m.differentPlan || never ? '. Looks like a plan difference: is this assignment right?' : ''}${m.usedForTop && !never ? `; usually used for ${shortTime(m.usedForTop.where)} instead` : ''}`);
      }
    }

    // Carry-overs.
    const mine = r.chains.filter(c => c.player.name === p.name && c.full >= 3);
    if (mine.length) {
      const held = mine.reduce((a, c) => a + c.held, 0), full = mine.reduce((a, c) => a + c.full, 0);
      const worst = mine.filter(c => c.held / c.full < 0.5).sort((a, b) => a.held / a.full - b.held / b.full).slice(0, 2);
      L.push(`**Carry-overs:** lasted every hit ${held}/${full}.`);
      for (const c of worst) L.push(`- ${c.label} from ${c.linkNames[0].replace(/ \([^)]*\)$/, '')}: lasted ${c.held}/${c.full}${c.medWindowFrom != null && c.medWindowFrom <= 0 ? `. To last, press it in the last ${Math.abs(c.medWindowFrom).toFixed(1)}s before ${c.linkNames[0].replace(/ \([^)]*\)$/, '')}${c.medOffset != null ? ` (you press ${Math.abs(c.medOffset).toFixed(1)}s before)` : ''}` : ''}.`);
    }

    // Failure debuffs and range.
    if (s.fails) L.push(`**Failure debuffs:** ${s.fails} (${s.failsSurvived} lived through): ${Object.entries(s.failsBy).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ×${v}`).join(', ')}.`);
    if (s.outOfRange) L.push(`**Out of range of party heals / shields / mits:** ${s.outOfRange}× (${Object.entries(s.outOfRangeBy).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ×${v}`).join(', ')}).${s.outOfRange >= 5 ? ' Stay closer to the healers when party mits and heals go out.' : ''}`);

    L.push(`-# From the FFLogs log; causes are likely explanations, not verdicts.${url ? ` Full page: <${url}>` : ''}`);
    return { player: p, parts: splitForDiscord(L.join('\n')) };
  });
}
