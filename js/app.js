import * as ff from './fflogs.js';
import { loadPlan, DEFAULT_SHEET, SLOTS, PLANS } from './plan.js';
import { analyze, aggregate, autoAssign, pickEncounter, fmt, STATUS_TEXT, BAD, learnMapping, sheetClock } from './analyze.js';
import { buildReference, agreementOf } from './reference.js';
import { buildDemo } from './demo.js';
import { JOB_ABBR, CATALOG, checkCatalog, PARTY_MIT_BY_JOB } from './mits.js';
import { JOB_GUIDE, JOB_GUIDE_PATCH } from './jobguide.js';
import { teamRecap, playerNotes } from './discord.js';
import { mergeDeaths, matchCallouts, applyCallouts, clearCallout, parseNicknames, periods, tally, counts } from './tally.js';
import { CONFIG } from './config.js';
import * as cloud from './cloud.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = 'umad-wipes.';
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(LS + k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(LS + k, JSON.stringify(v)),
};

let plan = null;
let loaded = [];          // [{report, events, fightIds, demo?}]
let result = null;        // what's shown: fullResult, or a one-phase view of it
let fullResult = null;    // aggregate() of everything
let phaseCache = {};      // phase index -> one-phase view
let refLoaded = [];       // reference clears: [{report, events, fightIds:[id], fight, url}]
let mapping = null;       // shared sheet-to-log mapping (learnMapping)
let rosterByName = store.get('roster', {}); // slot -> player name
let view = { tab: 'summary', player: '', phase: '', tallyKind: 'week', tallyMode: 'mech' };
// Every death from every analyzed report, kept across nights for the weekly / monthly tally (js/tally.js).
// With Supabase set up (js/config.js) the tally lives online and only the owner's FFLogs account can see or change it:
// the database checks the FFLogs login token on every call (supabase/setup.sql). Without Supabase it stays in this browser.
let ledger = cloud.cloudOn() ? {} : store.get('ledger', {});
let demoLedger = {};           // demo pulls never go into the saved ledger
let calloutRows = null;        // last "Match to deaths" result, for the table under the callouts box
// The static's own names for mechanics, used to match callouts ("statue" is Flagrant Fire III). Editable on the tab.
const DEFAULT_NICKNAMES = `forsaken = forsaken, towers, spelldriver, spellwave
towers, tower = towers, spelldriver, spellwave, past's end, future's end
lazer, laser, beams, beam = the river of light
statue, gaze = flagrant fire iii, mystery magic
puddle, cleave = past's end, future's end, tsunami
arrows, arrow = revolting ruin iii`;
// `synced` holds what the server has for each key, so only changed deaths are sent.
let synced = {};
let cloudState = cloud.cloudOn() ? 'checking' : 'off'; // off | checking | ready | denied | error
let me = null;                 // { id, name, owner } of the logged-in FFLogs account, from the database's check
/** May this viewer see the death tally at all? Online: only the owner's FFLogs account. */
const tallyAllowed = () => !cloud.cloudOn() || cloudState === 'ready';
const unsynced = () => Object.values(ledger).filter(e => synced[e.key] !== JSON.stringify(e));
let saving = Promise.resolve();
function saveLedger() {
  if (!cloud.cloudOn()) {
    try { store.set('ledger', ledger); } catch (e) { status(`Couldn't save the death tally: ${e.message}`, true); }
    return;
  }
  const token = ff.userToken();
  if (cloudState !== 'ready' || !token) return;
  saving = saving.then(async () => {
    const todo = unsynced();
    if (!todo.length) return;
    try {
      await cloud.saveEntries(token, todo);
      todo.forEach(e => { synced[e.key] = JSON.stringify(e); });
      status(`Saved ${todo.length} death${todo.length === 1 ? '' : 's'} to the online tally.`);
    } catch (e) { status(e.message, true); }
    if (view.tab === 'tally' && fullResult) render();
  });
}
/** Ask the database who this FFLogs login is; load the tally only for the owner. Everyone else never sees it. */
async function initCloud() {
  const token = ff.userToken();
  if (!token) { cloudState = 'denied'; me = null; renderConn(); render(); return; }
  cloudState = 'checking';
  try {
    me = await cloud.whoami(token);
    if (me?.owner) {
      const remote = await cloud.loadTally(token);
      synced = Object.fromEntries(Object.entries(remote).map(([k, e]) => [k, JSON.stringify(e)]));
      // Deaths analyzed before the download finished are kept; the server wins on the same death.
      ledger = { ...ledger, ...remote };
      cloudState = 'ready';
      saveLedger();
    } else cloudState = 'denied';
  } catch (e) { cloudState = 'error'; console.warn('Death tally:', e.message); }
  renderConn();
  render();
}

function status(msg, err = false) { const s = $('#status'); s.textContent = msg; s.classList.toggle('err', err); }
function busy(on) { ['#btn-run', '#btn-demo', '#btn-rerun', '#btn-detect'].forEach(s => { $(s).disabled = on; }); }
function sheetCfg() { return store.get('sheet', DEFAULT_SHEET); }

// Which mit sheet your pulls are checked against: a preset (Ikuya, LPDU) or the custom sheet from Settings.
let planKey = store.get('planKey', 'ikuya');
const planCache = {};
const sheetFor = key => key === 'custom' ? sheetCfg() : PLANS[key];
const planName = key => key === 'custom' ? 'Custom sheet' : PLANS[key].name;
async function loadPlanKey(key) {
  if (!planCache[key]) { status(`Loading the ${planName(key)} mit sheet…`); planCache[key] = await loadPlan(sheetFor(key)); }
  return planCache[key];
}
async function getPlan() {
  plan = await loadPlanKey(planKey);
  // The presets are also used to score the reference clears against each plan.
  await Promise.all(Object.keys(PLANS).map(loadPlanKey));
  return plan;
}

// ---------- connection / settings ----------
function renderConn() {
  const ok = ff.isConfigured();
  const a = ff.getAuth();
  // Logged-in FFLogs name and user ID (from the tally check), so the owner can find their ID for supabase/setup.sql.
  const who = me?.name ? ` as ${me.name} (#${me.id})` : '';
  $('#conn').textContent = ok ? (a.mode === 'user' ? `FFLogs: logged in${who}` : 'FFLogs: connected') : 'FFLogs: not connected';
  $('#conn').classList.toggle('ok', !!ok);
  // Shared page with a public FFLogs client in js/config.js: one button, nothing to type.
  $('#btn-login').classList.toggle('hidden', !!ok || !CONFIG.fflogsClientId);
}
$('#btn-login').onclick = () => ff.startPkceLogin(CONFIG.fflogsClientId);
function openSettings() {
  const a = ff.getAuth();
  $('#cc-id').value = a.mode === 'client' ? a.clientId || '' : '';
  $('#cc-secret').value = a.mode === 'client' ? a.clientSecret || '' : '';
  $('#pkce-id').value = a.mode === 'user' ? a.clientId || '' : (store.get('pkceId', '') || CONFIG.fflogsClientId);
  $('#redir').textContent = location.origin + location.pathname;
  const s = sheetCfg();
  $('#sheet-id').value = s.id; $('#sheet-gids').value = s.gids.join(',');
  $('#settings').showModal();
}
$('#btn-settings').onclick = openSettings;
$('#btn-cc').onclick = async () => {
  ff.saveClientCredentials($('#cc-id').value.trim(), $('#cc-secret').value.trim());
  try { await ff.gql('{ rateLimitData { pointsSpentThisHour limitPerHour } }'); renderConn(); $('#btn-cc').textContent = 'Connected ✓'; }
  catch (e) { alert(e.message); }
};
$('#btn-pkce').onclick = () => { const id = $('#pkce-id').value.trim(); if (!id) return; store.set('pkceId', id); ff.startPkceLogin(id); };
$('#btn-signout').onclick = () => {
  localStorage.removeItem(LS + 'auth');
  if (cloud.cloudOn()) { me = null; cloudState = 'denied'; ledger = {}; synced = {}; calloutRows = null; }
  renderConn(); render();
};
$('#btn-clear-cache').onclick = async () => { await ff.clearCache(); $('#btn-clear-cache').textContent = 'Cleared ✓'; };
$('#settings').addEventListener('close', () => {
  const id = $('#sheet-id').value.trim();
  const gids = $('#sheet-gids').value.split(',').map(s => s.trim()).filter(Boolean);
  const prev = sheetCfg();
  if (id && gids.length && (id !== prev.id || gids.join() !== prev.gids.join())) { store.set('sheet', { id, gids }); delete planCache.custom; }
});

// ---------- running ----------
$('#reports').value = store.get('reports', '');
$('#plan-select').value = planKey;
// Switching sheets re-checks everything already loaded against the new plan (and resets the roster guess).
$('#plan-select').onchange = async e => {
  planKey = e.target.value; store.set('planKey', planKey);
  rosterByName = {}; store.set('roster', {});
  try { await getPlan(); if (loaded.length) run(); } catch (err) { status(err.message, true); }
};

$('#btn-run').onclick = async () => {
  const lines = $('#reports').value.split(/\s+/).filter(Boolean);
  store.set('reports', $('#reports').value);
  const codes = [...new Set(lines.map(l => ff.parseReportCode(l)?.code).filter(Boolean))];
  if (!codes.length) return status('Paste at least one FFLogs report link.', true);
  if (!ff.isConfigured()) {
    if (CONFIG.fflogsClientId) { status('Logging in to FFLogs… press Analyze again when you\'re back.'); return ff.startPkceLogin(CONFIG.fflogsClientId); }
    status('Connect to FFLogs first (Settings).', true); return openSettings();
  }
  busy(true);
  try {
    await getPlan();
    const reports = [];
    for (const code of codes) reports.push(await ff.fetchReport(code, status));
    const tally = {};
    reports.forEach(r => pickEncounter(r).forEach(id => { tally[id] = (tally[id] || 0) + r.fights.filter(f => f.encounterID === id).length; }));
    const enc = +Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
    if (!enc) throw new Error('No boss pulls found in these reports.');
    let all = reports.flatMap(r => r.fights.filter(f => f.encounterID === enc).map(f => ({ r, f, abs: r.startTime + f.startTime })));
    all.sort((a, b) => a.abs - b.abs);
    const lastN = +$('#last-n').value || 0;
    if (lastN > 0) all = all.slice(-lastN);
    loaded = [];
    for (const r of reports) {
      const ids = all.filter(x => x.r === r).map(x => x.f.id);
      if (!ids.length) continue;
      const events = await ff.fetchEvents(r, ids, m => status(`${r.code}: ${m}`));
      loaded.push({ report: r, events, fightIds: ids });
    }
    if (store.get('refsOn', false) && !refLoaded.length) refLoaded = await fetchRefs(store.get('refs', DEFAULT_REFS));
    run();
  } catch (e) { console.error(e); status(e.message, true); }
  finally { busy(false); }
};

$('#btn-demo').onclick = async () => {
  busy(true);
  try {
    const p = await getPlan();
    const demo = buildDemo(p);
    loaded = [{ report: demo.report, events: demo.events, fightIds: demo.report.fights.map(f => f.id), demo: true }];
    rosterByName = {};
    run();
  } catch (e) { console.error(e); status(e.message, true); }
  finally { busy(false); }
};
$('#btn-rerun').onclick = () => { readRoster(); run(); };
$('#btn-detect').onclick = () => { rosterByName = {}; store.set('roster', {}); run(); };

function playersOf(entry) {
  const ids = new Set(entry.report.fights.filter(f => entry.fightIds.includes(f.id)).flatMap(f => f.friendlyPlayers || []));
  return entry.report.masterData.actors.filter(a => ids.has(a.id) && JOB_ABBR[a.subType]).map(a => ({ id: a.id, name: a.name, job: a.subType }));
}

function assignmentsFor(entry, roster = rosterByName) {
  const players = playersOf(entry);
  const guess = autoAssign(players);
  const out = {};
  for (const slot of SLOTS) {
    const named = players.find(p => p.name === roster[slot]);
    const id = named ? named.id : guess[slot];
    if (id != null) out[slot] = id;
  }
  const healerJob = { 'White Mage': 'WhiteMage', 'Astrologian': 'Astrologian', 'Scholar': 'Scholar', 'Sage': 'Sage' };
  for (const [slot, job] of Object.entries(healerJob)) {
    const p = players.find(x => x.id === out[slot]);
    if (p && p.job !== job) delete out[slot];
  }
  return out;
}

/** MT/OT, D1/D2, D3/D4: try each swap; keep the one where the most planned mits line up with real presses. */
const DEFAULT_REFS = [
  'https://www.fflogs.com/reports/wt1a6R9kmPd4jpX8?fight=25', 'https://www.fflogs.com/reports/bFk3vRLTDmKBNCPX?fight=9',
  'https://www.fflogs.com/reports/4G7pvaL2D3kRBgV9?fight=28', 'https://www.fflogs.com/reports/DNw1AC3X6TRrKWLQ?fight=3',
  'https://www.fflogs.com/reports/A69zryqKcf8GZPjw?fight=6', 'https://www.fflogs.com/reports/a2Bbv7VxDhWzYCrM?fight=20',
  'https://www.fflogs.com/reports/KWHgxhJnCDNvFr9f?fight=1', 'https://www.fflogs.com/reports/KgWNBCvJm42nqk18?fight=15',
].join('\n');

/** Download each reference clear (just that one fight) and re-run the analysis with them. */
async function fetchRefs(text) {
  const links = text.split(/\s+/).filter(Boolean);
  const out = [];
  for (const [i, l] of links.entries()) {
    const code = ff.parseReportCode(l)?.code, fid = +(l.match(/fight=(\d+)/)?.[1] || 0);
    if (!code || !fid) throw new Error(`Each reference link needs a report and a fight number (…?fight=N): ${l}`);
    const report = await ff.fetchReport(code, status);
    const fight = report.fights.find(f => f.id === fid);
    if (!fight) throw new Error(`Fight ${fid} not found in ${code}.`);
    const events = await ff.fetchEvents(report, [fid], m => status(`Reference ${i + 1}/${links.length}: ${m}`));
    out.push({ report, events, fightIds: [fid], fight, url: l });
  }
  return out;
}
async function loadRefs(text) {
  store.set('refs', text);
  if (!ff.isConfigured()) { status('Connect to FFLogs first (Settings).', true); return openSettings(); }
  busy(true);
  try {
    await getPlan();
    refLoaded = await fetchRefs(text);
    store.set('refsOn', true); // reload them automatically next time (they're cached)
    view.tab = 'reference';
    run();
  } catch (e) { console.error(e); status(e.message, true); }
  finally { busy(false); }
}

function detectAssignments(entry, roster = {}, p = plan, m = mapping) {
  const base = assignmentsFor(entry, roster);
  const swaps = [['MT', 'OT'], ['D1', 'D2'], ['D3', 'D4']].filter(([a, b]) => base[a] && base[b]);
  let best = null;
  for (let mask = 0; mask < 1 << swaps.length; mask++) {
    const a = { ...base };
    swaps.forEach(([x, y], i) => { if (mask & (1 << i)) [a[x], a[y]] = [a[y], a[x]]; });
    const r = analyze({ report: entry.report, plan: p, events: entry.events, fightIds: entry.fightIds, assignments: a, mapping: m });
    const score = r.pulls.reduce((s, p) => s + (p.mitStats.ok || 0) + (p.mitStats.other || 0), 0);
    if (!best || score > best.score) best = { score, a };
  }
  return best.a;
}
function detectRoster(entry) {
  const players = playersOf(entry);
  const a = detectAssignments(entry);
  rosterByName = Object.fromEntries(Object.entries(a).map(([s, id]) => [s, players.find(p => p.id === id)?.name]));
}

function renderRoster() {
  const all = [];
  for (const e of loaded) for (const p of playersOf(e)) if (!all.some(q => q.name === p.name)) all.push(p);
  const first = loaded[0];
  const a = assignmentsFor(first);
  const nameOf = id => playersOf(first).find(p => p.id === id)?.name || '';
  $('#roster').innerHTML = SLOTS.map(slot => `
    <label>${esc(slot)}
      <select data-slot="${esc(slot)}">
        <option value="">—</option>
        ${all.map(p => `<option ${nameOf(a[slot]) === p.name ? 'selected' : ''} value="${esc(p.name)}">${esc(p.name)} (${JOB_ABBR[p.job] || esc(p.job)})</option>`).join('')}
      </select>
    </label>`).join('');
  $('#roster-summary').textContent = SLOTS.filter(s => a[s]).map(s => `${s}: ${nameOf(a[s]).split(' ')[0]}`).join(' · ');
  $('#roster-card').classList.remove('hidden');
}
function readRoster() {
  rosterByName = {};
  document.querySelectorAll('#roster select').forEach(s => { if (s.value) rosterByName[s.dataset.slot] = s.value; });
  if (!loaded[0]?.demo) store.set('roster', rosterByName);
}

function run() {
  status('Analyzing…');
  setTimeout(() => {
    try {
      // One sheet-to-log mapping learned from your pulls and the reference clears together.
      const isDemo = !!loaded[0]?.demo;
      mapping = learnMapping([...loaded, ...(isDemo ? [] : refLoaded)], plan);
      if (loaded.length && !isDemo && !Object.keys(rosterByName).length) detectRoster(loaded[0]);
      if (isDemo) rosterByName = {};
      const parts = loaded.map(e => analyze({ report: e.report, plan, events: e.events, fightIds: e.fightIds, assignments: assignmentsFor(e), mapping }));
      result = aggregate(parts);
      result.demo = isDemo;
      if (!isDemo && refLoaded.length) {
        status('Analyzing reference clears…');
        const refParts = refLoaded.map(e => {
          const a = analyze({ report: e.report, plan, events: e.events, fightIds: e.fightIds, assignments: detectAssignments(e), mapping });
          const jobs = a.players.map(p => p.job);
          return { label: `${e.report.code}#${e.fight.id}`, url: e.url, jobs, players: a.players, pull: a.pulls[0], fight: e.fight, report: e.report };
        });
        result.reference = buildReference(refParts, result, plan);
        // Score every clear against each preset sheet, so it's clear which plan (if any) each one follows.
        const all = [...loaded, ...refLoaded];
        result.reference.planScores = {};
        for (const pk of Object.keys(PLANS)) {
          const p = planCache[pk];
          if (!p) continue;
          status(`Scoring the clears against the ${planName(pk)} sheet…`);
          const m = pk === planKey ? mapping : learnMapping(all, p);
          result.reference.planScores[pk] = refLoaded.map(e => {
            const a = analyze({ report: e.report, plan: p, events: e.events, fightIds: e.fightIds, assignments: detectAssignments(e, {}, p, m), mapping: m });
            return agreementOf(a.pulls[0]);
          });
          // Your own pulls against the same sheet (median over pulls), to show which plan the static really plays.
          const ourScores = loaded.flatMap(e => analyze({ report: e.report, plan: p, events: e.events, fightIds: e.fightIds,
            assignments: pk === planKey ? assignmentsFor(e) : detectAssignments(e, {}, p, m), mapping: m }).pulls.map(agreementOf));
          const med = arr => arr.length ? [...arr].sort((x, y) => x - y)[Math.floor(arr.length / 2)] : null;
          (result.reference.ourScores ||= {})[pk] = { party: med(ourScores.map(s => s.party).filter(v => v != null)), all: med(ourScores.map(s => s.agreement).filter(v => v != null)), n: ourScores.length };
        }
      }
      // Keep the full result; render() derives the phase view from it.
      fullResult = result; phaseCache = {};
      if (isDemo) demoLedger = mergeDeaths({}, fullResult.pulls);
      else if (tallyAllowed()) { ledger = mergeDeaths(ledger, fullResult.pulls); saveLedger(); }
      calloutRows = null;
      if (loaded.length) renderRoster();
      render();
      status(`${fullResult.pulls.length} pulls analyzed${refLoaded.length && !isDemo ? `, ${refLoaded.length} reference clears` : ''}${isDemo ? ' (demo data, made up)' : ''}.`);
    } catch (e) { console.error(e); status(e.message, true); }
  }, 10);
}

// ---------- rendering helpers ----------
const PHASE_COLOR = k => `var(--series-${(k % 5) + 1})`;
/** A logged moment on both clocks: "2:54 (6:11 into pull)"; fight-clock sheets: "6:11 into pull". */
const clockAt = (k, rel, pullT) => pullT == null ? fmt(rel)
  : plan.phases[k]?.clock === 'total' ? `${fmt(pullT)} into pull` : `${fmt(rel)} <span class="muted">(${fmt(pullT)} into pull)</span>`;
const phaseShort = n =>(n || '').replace(/^Phase (\d+):?\s*/, 'P$1 ');
const num = v => v == null ? '?' : Math.round(v).toLocaleString();
const pct = (a, b) => b ? Math.round(100 * a / b) : 0;
const STATUS_ICON = { ok: 'ok', other: 'other', unaffected: 'dead', conflict: 'dead', unexplained: 'other', 'used-up': 'other', overwritten: 'other', range: 'late', late: 'late', expired: 'expired', cooldown: 'other', missing: 'missing', dead: 'dead', 'no-lb': 'missing' };
const STATUS_SHORT = { ok: 'up', other: 'up (someone else)', unaffected: "attack ignores it", conflict: 'impossible on the sheet', unexplained: 'unclear (check replay)', 'used-up': 'shield used up', overwritten: 'overwritten', range: 'not on targets', late: 'late', expired: 'ran out', cooldown: 'on cooldown', missing: 'not pressed', dead: 'dead', 'no-lb': 'no tank LB (party)' };
const ffl = (p, t) => p.reportCode && !p.reportCode.startsWith('DEMO')
  ? `https://www.fflogs.com/reports/${p.reportCode}#fight=${p.id}&type=damage-taken${t ? `&start=${Math.round(t - 6000)}&end=${Math.round(t + 2000)}` : ''}` : null;
const fflLink = (p, t, label = 'FFLogs') => { const u = ffl(p, t); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener" class="small">${label} ↗</a>` : ''; };
const KIND_LABEL = { log: 'Log', official: 'Official', calc: 'Math' };
const KIND_TIP = { log: 'Read straight from the FFLogs report.', official: 'From the official FFXIV Job Guide.', calc: 'Worked out from the log times and official durations.' };
function factsHtml(facts) {
  return `<ul class="facts">${(facts || []).map(f => `<li><span class="src src-${f.k}" data-tip="${esc(KIND_TIP[f.k])}">${KIND_LABEL[f.k]}</span> ${esc(f.text)}${f.url ? ` <a href="${esc(f.url)}" target="_blank" rel="noopener" class="small">source ↗</a>` : ''}</li>`).join('')}</ul>`;
}
const chip = (status, text, tip) => `<span class="chip ${STATUS_ICON[status] || ''}"${tip ? ` data-tip="${esc(tip)}"` : ''}>${text}</span>`;
const conf = c => `<span class="conf conf-${c}" data-tip="${esc({ high: 'The log shows this directly (e.g. 10× max HP overkill, several players dying at the same instant, a vuln still on them).', medium: 'Worked out from how many players a hit normally lands on and what was up; check the replay before acting on it.', low: 'The log has no damage for this death; only the replay can say what happened.' }[c])}">${c} confidence</span>`;
const forPlayer = name => !view.player || view.player === name;

/**
 * One phase only: pulls that reached it, with just that phase's mechanics, deaths and carry-overs. A pull counts
 * towards "where pulls end" only if its first death (or the end of the pull) was in this phase. Pull numbers
 * stay the same as in the full list.
 */
function viewResult() {
  return view.phase === '' ? fullResult : viewFor(+view.phase);
}
function viewFor(k) {
  if (phaseCache[k]) return phaseCache[k];
  const pulls = fullResult.pulls.filter(p => (p.phase ?? -1) >= k).map(p => ({
    ...p,
    rows: p.rows.filter(r => r.phase === k),
    deaths: p.deaths.filter(d => d.phase === k),
    chains: p.chains.filter(c => c.phase === k),
    countCause: !p.kill && (p.first ? p.first.phase === k : p.phase === k),
  }));
  const f = fullResult;
  const r = aggregate([{ pulls, players: f.players, learned: f.learned, rowAbility: f.rowAbility, phaseOffset: f.phaseOffset,
    haveStatusEvents: f.haveStatusEvents, havePositions: f.havePositions }], { renumber: false });
  r.demo = f.demo;
  if (f.reference) {
    const R = f.reference, only = x => x.phase === k;
    r.reference = { ...R, mechanics: R.mechanics.filter(only), consensus: R.consensus.filter(only), split: R.split.filter(only), chains: R.chains.filter(only) };
  }
  return (phaseCache[k] = r);
}

function render() {
  if (!fullResult) {
    // Nothing analyzed yet: with an online tally, show it straight away so the static can read it without FFLogs.
    // Nothing analyzed yet: the owner sees their tally straight away; everyone else sees nothing here.
    $('#results').innerHTML = cloud.cloudOn() && tallyAllowed() ? `<div id="tab-body">${TABS.tally()}</div>` : '';
    if (cloud.cloudOn() && tallyAllowed()) bindTally();
    return;
  }
  if (view.tab === 'tally' && !tallyAllowed()) view.tab = 'summary';
  result = viewResult();
  const tabs = [['summary', 'Summary'], ['mechanics', 'Mechanics'], ['carry', 'Carry-overs'], ['mits', 'Mit plan'], ['deaths', 'Deaths'], ['pulls', 'Pulls'], ['tally', 'Death tally'], ['reference', 'Reference clears'], ['method', 'How it works & sources']]
    .filter(([id]) => id !== 'tally' || tallyAllowed());
  $('#results').innerHTML = `
    ${result.demo ? '<p class="banner">Demo data: made-up players and pulls built from the real mit sheet.</p>' : ''}
    <nav class="tabs" role="tablist">${tabs.map(([id, label]) => `<button role="tab" class="tab ${view.tab === id ? 'on' : ''}" data-tab="${id}">${label}</button>`).join('')}
      <label class="inline filter">Phase <select id="phase-filter"><option value="">All phases</option>${plan.phases.map((ph, k) => `<option value="${k}" ${view.phase === String(k) ? 'selected' : ''}>${esc(phaseShort(ph.name))}</option>`).join('')}</select></label>
      <label class="inline">Player <select id="player-filter"><option value="">Everyone</option>${result.players.map(p => `<option ${view.player === p.name ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    </nav>
    <div id="tab-body">${TABS[view.tab]()}</div>`;
  document.querySelectorAll('.tab').forEach(b => b.onclick = () => { view.tab = b.dataset.tab; render(); });
  $('#player-filter').onchange = e => { view.player = e.target.value; render(); };
  $('#phase-filter').onchange = e => { view.phase = e.target.value; render(); };
  document.querySelectorAll('[data-phase]').forEach(b => b.onclick = e => { e.preventDefault(); view.phase = b.dataset.phase; render(); });
  document.querySelectorAll('[data-goto]').forEach(b => b.onclick = e => { e.preventDefault(); const [tab, n] = b.dataset.goto.split(':'); view.tab = tab; render(); if (n) openPull(+n); });
  const refBtn = $('#btn-refs');
  if (refBtn) refBtn.onclick = () => loadRefs($('#ref-links').value);
  const copy = $('#btn-copy');
  if (copy) copy.onclick = () => openDiscordExport();
  if (view.tab === 'tally') bindTally();
}

/** The Discord export dialog: team recap or one note per player, each part with its own Copy button. */
function openDiscordExport() {
  const dlg = $('#discord');
  const pageUrl = location.protocol.startsWith('http') && !/^(localhost|127\.)/.test(location.hostname) ? `${location.origin}${location.pathname}` : null;
  const phaseLabel = view.phase === '' ? '' : phaseShort(plan.phases[+view.phase]?.name).trim();
  const block = (title, text) => `<div class="dx-part"><div class="row"><b class="small">${esc(title)}</b><span class="muted small">${text.length.toLocaleString()} / 2,000</span><button type="button" class="ghost small-btn dx-copy">Copy</button></div><pre class="dx-text">${esc(text)}</pre></div>`;
  const draw = () => {
    const mode = dlg.querySelector('input[name="dx-mode"]:checked').value;
    $('#dx-names-wrap').style.display = mode === 'team' ? '' : 'none';
    let html;
    if (mode === 'team') {
      const parts = teamRecap(result, { names: $('#dx-names').checked, url: pageUrl, phaseLabel });
      html = parts.map((t, i) => block(parts.length > 1 ? `Message ${i + 1} of ${parts.length}` : 'Message', t)).join('');
    } else {
      const notes = playerNotes(result, { url: pageUrl, phaseLabel }).filter(n => forPlayer(n.player.name));
      html = notes.map(n => `<h3>${esc(n.player.name)}</h3>` + n.parts.map((t, i) => block(n.parts.length > 1 ? `DM ${i + 1} of ${n.parts.length}` : 'DM', t)).join('')).join('');
    }
    $('#dx-out').innerHTML = html;
    $('#dx-out').querySelectorAll('.dx-copy').forEach(b => b.onclick = async () => {
      await navigator.clipboard.writeText(b.closest('.dx-part').querySelector('.dx-text').textContent);
      b.textContent = 'Copied ✓';
    });
  };
  dlg.querySelectorAll('input[name="dx-mode"]').forEach(r => r.onchange = draw);
  $('#dx-names').onchange = draw;
  draw();
  dlg.showModal();
}
function openPull(n) {
  const d = document.querySelector(`details.pull[data-n="${n}"]`);
  if (d) { d.open = true; d.scrollIntoView({ block: 'start' }); }
}
const pullLink = n => `<a href="#" data-goto="pulls:${n}">#${n}</a>`;
const pullLinks = (ns, max = 12) => ns.slice(0, max).map(pullLink).join(', ') + (ns.length > max ? ` +${ns.length - max} more` : '');

// ---------- Summary ----------
function findings() {
  const r = result, out = [];
  const total = r.pulls.length;
  // Say so when a finding rests on a mechanic that was matched by timing, or had no hit found at all.
  const caveat = keys => {
    const ks = [...new Set((keys || []).filter(Boolean))];
    const tm = ks.filter(k => r.rowAbility[k] && !r.rowAbility[k].byName)
      .map(k => `${r.mechanics.find(m => m.key === k)?.mechanic || k} → ${r.rowAbility[k].name}`);
    const none = ks.filter(k => !r.rowAbility[k]).map(k => r.mechanics.find(m => m.key === k)?.mechanic).filter(Boolean);
    return (tm.length ? ` Note: ${tm.join(', ')} ${tm.length > 1 ? 'were' : 'was'} matched by timing, not by name; check the mapping on the "How it works" tab.` : '')
      + (none.length ? ` Note: no hit was found for ${none.join(', ')}, so ${none.length > 1 ? 'those are' : 'that is'} judged on the sheet time.` : '');
  };
  const rowKeyOf = refKey => refKey ? refKey.split('|').slice(0, 2).join('|') : null;

  // Where the first death happens (not necessarily where the pull ended).
  r.causes.slice(0, 3).forEach((c, i) => {
    const cats = Object.entries(c.cats).sort((a, b) => b[1] - a[1]);
    const later = c.pulls.filter(n => (r.pulls.find(p => p.n === n)?.phase ?? -1) > c.phase).length;
    const tie = r.causes[i + 1] && r.causes[i + 1].count === c.count ? ' (tied)' : '';
    out.push({
      kind: 'wall', title: `${i === 0 ? 'Most common first death' : 'Also a common first death'}${tie}: ${c.cause}`,
      text: `${c.count} of ${total} pulls had their first death here${later ? ` (${later} of them still reached a later phase)` : ''}. Likely causes of those first deaths: ${cats.map(([k, v]) => `${k.toLowerCase()} ×${v}`).join(', ')}.`,
      pulls: c.pulls, weight: c.count,
    });
  });

  // Where pulls really ended, apart from where their first death was: pulls that recovered and got close to
  // pushing a phase (FFLogs' boss HP left at the wipe).
  const close = r.pulls.filter(p => !p.kill && p.endedAt?.bossPct != null && p.endedAt.bossPct <= 10)
    .sort((a, b) => b.endedAt.phase - a.endedAt.phase || a.endedAt.bossPct - b.endedAt.bossPct);
  if (close.length) {
    const line = p => `#${p.n} ${phaseShort(p.endedAt.phaseName)} with ${p.endedAt.bossPct.toFixed(1)}% left${p.endedAt.recovered && p.first ? ` (first death earlier, in ${phaseShort(p.first.phaseName)}; the pull recovered)` : ''}`;
    out.push({
      kind: 'close', title: `Closest to pushing: ${close.slice(0, 3).map(p => `#${p.n} (${p.endedAt.bossPct.toFixed(1)}% left)`).join(', ')}`,
      text: `${close.slice(0, 5).map(line).join('; ')}. Boss HP left is FFLogs' figure at the wipe. These pulls are filed under where their first death was in "Most common first death"; here they're listed by where they actually ended.`,
      pulls: close.map(p => p.n), weight: total, // shown near the top: progress matters most in prog
    });
  }

  // Players often standing outside the healers' / mitigators' radius when a party-wide action went out.
  r.perPlayer.filter(s => s.outOfRange >= 5).sort((a, b) => b.outOfRange - a.outOfRange).forEach(s => {
    const by = Object.entries(s.outOfRangeBy).sort((a, b) => b[1] - a[1]);
    out.push({
      kind: 'range', player: s.player.name,
      title: `Often out of range of party heals and shields: ${s.player.name} (${s.outOfRange} times)`,
      text: `${s.player.name} was alive but more than 1y outside the official radius of ${by.map(([k, v]) => `${k} ×${v}`).join(', ')} when it was pressed, and didn't get it. Positions are FFLogs' logged positions; see the Players table on the Summary.`,
      pulls: [...new Set(r.pulls.filter(p => (p.rangeMisses || []).some(x => x.player.name === s.player.name)).map(p => p.n))],
      weight: s.outOfRange,
    });
  });

  // Carry-overs: the press was up for the first hit but didn't last.
  const firstName = c => c.linkNames[0].replace(/ \([^)]*\)$/, '');
  const clearsChain = c => {
    const R = r.reference;
    return R ? R.chains.find(y => y.key === `${c.phase}|${c.key.split('|')[2]}|${c.slot}|${c.label.startsWith('Party Mit') ? 'Party Mit' : c.label}`) || null : null;
  };
  const weak = r.chains.filter(c => c.full >= 3 && c.held / c.full < 0.5 && c.impossible < c.full / 2 && (c.linkOk[0] || 0) >= c.full * 0.5);
  const byBreak = {};
  weak.forEach(c => { const [b] = Object.entries(c.broke).sort((a, x) => x[1] - a[1])[0] || []; if (b) (byBreak[`${c.phase}|${c.linkNames[0]}|${b}`] ||= []).push(c); });
  const grouped = new Set();
  Object.values(byBreak).filter(g => g.length >= 3).forEach(g => {
    g.forEach(c => grouped.add(c));
    const [b] = Object.entries(g[0].broke).sort((a, x) => x[1] - a[1])[0];
    const pullsAll = [...new Set(g.flatMap(c => c.pulls))].sort((a, x) => a - x);
    const cl = g.map(clearsChain).filter(x => x && x.ref.n);
    const clearsText = cl.length ? ` The clears hold these too: ${cl.map(x => `${x.label} ${x.ref.held}/${x.ref.n}`).join(', ')}${cl.every(x => x.ref.n >= 4 && x.ref.held / x.ref.n <= 1 / 3) ? ', i.e. they mostly don\'t either: the sheet\'s spacing is the issue, not pressing.' : '.'}` : '';
    out.push({
      kind: 'carry', title: `${g.length} players' carry-overs from ${g[0].linkNames[0]} break at the same hit`,
      text: `All break the same way (${b}): ${g.map(c => `${c.player.name.split(' ')[0]}'s ${c.label} (${c.info.sec}s, held ${c.held}/${c.full}, pressed ${c.medOffset != null ? Math.abs(c.medOffset).toFixed(1) + 's' : '?'} before, median of ${c.offsets?.length ?? '?'})`).join(', ')}. `
        + `Since it's several players at once, it's about when the group presses or the sheet's spacing, not one player.` + clearsText + caveat(g[0].linkKeys),
      pulls: pullsAll, weight: pullsAll.length,
    });
  });
  weak.filter(c => !grouped.has(c)).slice(0, 4).forEach(c => {
    const x = clearsChain(c);
    const sheetIssue = x && x.ref.n >= 4 && x.ref.held / x.ref.n <= 1 / 3;
    const broke = Object.entries(c.broke).sort((a, b) => b[1] - a[1]);
    const need = c.medWindowFrom != null ? Math.abs(c.medWindowFrom) : null;
    const lastName = c.linkNames.at(-1).replace(/ \([^)]*\)$/, '');
    // A shield that's absorbed by an earlier hit can't carry on, whenever it's pressed: not a press-timing issue.
    const usedUp = broke[0] && broke[0][0].includes(STATUS_TEXT['used-up']) && broke[0][1] >= (c.full - c.held) / 2;
    const parts = [`Didn't last every planned hit in ${c.full - c.held} of ${c.full} pulls: ${broke.map(([k, v]) => `${k} ×${v}`).join('; ')}.`];
    if (c.medOffset != null) parts.push(`Pressed ${Math.abs(c.medOffset).toFixed(1)}s before ${firstName(c)} (median of ${c.offsets.length}).`);
    if (usedUp) parts.push(`A shield comes off once it has absorbed its full amount, so pressing earlier or later wouldn't keep it for ${broke[0][0].split(':')[0]}: the earlier hit uses it up. That's a question for the sheet (it expects the shield to survive), not a missed press.`);
    else if (need != null) parts.push(`To last through ${lastName} it has to go out in the last ${need.toFixed(1)}s before ${firstName(c)} (${c.info.name} lasts ${c.info.sec}s per the Job Guide).`);
    if (x && x.ref.n) parts.push(`Reference clears with this job: lasted every hit in ${x.ref.held} of ${x.ref.n}${x.ref.n < 4 ? ' (too few to judge)' : ''}${x.refOffset != null ? `, pressed ${Math.abs(x.refOffset).toFixed(1)}s before (median)` : ''}.`);
    out.push({
      kind: 'carry',
      title: usedUp ? `Shield used up before its planned carry-over: ${c.label} (${c.linkNames[0]}), ${c.slot}`
        : sheetIssue ? `Sheet carry-over the clears don't hold either: ${c.label} (${c.linkNames[0]}), ${c.slot}` : `Carry-over not lasting: ${c.player.name}'s ${c.label} (${c.linkNames[0]})`,
      text: parts.join(' ') + caveat(c.linkKeys),
      pulls: c.pulls, player: sheetIssue || usedUp ? null : c.player.name, weight: c.pulls.length / (sheetIssue || usedUp ? 3 : 1),
    });
  });

  // Planned mits that were often not up (not counting assignments the static clearly plays differently).
  r.misses.filter(m => !m.differentPlan && !/carried over/.test(m.label) && m.bad >= 3 && m.bad / m.total >= 0.5).slice(0, 6).forEach(m => {
    const top = Object.entries(m.counts).filter(([s]) => BAD.includes(s)).sort((a, b) => b[1] - a[1])[0];
    const never = (m.counts.missing || 0) === m.total && m.total >= 5;
    const used = m.usedForTop ? (m.usedForTop.n >= Math.max(2, m.bad / 2) ? ` Usually used for ${m.usedForTop.where} instead (${m.usedForTop.n}×).` : ` Once or twice used for ${m.usedForTop.where} instead.`) : '';
    out.push({
      kind: 'mit', title: `${never ? 'Never pressed for this mechanic' : 'Planned mit often not up'}: ${m.player.name} — ${m.label} for ${m.mechanic}`,
      text: `Not up in ${m.bad} of ${m.total} pulls that reached it (mostly: ${STATUS_TEXT[top[0]]}).${used}${never ? ' Not pressed in any pull: more likely a plan or assignment difference than forgetting; confirm with the player before treating it as a miss.' : ''}${clearsNote(m)}` + caveat([rowKeyOf(m.refKey)]),
      pulls: m.pulls, player: m.player.name, weight: m.pulls.length,
    });
  });

  // Compared with the reference clears: damage prevented (mits + shields), plan-independent.
  for (const m of refGaps().slice(0, 3)) {
    const usable = m.missing.filter(x => !notInComp(x.status));
    out.push({
      kind: 'ref', title: `Less damage prevented than the clears at ${m.mechanic} (${phaseShort(m.phaseName).trim()} ${fmt(m.sheet * 1000)})`,
      text: `Mits and shields together kept ${pctf(m.you.prevented)} of the raw damage off in your pulls vs ${pctf(m.ref.prevented)} in the clears (all hits pooled; mits ${pctf(m.you.mitigated)} vs ${pctf(m.ref.mitigated)}, shields ${pctf(m.you.shielded)} vs ${pctf(m.ref.shielded)}; ${m.you.n} of your pulls, ${m.ref.n} clears).`
        + (usable.length ? ` Most clears had ${usable.map(x => `${x.status} (${Math.round(x.ref * 100)}% of clears, ${Math.round(x.you * 100)}% of yours)`).join(', ')} applied to the hit.` : '') + caveat([m.key]),
      pulls: [], weight: m.you.n / 2,
    });
  }
  // Sorted by how many pulls each one affects.
  return out.sort((a, b) => b.weight - a.weight);
}

const pctf = v => v == null ? '—' : `${Math.round(v * 100)}%`;
/** Job abbreviation if a status comes from a job your comp doesn't have (e.g. Temperance → WHM), else ''. */
function notInComp(status) {
  const action = Object.entries(CATALOG).find(([, c]) => c.statuses.includes(status))?.[0];
  const job = action && JOB_GUIDE[action]?.job;
  if (!job || ['Reprisal', 'Feint', 'Addle'].includes(action)) return '';
  const have = new Set(result.players.map(p => p.job.toLowerCase()));
  return have.has(job) ? '' : (JOB_ABBR[Object.keys(JOB_ABBR).find(k => k.toLowerCase() === job)] || job);
}
/** Marks a mechanic matched to a logged hit by timing only (no ability with the sheet's name). */
const timingTag = key => { const ra = result.rowAbility?.[key]; return ra && !ra.byName ? ` <span class="warn small" data-tip="${esc(`No logged ability has this name; matched to ${ra.name} by timing.`)}">≈ ${esc(ra.name)}</span>` : ''; };
/**
 * What the reference clears did at the same sheet entry: tells a sheet/plan issue apart from a player mistake.
 * Carried-over entries are compared on the Carry-overs tab instead (clears often press fresh rather than carry).
 * Fewer than 4 clears with that job is too few to call it either way.
 */
const clearsAt = m => /carried over/.test(m.label) ? null : result.reference?.cellMap?.[m.refKey] || null;
function clearsCell(m) {
  if (/carried over/.test(m.label)) return '<span class="muted">see Carry-overs</span>';
  const c = clearsAt(m);
  if (!c) return '<span class="muted">—</span>';
  const r = c.ok / c.n;
  const tag = c.n < 4 ? '<br><span class="muted">too few clears with this job to judge</span>'
    : r <= 1 / 3 ? '<br><span class="muted">clears mostly skip it too: likely a plan/sheet issue</span>'
    : r >= 2 / 3 ? '<br><span class="warn">clears mostly do this</span>' : '';
  return `${c.ok} of ${c.n} clears had it up${tag}`;
}
function clearsNote(m) {
  const c = clearsAt(m);
  if (!c) return '';
  if (c.n < 4) return ` Only ${c.n} reference clear${c.n === 1 ? '' : 's'} have this job here (${c.ok} had it up): too few to compare.`;
  if (c.ok / c.n <= 1 / 3) return ` Only ${c.ok} of ${c.n} reference clears have it up here either, so this is likely a sheet/plan issue rather than a player mistake.`;
  if (c.ok / c.n >= 2 / 3) return ` ${c.ok} of ${c.n} reference clears have it up here.`;
  return ` Reference clears are split (${c.ok} of ${c.n}).`;
}
/** Mechanics where your pulls prevent clearly less damage (mits + shields) than the clears (≥8 points, ≥3 pulls). */
function refGaps() {
  const R = result.reference;
  if (!R) return [];
  return R.mechanics.filter(m => m.ref && m.you && m.you.n >= 3 && m.ref.prevented != null && m.you.prevented != null && m.ref.prevented - m.you.prevented >= 0.08)
    .sort((a, b) => (b.ref.prevented - b.you.prevented) * b.you.n - (a.ref.prevented - a.you.prevented) * a.you.n);
}

/** Plain-text summary for Discord. Carries its own caveats, since it's read without the page. */
function summaryText() {
  const lines = [`UMAD wipe review — ${result.pulls.length} pulls`, ''];
  for (const f of findings()) {
    const more = f.pulls?.length > 15 ? ` +${f.pulls.length - 15} more` : '';
    lines.push(`• ${f.title}\n  ${f.text}${f.pulls?.length ? `\n  Pulls: ${f.pulls.slice(0, 15).join(', ')}${more}` : ''}`);
  }
  lines.push('', 'How to read this: mit verdicts and numbers come from the FFLogs log and the official Job Guide. Death causes are likely explanations, not verdicts: check the replay before raising anything with a player. Plan differences and sheet issues are called out as such.');
  if (location.protocol.startsWith('http')) lines.push(`Full evidence: ${location.origin}${location.pathname}`);
  return lines.join('\n');
}

const TABS = {
  summary() {
    const { pulls } = result;
    const wipes = pulls.filter(p => !p.kill);
    const best = [...pulls].sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0))[0];
    const items = pulls.flatMap(p => p.rows.flatMap(r => r.items)).filter(i => !['dead', 'unaffected', 'conflict'].includes(i.status));
    const upCount = items.filter(i => ['ok', 'other', 'used-up'].includes(i.status)).length;
    const chainsDone = result.chains.reduce((a, c) => a + c.full, 0), chainsHeld = result.chains.reduce((a, c) => a + c.held, 0);
    const deathsPer = pulls.length ? (pulls.reduce((s, p) => s + p.deaths.filter(d => !d.wipeOut).length, 0) / pulls.length).toFixed(1) : '0';
    const f = findings().filter(x => !view.player || !x.player || x.player === view.player);
    const phaseLabel = view.phase === '' ? '' : phaseShort(plan.phases[+view.phase]?.name);
    return `
    ${view.phase === '' ? phaseOverview() : `<p class="banner">Showing <b>${esc(phaseLabel)}</b> only: pulls that reached it, with just its mechanics, deaths and carry-overs. A pull counts under "Where pulls end" only if its wipe started in this phase. <a href="#" data-phase="">Show all phases</a></p>`}
    <div class="tiles">
      <div class="tile"><div class="k">${view.phase === '' ? 'Pulls' : `Pulls that reached ${esc(phaseLabel)}`}</div><div class="v">${pulls.length}</div><div class="d">${pulls.filter(p => p.kill).length} clears · ${deathsPer} deaths/pull before the wipe-out</div></div>
      <div class="tile"><div class="k">Best pull</div><div class="v">${best ? esc(phaseShort(best.phaseName)) : '—'}</div><div class="d">${best ? `${pullLink(best.n)}, ${best.fightPct ?? '?'}% of the fight left` : ''}</div></div>
      <div class="tile"><div class="k">Planned mits up when the hit landed</div><div class="v">${pct(upCount, items.length)}%</div><div class="d">${upCount} of ${items.length} checks (from the statuses in the log)</div></div>
      <div class="tile"><div class="k">Carry-overs that lasted every hit</div><div class="v">${pct(chainsHeld, chainsDone)}%</div><div class="d">${chainsHeld} of ${chainsDone} full chains</div></div>
    </div>

    <section class="card">
      <div class="card-head"><h2>What to work on</h2><button id="btn-copy" class="ghost small-btn">Discord export</button></div>
      <p class="muted small">Sorted by how many pulls each affects. Death causes are likely explanations, not verdicts. Each point lists the pulls; open them in the Pulls tab to see the evidence (log entries, official durations, and the math).</p>
      ${f.length ? `<ol class="findings">${f.map(x => `<li><b>${esc(x.title)}</b><br>${esc(x.text)}${x.pulls?.length ? `<div class="small muted">Pulls: ${pullLinks(x.pulls)}</div>` : ''}</li>`).join('')}</ol>` : '<p class="empty">Nothing stands out.</p>'}
    </section>

    <section class="card">
      <div class="card-head"><h2>Progress per pull</h2><span class="muted small">bar height = % of the fight cleared; hover for why it ended</span></div>
      ${progressChart(pulls)}
    </section>

    <section class="card">
      <h2>Where the first death happens</h2>
      <p class="muted small">Grouped by the sheet mechanic nearest the first death of each pull (some pulls recovered and ended later). The breakdown is the likely type of death; see the Deaths tab for the evidence.</p>
      ${result.causes.length ? `<div class="bars">${result.causes.slice(0, 12).map(c => causeBar(c, result.causes[0].count)).join('')}</div>` : '<p class="empty">No wipes.</p>'}
    </section>

    <section class="card">
      <h2>Players</h2>
      ${playersTable()}
    </section>`;
  },

  mechanics() {
    const ms = result.mechanics;
    return `<section class="card">
      <h2>Every mechanic on the sheet</h2>
      <p class="muted small">How each mechanic went across all pulls that reached it. "Matched to" is the logged ability we treat as that mechanic: check it if a number looks off.</p>
      <table><thead><tr><th>Mechanic</th><th class="num">Reached</th><th class="num">Deaths</th><th class="num">First death of the pull</th><th class="num">Mits up</th><th class="num">Damage per player<br><span class="muted">taken / before mit</span></th><th>Matched to (log)</th></tr></thead><tbody>
      ${ms.map(m => {
        const it = m.items, all = Object.entries(it).filter(([s]) => !['dead', 'unaffected', 'conflict'].includes(s)).reduce((a, [, v]) => a + v, 0);
        const up = (it.ok || 0) + (it.other || 0) + (it['used-up'] || 0);
        const [ab, abN] = Object.entries(m.abilities).sort((a, b) => b[1] - a[1])[0] || ['—', 0];
        const est = m.how.estimated || 0;
        return `<tr><td><span class="phase-dot" style="background:${PHASE_COLOR(m.phase)}"></span>${esc(phaseShort(m.phaseName))} · <b>${esc(m.mechanic)}</b> <span class="muted">${sheetClock(m.sheet, m.total, m.clock)}</span></td>
          <td class="num">${m.reached}</td><td class="num">${m.deaths || ''}</td><td class="num">${m.firsts ? `<b>${m.firsts}</b>` : ''}</td>
          <td class="num">${all ? `${pct(up, all)}% <span class="muted">(${up}/${all})</span>` : '—'}</td>
          <td class="num">${m.medTaken != null ? `${num(m.medTaken)} / ${num(m.medUnmit)}` : '—'}</td>
          <td class="small">${esc(ab)}${m.types?.[ab] ? ` <span class="muted">(${esc(m.types[ab])})</span>` : ''}${m.ignores?.[ab] ? ` <span class="warn" data-tip="On all ${m.ignores[ab].withMit} snapshots in the report with a mit listed, the game's damage multiplier was 1.00: mits can't change this hit.">ignores mitigation</span>` : ''}${abN < m.reached ? ` <span class="muted">(${abN}/${m.reached})</span>` : ''}${est ? ` <span class="warn" data-tip="No hit found near the sheet time in ${est} pull(s); those use the sheet time and are judged by press timing only.">${est} estimated</span>` : ''}</td></tr>`;
      }).join('')}</tbody></table></section>${diedVsLivedCard(ms.filter(m => m.diedVsLived))}`;
  },

  carry() {
    const list = result.chains.filter(c => forPlayer(c.player.name));
    return `<section class="card">
      <h2>Carry-overs (➔ on the sheet)</h2>
      <p class="muted small">A ➔ on the sheet means one press is meant to cover several hits. Each row is one press and the hits it should last through. Every dot is one hit: green means the status was on the players when it landed (read from the log).
      The press window is the latest hit minus the official duration, up to the first hit.</p>
      ${list.length ? `<table><thead><tr><th>Who · what</th><th>Should cover (in order)</th><th class="num">Lasted every hit</th><th>Timing (median)</th><th>Where it breaks</th></tr></thead><tbody>
      ${list.map(c => {
        const rate = c.full ? `${c.held}/${c.full}` : '—';
        const broke = Object.entries(c.broke).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${esc(k)} ×${v}`).join('<br>');
        const timing = c.medOffset != null
          ? `pressed ${Math.abs(c.medOffset).toFixed(1)}s before the first hit${c.medWindowFrom != null ? (c.medWindowFrom > 0 ? `<br><span class="warn">one press can't cover it (${c.info.sec}s)</span>` : `<br><span class="muted">window: last ${Math.abs(c.medWindowFrom).toFixed(1)}s before</span>`) : ''}` : '—';
        return `<tr><td><b>${esc(c.player.name)}</b> <span class="muted">${esc(c.slot)}</span><br>${esc(c.label)} <span class="muted small" data-tip="${esc(`${c.info.name}: ${c.info.sec}s (${'Job Guide, Patch ' + JOB_GUIDE_PATCH})`)}">${c.info.sec ?? '?'}s</span></td>
          <td>${c.linkNames.map((n, i) => `<div class="link">${dot(c.linkOk[i], c.linkSeen[i])} ${esc(n)} <span class="muted small">${c.linkOk[i] || 0}/${c.linkSeen[i] || 0}</span></div>`).join('')}</td>
          <td class="num">${c.full ? `<b>${rate}</b>` : '<span class="muted">never reached all</span>'}</td>
          <td class="small">${timing}</td><td class="small">${broke || '—'}${c.pulls.length ? `<br><span class="muted">Pulls ${pullLinks(c.pulls, 6)}</span>` : ''}</td></tr>`;
      }).join('')}</tbody></table>` : '<p class="empty">No carry-overs reached.</p>'}
    </section>`;
  },

  mits() {
    const list = result.misses.filter(m => forPlayer(m.player.name));
    const mistakes = list.filter(m => !m.differentPlan), plan = list.filter(m => m.differentPlan);
    return `<section class="card">
      <h2>Planned mits that weren't up</h2>
      <div class="key">${['ok', 'other', 'used-up', 'unaffected', 'late', 'expired', 'range', 'overwritten', 'missing', 'cooldown'].map(s => chip(s, STATUS_SHORT[s], STATUS_TEXT[s])).join('')}</div>
      <p class="muted small">"Up" is read from the log: the status was on the players (or Reprisal/Feint/Addle on the boss) when the hit landed. Timing is when it was pressed relative to the hit (− = before).</p>
      ${mistakes.length ? missTable(mistakes, 40) : '<p class="empty">None.</p>'}
      ${plan.length ? `<details class="sub"><summary><b>${plan.length} assignments your static does differently from the sheet</b> <span class="muted small">(almost never on the sheet's timing, but consistently pressed for another mechanic)</span></summary>
        <p class="muted small">Probably a deliberate change to the plan. These are left out of the death explanations.</p>${missTable(plan, 200)}</details>` : ''}
    </section>`;
  },

  deaths() {
    const ds = result.pulls.flatMap(p => p.deaths.filter(d => !d.wipeOut && forPlayer(d.player.name)).map(d => ({ p, d })));
    const cats = {};
    ds.forEach(({ d }) => { cats[d.category] = (cats[d.category] || 0) + 1; });
    return `<section class="card">
      <h2>Deaths before the wipe-out (${ds.length})</h2>
      <p class="muted small">Deaths after 4+ players were already down are left out. Each death lists what the log shows; the category is the likely explanation, with a confidence level.</p>
      <div class="key">${Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="chip cat">${esc(k)} ×${v}</span>`).join('')}</div>
      ${ds.slice().reverse().map(({ p, d }) => deathCard(p, d)).join('')}
    </section>`;
  },

  pulls() {
    return `<section class="card">
      <h2>Every pull</h2>
      <p class="muted small">Open a pull for its deaths, the mit check at every mechanic it reached, and its carry-overs.</p>
      ${result.pulls.slice().reverse().map(pullDetails).join('')}
    </section>`;
  },

  tally() {
    const R = fullResult || { demo: false, players: [], pulls: [] }; // no report loaded: shared tally only
    const L = R.demo ? demoLedger : ledger;
    const all = Object.values(L);
    const codes = new Set(loaded.map(e => e.report.code));
    const here = all.filter(e => codes.has(e.report)).sort((a, b) => a.abs - b.abs);
    const ps = periods(view.tallyKind, Date.now(), 6);
    const rows = tally(all, view.tallyMode, ps).filter(r => forPlayer(r.player));
    const names = R.players.length ? R.players.map(p => p.name) : [...new Set(all.map(e => e.player))].sort();
    const reports = new Set(all.map(e => e.report));
    const pullN = new Map(R.pulls.map(p => [`${p.reportCode}:${p.id}`, p.n]));
    const deathTxt = e => `#${pullN.get(`${e.report}:${e.fight}`) ?? '?'} · ${esc(phaseShort(e.phaseName))} ${fmt(e.pullT)} into pull · <b>${esc(e.player)}</b> — ${esc(e.mechanic)} <span class="muted">(${esc(e.category)})</span>`;
    const deathOpt = e => `#${pullN.get(`${e.report}:${e.fight}`) ?? '?'} · ${phaseShort(e.phaseName)} ${fmt(e.pullT)} · ${e.ability || e.mechanic}${e.wipeOut ? ' (wipe-out)' : ''}`;
    const callouts = calloutRows ? `<table><thead><tr><th>Callout</th><th>Matched to (log)</th><th>Counted against</th></tr></thead><tbody>
      ${calloutRows.map((r, ri) => `<tr><td>${esc(r.text)}</td>
        <td class="small">${!r.victims.length ? '<span class="muted">Doesn\'t start with a name from these pulls: kept as a party note, not counted against anyone.</span>'
          : r.matched.map((m, vi) => `<select class="pick" data-pick="${ri}:${vi}">${m.death ? '' : `<option value="" selected>${m.guess ? `— pick (guess: ${esc(deathOpt(m.guess))}) —` : '— pick —'}</option>`}
              ${here.filter(e => e.player === m.victim).map(e => `<option value="${esc(e.key)}" ${m.death?.key === e.key ? 'selected' : ''}>${esc(deathOpt(e))}</option>`).join('')}</select>
            ${m.death ? (m.manual ? '<span class="muted">picked</span>' : `<span class="muted">pull #${r.pull}</span>`)
              : r.pull != null ? `<span class="warn">${esc(m.victim)} didn't die in pull #${r.pull}.</span>`
              : '<span class="warn" data-tip="No pull number in the line, so the log can only guess (in a wipe or reset everyone dies). Add #N to the line, or pick the death.">not counted: add #pull or pick</span>'}`).join('<br>')}</td>
        <td>${r.matched.some(m => m.death) ? esc(r.blame || r.matched.filter(m => m.death).map(m => m.victim).join(', ')) : '<span class="muted">nobody yet</span>'}</td></tr>`).join('')}</tbody></table>` : '';
    const online = cloud.cloudOn() && !R.demo;
    const pending = online ? unsynced().length : 0;
    const onlineBar = !online ? '' : `<p class="banner"><b>Online death tally</b> · private to your FFLogs account${me?.name ? ` (${esc(me.name)})` : ''}: nobody else can see or change it.${pending ? ` Saving ${pending}…` : ''}</p>`;
    return `${onlineBar}${loaded.length ? `<section class="card">
      <h2>Raid callouts</h2>
      <p class="muted small">Paste the night's death notes, one per line, in the order they happened, e.g. <code>Arune - Forsaken - Stack not there</code>, <code>Calerie + Arune died to statue</code>, <code>Alistar died due to Ryujin no feint</code>.
      <b>Start each line with the pull number</b> as shown on the Pulls tab, e.g. <code>#7 Arune - Forsaken - stack not there</code> (also <code>Pull 7:</code>): it then counts against that player's death in that pull.
      A line without a pull number only gets a guess and counts against nobody until you pick the death: in a wipe or reset everyone dies, so the log alone can't tell whose mistake it was.
      A counted death is a mechanical death against the player who died, or against the name after "due to" / "because of". Lines that don't start with a player name are party notes.</p>
      <textarea id="callouts" rows="6" placeholder="#7 Arune - Forsaken - Stack not there">${esc(store.get('callouts', ''))}</textarea>
      <details class="sub"><summary class="small"><b>Your names for mechanics</b> <span class="muted">(nickname = words in the logged ability, sheet mechanic or phase)</span></summary>
        <p class="muted small">One per line. Left of "=": words your callouts use, comma-separated. Right: words that appear in the log for that mechanic. "8th tower" always means the sheet's Towers VIII.</p>
        <textarea id="nicknames" rows="6">${esc(store.get('nicknames', DEFAULT_NICKNAMES))}</textarea></details>
      <div class="row"><button id="btn-callouts" class="primary">Match to deaths</button><span class="muted small">Re-matching replaces the earlier callouts for these reports.</span></div>
      ${callouts}
    </section>` : ''}

    <section class="card">
      <div class="card-head"><h2>Death tally</h2>
        <div class="row" style="margin:0">
          <label class="inline">Count <select id="tally-mode"><option value="mech" ${view.tallyMode === 'mech' ? 'selected' : ''}>Mechanical deaths (by who's responsible)</option><option value="all" ${view.tallyMode === 'all' ? 'selected' : ''}>All deaths before the wipe-out (by who died)</option></select></label>
          <label class="inline">By <select id="tally-kind"><option value="week" ${view.tallyKind === 'week' ? 'selected' : ''}>Raid week</option><option value="month" ${view.tallyKind === 'month' ? 'selected' : ''}>Month</option></select></label>
        </div></div>
      <p class="muted small">${online ? 'Every report saved to your online tally' : 'Every report analyzed in this browser'} (${all.length} deaths from ${reports.size} report${reports.size === 1 ? '' : 's'}${R.demo ? ', demo data: not saved' : ''}). Raid weeks start at the weekly reset, Tuesday 08:00 UTC. ${view.tallyMode === 'mech'
        ? 'Mechanical = a raid callout matched it, someone ticked it below, or the log analysis called it "Mechanic fail" / "Short stack/tower" (not a wipe-out death).' : 'Deaths after 4+ players were already down are left out unless a callout names them.'}</p>
      ${rows.length ? `<table><thead><tr><th>Player</th>${ps.map(p => `<th class="num">${esc(p.label)}</th>`).join('')}<th class="num">All time</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td>${esc(r.player)} <span class="muted">${JOB_ABBR[r.job] || ''}</span></td>${r.per.map((v, i) => `<td class="num">${v ? (i === 0 ? `<b>${v}</b>` : v) : '<span class="muted">0</span>'}</td>`).join('')}<td class="num">${r.total}</td></tr>`).join('')}
      </tbody></table>` : '<p class="empty">Nothing counted yet.</p>'}
      <div class="row"><button id="btn-ledger-export" class="ghost">Export tally (JSON)</button>
        <label class="ghost-file"><input type="file" id="ledger-import" accept=".json,application/json" hidden><span class="btn-like">Import tally</span></label>
        <button id="btn-ledger-clear" class="ghost">Clear tally</button>
        <span class="muted small">${online ? 'Export keeps a backup copy.' : 'Saved in this browser only: export it to move it or share it.'}</span></div>
    </section>

    ${loaded.length ? `<section class="card">
      <h2>Deaths in these pulls (${here.filter(e => forPlayer(e.player) || forPlayer(e.blame)).length})</h2>
      <p class="muted small">Change the callout, who it counts against, or whether it was mechanical. Changes are saved straight away.</p>
      <table><thead><tr><th>Death (log)</th><th>Callout</th><th>Counts against</th><th>Mechanical</th></tr></thead><tbody>
      ${here.filter(e => forPlayer(e.player) || forPlayer(e.blame)).map(e => `<tr${e.wipeOut && !counts(e, 'all') ? ' class="muted"' : ''}>
        <td class="small">${deathTxt(e)}${e.wipeOut ? ' <span class="chip cat">wipe-out</span>' : ''}</td>
        <td><input data-note="${esc(e.key)}" value="${esc(e.note)}" style="width:100%" placeholder="—"></td>
        <td><select data-blame="${esc(e.key)}"><option value="">nobody</option>${names.map(n => `<option ${e.blame === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></td>
        <td><input type="checkbox" data-mech="${esc(e.key)}" ${e.mech ? 'checked' : ''}> <span class="muted small">${e.src === 'callout' ? 'callout' : e.src === 'edit' ? 'edited' : 'auto'}</span></td></tr>`).join('')}
      </tbody></table>
    </section>` : ''}`;
  },

  reference() {
    const R = result.reference;
    const input = `<section class="card">
      <h2>Reference clears</h2>
      <p class="muted small">Paste FFLogs links to clears, each with its fight number (…/reports/CODE?fight=25). They're compared with each mit sheet and with your pulls.
      Clears may run a different mit plan (e.g. LPDU); the page tells those apart instead of treating them as mistakes.</p>
      <textarea id="ref-links" rows="4">${esc(store.get('refs', DEFAULT_REFS))}</textarea>
      <div class="row"><button id="btn-refs" class="primary">Load reference clears</button><span class="muted small">${refLoaded.length ? `${refLoaded.length} loaded` : 'Not loaded yet'}</span></div>
    </section>`;
    if (!R) return input;
    const ourJobs = new Set(result.players.map(p => p.job.toLowerCase()));
    const jobOfStatus = s => { const a = Object.entries(CATALOG).find(([, c]) => c.statuses.includes(s))?.[0]; return a ? JOB_GUIDE[a]?.job : null; };
    const statusTag = (s) => { const j = jobOfStatus(s); return j && !['darkknight', 'paladin', 'warrior', 'gunbreaker'].includes(j) && !ourJobs.has(j) && !['Reprisal', 'Feint', 'Addle'].includes(s) ? ` <span class="muted small">(${esc(JOB_ABBR[Object.keys(JOB_ABBR).find(k => k.toLowerCase() === j)] || j)} only; not in your comp)</span>` : ''; };
    const dpts = (a, b, n = 3) => a == null || b == null || n < 3 ? '' : Math.round((b - a) * 100) === 0 ? ' <span class="muted small">±0</span>' : `<span class="${b - a >= 0.08 ? 'warn' : 'muted'} small"> ${b >= a ? '−' : '+'}${Math.abs(Math.round((b - a) * 100))} pts</span>`;
    const cellRows = list => list.map(x => {
      const how = Object.entries(x.how).sort((a, b) => b[1] - a[1]).map(([s, v]) => `${STATUS_SHORT[s] || s} ×${v}`).join(', ');
      const [uf, ufn] = Object.entries(x.usedFor).sort((a, b) => b[1] - a[1])[0] || [];
      return `<tr><td>${esc(phaseShort(x.phaseName))} · ${esc(x.mechanic)} <span class="muted">${sheetClock(x.sheet, x.total, x.clock)}</span>${timingTag(x.rowKey)}</td><td>${esc(x.slot)}</td><td>${esc(x.label)}${x.carry ? ' ➔' : ''}</td>
        <td class="num">${x.ok}/${x.n}</td><td class="small">${esc(how)}${uf ? `<br><span class="muted">used for ${esc(uf)} ×${ufn}</span>` : ''}</td></tr>`;
    }).join('');
    const cellTable = list => `<table><thead><tr><th>Mechanic</th><th>Column</th><th>Sheet says</th><th class="num">Clears doing it</th><th>What the others did</th></tr></thead><tbody>${cellRows(list)}</tbody></table>`;
    return `${input}
    <section class="card">
      <h2>The clears</h2>
      <p class="muted small">Each clear is scored against every preset sheet: the share of that sheet's checkable entries (for the clear's jobs) whose status was on the players when the hit landed, read from the clear's log.
      The sheets differ in detail (LPDU also lists single-target tank tools and heal timings), so <b>party mits</b> (party-wide mits and enemy debuffs only) is the fair comparison, and "Closest plan" uses it: the higher score, only if it beats the other by 5+ points and reaches 60%. "All entries" is shown for completeness.</p>
      ${R.ourScores ? `<p><b>Your static</b> (median over ${Object.values(R.ourScores)[0].n} pulls, only the mechanics each pull reached): ${Object.entries(R.ourScores).map(([k, s]) => `${esc(planName(k))} ${pctf(s.party)} party mits · ${pctf(s.all)} all entries`).join(' — ')}.</p>` : ''}
      <table><thead><tr><th>Clear</th><th>Comp</th><th class="num">Kill time</th><th class="num">Deaths</th>${Object.keys(PLANS).map(k => `<th class="num">${esc(planName(k))}<br><span class="muted">party mits · all entries</span></th>`).join('')}<th>By phase (${esc(planName(planKey))}, all)</th><th>Closest plan</th></tr></thead><tbody>
      ${R.clears.map((c, i) => {
        const scores = Object.keys(PLANS).map(k => ({ k, s: R.planScores?.[k]?.[i] }));
        const ranked = scores.filter(x => x.s?.party != null).sort((a, b) => b.s.party - a.s.party);
        const top = ranked[0], second = ranked[1];
        const closest = !top ? '—' : top.s.party < 0.6 ? 'Neither (own plan)' : second && top.s.party - second.s.party < 0.05 ? `Can't tell (${ranked.map(x => planName(x.k)).join(' ≈ ')})` : planName(top.k);
        return `<tr><td><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.label)} ↗</a></td>
        <td class="small">${c.players.map(p => JOB_ABBR[p.job]).join(' ')}</td><td class="num">${fmt(c.duration)}${c.kill ? '' : ' <span class="warn">(not a kill)</span>'}</td><td class="num">${c.deaths}</td>
        ${scores.map(x => `<td class="num">${x.s ? `${x.k === top?.k ? '<b>' : ''}${pctf(x.s.party)}${x.k === top?.k ? '</b>' : ''} <span class="muted small">of ${x.s.partyChecked}</span> · ${pctf(x.s.agreement)}` : '—'}</td>`).join('')}
        <td class="small">${Object.entries(c.byPhase).map(([k, b]) => `P${+k + 1} ${pctf(b.ok / b.n)}`).join(' · ')}</td><td>${esc(closest)}</td></tr>`;
      }).join('')}
      </tbody></table>
    </section>

    <section class="card">
      <h2>Mechanic by mechanic: clears vs your pulls</h2>
      <p class="muted small">Plan-independent, all from the logs. <b>Kept off</b> = share of the raw (unmitigated) damage that mits and shields together kept off HP (overkill counts as damage that got through), pooled over every hit so mit + shield adds up to it; the gap shown is on this. <b>Mit</b> = share removed by damage reduction (mits, Reprisal/Feint/Addle…). <b>Shield</b> = share soaked by shields.
      <b>HP in</b> = HP before the hit. Medians per hit, then across pulls. Damage depends on the hit, so compare a mechanic's two rows with each other, not across mechanics.</p>
      <table><thead><tr><th>Mechanic</th><th class="num">Clears: kept off · mit / shield · HP in</th><th class="num">You: kept off · mit / shield · HP in</th><th>Most clears had this up; you usually didn't</th><th class="num">Deaths<br><span class="muted">clears / you</span></th></tr></thead><tbody>
      ${R.mechanics.map(m => `<tr><td><span class="phase-dot" style="background:${PHASE_COLOR(m.phase)}"></span>${esc(phaseShort(m.phaseName))} · ${esc(m.mechanic)} <span class="muted">${sheetClock(m.sheet, m.total, m.clock)}</span>${timingTag(m.key)}</td>
        <td class="num">${m.ref ? `<b>${pctf(m.ref.prevented)}</b> · ${pctf(m.ref.mitigated)} / ${pctf(m.ref.shielded)} · ${pctf(m.ref.hpBefore)} <span class="muted small">(${m.ref.n})</span>` : '—'}</td>
        <td class="num">${m.you ? `<b>${pctf(m.you.prevented)}</b>${dpts(m.you.prevented, m.ref?.prevented, m.you.n)} · ${pctf(m.you.mitigated)} / ${pctf(m.you.shielded)} · ${pctf(m.you.hpBefore)} <span class="muted small">(${m.you.n})</span>` : '<span class="muted">not reached</span>'}</td>
        <td class="small">${m.missing.map(x => `${esc(x.status)} <span class="muted">${Math.round(x.ref * 100)}% vs ${Math.round(x.you * 100)}%</span>${statusTag(x.status)}`).join('<br>') || '<span class="muted">—</span>'}</td>
        <td class="num">${m.refDeaths} / ${m.ourDeaths}</td></tr>`).join('')}
      </tbody></table>
    </section>

    <section class="card">
      <h2>Where the clears don't follow the ${esc(planName(planKey))} sheet</h2>
      <p class="muted small">Per sheet entry, for clears whose comp has that job. Where most clears do something else, the field plays it differently; that's a plan choice, not a mistake to copy blindly or to blame on anyone.</p>
      <h3>Most clears do it differently (${R.consensus.length})</h3>
      ${R.consensus.length ? cellTable(R.consensus) : '<p class="empty">None.</p>'}
      <details class="sub"><summary><b>Clears split (${R.split.length})</b> <span class="muted small">some follow the sheet, some don't: different plans in use</span></summary>${R.split.length ? cellTable(R.split) : '<p class="empty">None.</p>'}</details>
    </section>

    <section class="card">
      <h2>Carry-overs: clears vs you</h2>
      <p class="muted small">How often one press lasted every hit the sheet chains it to, and when it was pressed relative to the first hit (median).</p>
      <table><thead><tr><th>Sheet column · mit</th><th>Should cover</th><th class="num">Clears: lasted / pressed</th><th class="num">You: lasted / pressed</th></tr></thead><tbody>
      ${R.chains.map(x => `<tr><td>${esc(x.slot)} · ${esc(x.label)}</td><td class="small">${x.links.map(esc).join(' → ')}</td>
        <td class="num">${x.ref.n ? `${x.ref.held}/${x.ref.n}` : '—'}${x.refOffset != null ? ` · ${Math.abs(x.refOffset).toFixed(1)}s before` : ''}</td>
        <td class="num">${x.ours.n ? `${x.ours.held}/${x.ours.n}` : '—'}${x.ourOffset != null ? ` · ${Math.abs(x.ourOffset).toFixed(1)}s before` : ''}</td></tr>`).join('')}
      </tbody></table>
    </section>

    <section class="card">
      <h2>Phase timing</h2>
      <p class="muted small">When each phase starts (FFLogs phase start, from the pull). A narrow range across clears means the transition is fixed; a wide one means it depends on the group.</p>
      <table><thead><tr><th>Phase</th><th class="num">Clears</th><th class="num">You (median)</th></tr></thead><tbody>
      ${R.phaseTimes.filter(p => p.refN || p.ourN).map(p => `<tr><td>${esc(p.name)}</td><td class="num">${p.refN ? (p.refMax - p.refMin < 1500 ? `${fmt(p.refMin)} <span class="muted small">(fixed: all within ${((p.refMax - p.refMin) / 1000).toFixed(1)}s)</span>` : `${fmt(p.refMin)}–${fmt(p.refMax)}`) : '—'}</td><td class="num">${p.ourN ? `${fmt(p.ourMed)} <span class="muted small">(${p.ourN} pulls)</span>` : '—'}</td></tr>`).join('')}
      </tbody></table>
    </section>`;
  },

  method() {
    const problems = checkCatalog();
    const used = new Set(result.pulls.flatMap(p => p.rows.flatMap(r => r.items.map(i => i.info.name))));
    const learned = result.learned;
    const mapRows = result.mechanics.map(m => {
      const ra = result.rowAbility[m.key];
      return `<tr><td>${esc(phaseShort(m.phaseName))} · ${esc(m.mechanic)} <span class="muted">${sheetClock(m.sheet, m.total, m.clock)}</span></td><td>${ra ? `${esc(ra.name)} <span class="muted small">${ra.byName ? "by name" : "by timing"}</span>` : '<span class="muted">— (no hit found; judged on press timing)</span>'}</td><td class="num">${ra ? `${ra.n}/${ra.total}` : ''}</td></tr>`;
    }).join('');
    return `<section class="card prose">
      <h2>How to read this</h2>
      <p>Every finding lists its evidence, tagged by where it comes from:</p>
      <ul>
        <li><span class="src src-log">Log</span> read straight from the FFLogs report: hit times, damage, who pressed what and when, and which statuses were on each player when a hit landed.</li>
        <li><span class="src src-official">Official</span> from the official FFXIV Job Guide (Patch ${JOB_GUIDE_PATCH}), level-100 tooltips: durations, recasts, ranges.</li>
        <li><span class="src src-calc">Math</span> worked out from those two, e.g. "pressed at 0:31.2 + 15s = ran out at 0:46.2".</li>
      </ul>
      <p><b>Is a mit "up"?</b> The game calculates each hit about 0.7s before the damage shows (FFLogs' "calculateddamage" row), and that row lists the damage-modifying statuses on the player at that moment. A planned mit counts as up when its status was on at least half of the players hit (one player for single-target tools), or, for Reprisal/Feint/Addle/Dismantle, listed on the hit. That list often leaves out shields, because shields absorb damage instead of reducing it. So a shield counts as up when the log's apply/remove rows have it on the player when the damage landed, including one removed at that exact moment (broken by the hit). Buff events show <i>who</i> applied it, so "up, but from someone else" is shown separately.</p>
      <p><b>Not up, why?</b> Shield already used up by earlier damage (not a mistake) · applied only after the game had calculated the hit · running on a different enemy · this attack isn't reduced by enemy debuffs at all · replaced by someone else's same effect · pressed in time but players out of range (measured from positions) · pressed after the hit · ran out before the hit · on cooldown · not pressed. Two cases are never counted as a player's miss. "Impossible on the sheet": the sheet asks for the same action twice within its official recast and the other one was done, or the pull ended before it. "Unclear": pressed in time with everyone in range, and the log doesn't say why it wasn't on the players.</p>
      <p><b>Carry-overs.</b> Each "➔ X" is linked to the cell where X was pressed. A carry-over "lasts" when X was up at every linked hit. The press window is (last hit − official duration) up to the first hit. A shield that an earlier planned hit uses up can't carry on however it's timed; those are shown as a sheet question, not a player's miss.</p>
      <p><b>Deaths and healing.</b> For each death the page reads the HP the game had for the player just before the fatal hit (from the hit's own snapshot), the damage in the 1.5s before death, and the healing they received in the 15s before. Several tests follow from that. Would the hit have killed them from full HP? If not, the death is put down to entering the hit with low HP, and the heals they got are listed so you can see whether healing was missing or the damage simply outpaced it. Did several hits land at once? Was the hit unusually large or on unusually few players (a short stack/tower)? Was a vulnerability debuff on them, or a planned mit missing? A missing mit is only blamed when the planned mits would have brought the hit below the HP they had. Combined HoT rows that FFLogs adds under "Limit Break" are left out so healing isn't counted twice. These categories are inferences from the listed facts: before raising something with a player, open the pull in FFLogs (links on every death) and check the replay.</p>
      <p><b>Top clears.</b> The 8 reference clears are matched to the same sheet rows. A clear "has it up" by the same test as your pulls. "Kept off" is 1 − (damage taken incl. overkill) / unmitigated damage: how much of the raw hit mits and shields removed. A comparison with fewer than 4 clears that have that job is marked "too few". When most clears do something else at a mechanic, it's flagged as a plan difference rather than a mistake.</p>
      <p><b>Positions.</b> FFLogs logs each player's x/y on every cast and every hit they take (the same data its replay uses). Deaths show a snapshot of everyone's position at the killing hit, distances to the nearest player and the group, and how far apart the players sharing that hit were. When a mit wasn't on someone, the page measures how far they were from the caster when it was pressed and compares it with the official radius (self-centred effects like Kerachole, Shield Samba or Holos only; ground circles like Sacred Soil aren't checked because the log doesn't record where they were placed). Positions are centre points and the game also counts hitbox size, so anything within 1y of the edge is called borderline.</p>
      <p><b>Attacks that ignore mitigation.</b> If the game's damage multiplier for an attack is 1.00 on every snapshot (4 or more) where a mit or enemy debuff was listed, the attack is marked "ignores mitigation" and planned mits there are "attack ignores it", never a miss. Each attack also shows its FFLogs damage type; a magic-only mit (Magick Barrier, Fey Illumination) on a physical attack is "attack ignores it" too.</p>
      <p><b>Healer barriers that can't stack.</b> Eukrasian Prognosis/Diagnosis and Galvanize can't be on a player together (official tooltip). When most players missing one already had the other, it's "overwritten", not a miss.</p>
      <p><b>Tank LB3.</b> A planned LB3 is up when a tank Limit Break status was on at least half the players hit. It's a party resource, so a missing one shows as "no tank LB (party)" and isn't counted against either tank.</p>
      <p><b>Debuffs that are part of a mechanic, failure signals, chain wipes.</b> From the loaded pulls the page learns how often each attack gives a vuln or Damage Down to the players it hits. If an attack gives it on 60%+ of its hits and shows up in 30%+ of the pulls that lasted long enough to see it, the debuff is part of the mechanic (e.g. Double-Trouble Trap, Wave Cannon) and is never read as a sign of an earlier failure. The other vulns and Damage Downs are failure signals, collected for everyone, dead or alive, because whoever fails a mechanic often survives it. When 5+ players die within 3s, it is a chain wipe: no one is counted as "died first", and the pull lists the personal failure signals from the 30s before. "Closest to pushing" lists pulls that wiped with 10% or less of the boss HP left, by where they actually ended.</p>
      <p><b>Tank deaths.</b> For a tank that died to a hit below their max HP, the page lists the tank cooldowns on them at the fatal hit, the big ones (60s+ recast) still on cooldown, and the ones ready and unused. For each ready one it works out, from its official % ("Reduces damage taken by 40%"), whether it alone would have kept them alive; invulns always would. A Dark Knight who died while Walking Dead (no Undead Rebirth) is "Walking Dead not healed", with the healing that landed vs the max HP needed. Cooldown presses are only in downloads made after this check was added: clear the cached events to refetch.</p>
      <p><b>Not covered / known limits:</b> where arena markers or AoE shapes were (the log has positions of players and enemies, not the ground telegraphs); Limit Break other than a planned tank LB3; the LPDU sheet's "Fake Melee Extras" column (not checked); sheet times that match no logged hit (those are judged on press timing only and say so). A sheet note that moves a tank job to the other column "from this point onwards" (LPDU P3) swaps MT/OT for that phase and later ones. Multi-hit mechanics: a mit up for the first hit but gone from most players at a later hit is "ran out" (hit 2 of 3…). ${result.havePositions ? '' : '<span class="warn">This report loaded no positions.</span>'}</p>
    </section>

    <section class="card">
      <h2>Data checks</h2>
      <p class="small">${problems.length ? `<span class="warn">Catalog problems:</span> ${problems.map(esc).join('; ')}` : `✓ Every duration in the mit catalog matches the official tooltip text (${Object.keys(CATALOG).length} actions).`}</p>
      <p class="small">${result.haveStatusEvents ? '✓ Buff/debuff events loaded: "who applied it" is from the log.' : '<span class="warn">No buff events loaded; "up" falls back to hit statuses plus press timing.</span>'}</p>
      <h3>Status names checked against this report</h3>
      <p class="muted small">For each action pressed in this report: the status the catalog expects, and how often the presser applied it within 1.5s.</p>
      <table><thead><tr><th>Action</th><th>Expected status</th><th class="num">Presses</th><th class="num">Status seen</th><th>Result</th></tr></thead><tbody>
      ${[...used].sort().map(n => {
        const c = CATALOG[n], L = learned[n];
        if (!c) return `<tr><td>${esc(n)}</td><td colspan="4" class="warn">Not in the catalog</td></tr>`;
        const seen = L ? Math.max(0, ...c.statuses.map(s => L.seen[s] || 0)) : 0;
        const okv = L && L.casts >= 2 && seen >= L.casts * 0.5;
        return `<tr><td>${esc(n)}</td><td>${esc(c.statuses.join(' / '))}</td><td class="num">${L?.casts || 0}</td><td class="num">${L ? seen : '—'}</td>
          <td>${!L ? '<span class="muted">not pressed in these pulls</span>' : okv ? '✓ confirmed' : c.kind === 'heal' ? '<span class="muted">heal tool (timing only)</span>' : `<span class="warn">not confirmed</span> <span class="muted small">seen: ${esc(Object.entries(L.seen).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, v]) => `${s} ${v}`).join(', '))}</span>`}</td></tr>`;
      }).join('')}</tbody></table>

      <h3>Sheet clock vs log clock</h3>
      <p class="muted small">FFLogs' phase start isn't always the sheet's 0:00 for that phase. The difference is measured from mechanics whose sheet name matches a logged ability (median), then corrected. All times on this page are on the sheet's clock.</p>
      <table><thead><tr><th>Phase</th><th>Difference</th><th class="num">Measured from</th></tr></thead><tbody>
      ${(result.phaseOffset || []).filter(o => o.samples || o.ms).map(o => `<tr><td>${esc(plan.phases[o.phase]?.name || `P${o.phase + 1}`)}</td><td>${Math.abs(o.ms) < 500 ? "in sync" : `FFLogs starts this phase ${Math.abs(o.ms / 1000).toFixed(1)}s ${o.ms < 0 ? "later" : "earlier"} than the sheet's 0:00`}</td><td class="num">${o.samples} matched hits${o.samples < 3 ? ' <span class="warn">(too few, not corrected)</span>' : ''}</td></tr>`).join('')}
      </tbody></table>

      <h3>Which logged ability each sheet mechanic is matched to</h3>
      <p class="muted small">The ability seen most often near the sheet time, by name or as the nearest hit on 4+ players. Several sheet names (e.g. "Mystery Magic") are called something else in the log.</p>
      <table><thead><tr><th>Sheet mechanic</th><th>Logged ability</th><th class="num">Pulls</th></tr></thead><tbody>${mapRows}</tbody></table>
    </section>

    <section class="card">
      <h2>Official mit data used (Job Guide, Patch ${JOB_GUIDE_PATCH})</h2>
      <table><thead><tr><th>Action</th><th>Job · Lv</th><th>Recast</th><th>Counted as</th><th>Official tooltip</th></tr></thead><tbody>
      ${Object.entries(CATALOG).map(([n, c]) => { const g = JOB_GUIDE[n] || {}; return `<tr><td><b>${esc(n)}</b><br><span class="muted small">${c.sec != null ? `${c.sec}s` : '—'}</span></td><td class="small">${esc(g.job || '?')} · ${g.level ?? '?'}</td><td class="small">${esc(g.recast || '—')}</td><td class="small">${esc(c.tank ? 'Tank cooldown' : { mit: 'Damage reduction', debuff: 'Enemy debuff', shield: 'Shield', heal: 'Heal (timing only)', lb: 'Tank Limit Break' }[c.kind])}${c.note ? `<br><span class="muted">${esc(c.note)}</span>` : ''}</td><td class="small">${esc(g.text || '')} ${g.url ? `<a href="${esc(g.url)}" target="_blank" rel="noopener">↗</a>` : ''}</td></tr>`; }).join('')}
      </tbody></table>
      <p class="muted small">"Party Mit" on the sheet means: ${Object.entries(PARTY_MIT_BY_JOB).map(([j, a]) => `${JOB_ABBR[j]} ${a.join('/')}`).join(', ')}.</p>
    </section>

    <section class="card prose">
      <h2>Mit sheet notes</h2>
      ${plan.phases.map(ph => `<details class="sub"><summary>${esc(ph.name)}</summary><pre class="notes">${esc(ph.notes || '—')}</pre></details>`).join('')}
    </section>`;
  },
};

/** One row per phase: how far pulls get, where they end, and how the mits and carry-overs go there. */
function phaseOverview() {
  const total = fullResult.pulls.length;
  const rows = plan.phases.map((ph, k) => ({ ph, k, v: viewFor(k) })).filter(x => x.v.pulls.length);
  if (!rows.length) return '';
  return `<section class="card">
    <h2>By phase</h2>
    <p class="muted small">Click a phase to see every tab for that phase only. "First death here" = pulls whose first death was in this phase (some still limp into the next phase, so it can overlap "Reached next phase"). Kept off vs clears = median gap in raw damage kept off by mits and shields at that phase's mechanics, where you have 3+ pulls.</p>
    <table><thead><tr><th>Phase</th><th class="num">Reached</th><th class="num">First death here</th><th class="num">Reached next phase</th><th class="num">Deaths before wipe-out</th><th class="num">Planned mits up</th><th class="num">Carry-overs lasted</th><th class="num">Kept off vs clears</th><th>Most common first death</th></tr></thead><tbody>
    ${rows.map(({ ph, k, v }) => {
      const reached = v.pulls.length;
      const ended = v.pulls.filter(p => p.countCause).length;
      const through = fullResult.pulls.filter(p => (p.phase ?? -1) > k).length;
      const deaths = v.pulls.reduce((a, p) => a + p.deaths.filter(d => !d.wipeOut).length, 0);
      const items = v.pulls.flatMap(p => p.rows.flatMap(r => r.items)).filter(i => !['dead', 'unaffected', 'conflict'].includes(i.status));
      const up = items.filter(i => ['ok', 'other', 'used-up'].includes(i.status)).length;
      const cDone = v.chains.reduce((a, c) => a + c.full, 0), cHeld = v.chains.reduce((a, c) => a + c.held, 0);
      const gaps = (v.reference?.mechanics || []).filter(m => m.ref && m.you && m.you.n >= 3 && m.ref.prevented != null && m.you.prevented != null).map(m => m.you.prevented - m.ref.prevented);
      const gap = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null;
      const top = v.causes[0];
      return `<tr><td><a href="#" data-phase="${k}"><span class="phase-dot" style="background:${PHASE_COLOR(k)}"></span>${esc(ph.name)}</a></td>
        <td class="num">${reached} <span class="muted small">(${pct(reached, total)}%)</span></td><td class="num">${ended ? `<b>${ended}</b>` : '0'}</td><td class="num">${through}</td>
        <td class="num">${deaths} <span class="muted small">(${(deaths / reached).toFixed(1)}/pull)</span></td>
        <td class="num">${items.length ? `${pct(up, items.length)}%` : '—'}</td><td class="num">${cDone ? `${pct(cHeld, cDone)}% <span class="muted small">(${cHeld}/${cDone})</span>` : '—'}</td>
        <td class="num">${gap == null ? '—' : `<span class="${gap <= -0.08 ? 'warn' : ''}">${gap >= 0 ? '+' : '−'}${Math.abs(Math.round(gap * 100))} pts</span>`}</td>
        <td class="small">${top ? `${esc(top.cause.replace(/^Phase \d+: [^:]+: /, ''))} <span class="muted">×${top.count}</span>` : '—'}</td></tr>`;
    }).join('')}
    </tbody></table></section>`;
}

function dot(ok, seen) {
  const r = seen ? ok / seen : 0;
  const cls = !seen ? 'none' : r >= 0.8 ? 'good' : r >= 0.5 ? 'mid' : 'bad';
  return `<span class="dot ${cls}" aria-hidden="true"></span>`;
}

function progressChart(pulls) {
  const W = 1000, H = 220, L = 34, R = 8, T = 14, B = 24;
  const n = pulls.length || 1;
  const band = (W - L - R) / n, bw = Math.max(3, Math.min(28, band - 2));
  const y = v => T + (H - T - B) * (1 - v / 100);
  const grid = [0, 25, 50, 75, 100].map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}%</text>`).join('');
  const best = Math.max(...pulls.map(p => p.progress ?? 0));
  const bars = pulls.map((p, i) => {
    const v = p.progress ?? 0, x = L + i * band + (band - bw) / 2;
    const tip = `<b>Pull ${p.n}</b> · ${fmt(p.duration)} · ${esc(p.phaseName)}<br>${p.kill ? 'Clear!' : `${esc(p.cause)}<br>${esc(p.causeDetail)}`}`;
    const h = Math.max(2, y(0) - y(v));
    const label = v === best && v > 0 ? `<text x="${x + bw / 2}" y="${y(v) - 5}" text-anchor="middle" style="fill:var(--text-secondary)">#${p.n}</text>` : '';
    return `<g data-tip="${esc(tip)}" data-goto="pulls:${p.n}" style="cursor:pointer"><rect x="${L + i * band}" y="${T}" width="${band}" height="${H - T - B}" fill="transparent"/>
      <path d="M${x},${y(0)} v${-(h - 4)} q0,-4 4,-4 h${bw - 8} q4,0 4,4 v${h - 4} z" fill="${PHASE_COLOR(Math.max(0, p.phase))}"/>${label}</g>`;
  }).join('');
  const every = Math.ceil(n / 25);
  const xl = pulls.map((p, i) => i % every === 0 ? `<text x="${L + i * band + band / 2}" y="${H - 6}" text-anchor="middle">${p.n}</text>` : '').join('');
  const phases = [...new Set(pulls.map(p => p.phase))].filter(k => k >= 0).sort();
  const legend = `<div class="legend">${phases.map(k => `<span><i style="background:${PHASE_COLOR(k)}"></i>${esc(pulls.find(p => p.phase === k).phaseName)}</span>`).join('')}</div>`;
  return `${legend}<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Progress per pull">${grid}${bars}${xl}</svg>`;
}

function causeBar(c, max) {
  const how = Object.entries(c.cats || {}).sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n.toLowerCase()} ×${k}`).join(', ');
  const who = Object.entries(c.players).sort((a, b) => b[1] - a[1]).map(([n, k]) => `${n} ×${k}`).join(', ');
  return `<div class="bar-row" data-tip="${esc(`<b>${esc(c.cause)}</b><br>Pulls: ${c.pulls.join(', ')}${who ? `<br>First to die: ${esc(who)}` : ''}`)}">
    <div class="name">${esc(c.cause)} ${how ? `<small>· ${esc(how)}</small>` : ''}</div>
    <div class="bar-track"><div class="bar-fill" style="width:${(100 * c.count / max).toFixed(1)}%"></div></div>
    <div class="num">${c.count}</div></div>`;
}

function playersTable() {
  const rows = result.perPlayer.filter(r => forPlayer(r.player.name)).slice().sort((a, b) => b.firsts - a.firsts || b.deaths - a.deaths);
  return `<table><thead><tr><th>Player</th><th>Column</th><th class="num">Died first</th><th class="num">Deaths before wipe-out</th><th>Likely cause of those deaths</th><th>Failure debuffs <span class="muted small">(lived through)</span></th><th>Out of range <span class="muted small">(party heals / shields / mits)</span></th><th class="num">Their planned mits up</th><th class="num">Their carry-overs lasted</th></tr></thead><tbody>
    ${rows.map(r => {
      const m = r.mit, all = Object.entries(m).filter(([s]) => !['dead', 'unaffected', 'conflict'].includes(s)).reduce((a, [, v]) => a + v, 0);
      const up = (m.ok || 0) + (m.other || 0) + (m['used-up'] || 0);
      return `<tr><td>${esc(r.player.name)} <span class="muted">${JOB_ABBR[r.player.job] || ''}</span></td><td>${esc(r.slot || '—')}</td>
      <td class="num">${r.firsts}${r.chainFirsts ? ` <span class="muted small" data-tip="First to go in a chain wipe (5+ dead within 3s): not counted, they were a victim.">+${r.chainFirsts} chain</span>` : ''}</td><td class="num">${r.deaths}</td>
      <td>${Object.entries(r.cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="chip cat">${esc(k)} ×${v}</span>`).join('') || '<span class="muted">—</span>'}</td>
      <td>${r.fails ? `<b>${r.fails}</b> <span class="muted small">(${r.failsSurvived} lived)</span> ${Object.entries(r.failsBy).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `<span class="chip cat">${esc(k)} ×${v}</span>`).join('')}` : '<span class="muted">—</span>'}</td>
      <td>${r.outOfRange ? `<b>${r.outOfRange}</b> ${Object.entries(r.outOfRangeBy).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `<span class="chip cat">${esc(k)} ×${v}</span>`).join('')}` : '<span class="muted">—</span>'}</td>
      <td class="num">${all ? `${pct(up, all)}% <span class="muted">(${up}/${all})</span>` : '—'}</td>
      <td class="num">${r.chainsTotal ? `${r.chainsHeld}/${r.chainsTotal}` : '—'}</td></tr>`;
    }).join('')}</tbody></table>
    <p class="muted small">"Died first" includes deaths that weren't their fault (e.g. a raidwide missing someone else's mit); being first in a chain wipe (5+ dead within 3s) isn't counted. "Failure debuffs" are vulns and Damage Down that aren't part of the mechanic (an attack that gives one to 60%+ of the players it hits is treated as part of the mechanic) and weren't given to 4+ players at once; most of them were lived through, but they still cost damage or the next hit. Open the Deaths tab for each one. "Out of range": presses of a party-wide heal, shield or mit centred on its caster (official range "0y/Ny") while this player was alive, more than N+1y away, and didn't get the effect (positions as FFLogs logs them; the game adds hitbox size, so the last 1y isn't counted).</p>`;
}

/** Mechanics where some players died and others lived: what was different for the ones who died. */
function diedVsLivedCard(list) {
  if (!list.length) return '';
  const pc = v => v == null ? '—' : `${Math.round(100 * v)}%`;
  return `<section class="card">
    <h2>Same hit, different outcome: who died vs who lived</h2>
    <p class="muted small">For each mechanic that killed some players and not others (deaths after the pull was already lost are left out): medians for the players it killed and the ones it didn't, as a share of each player's max HP, from the hit and the game's snapshot of it. "Mits on them" counts party mits and enemy debuffs on that player at the hit. The read-out checks, in this order: far more raw damage (an extra hit or the wrong spot), less shield, 2+ fewer mits, less HP going in.</p>
    <table><thead><tr><th>Mechanic</th><th class="num">Died / lived</th><th class="num">Raw damage</th><th class="num">Shield</th><th class="num">Mits on them</th><th class="num">HP going in</th><th>What was different for the ones who died</th></tr></thead><tbody>
    ${list.map(m => {
      const { died: D, lived: L, reasons } = m.diedVsLived;
      return `<tr><td><span class="phase-dot" style="background:${PHASE_COLOR(m.phase)}"></span>${esc(phaseShort(m.phaseName))} · <b>${esc(m.mechanic)}</b> <span class="muted">${sheetClock(m.sheet, m.total, m.clock)}</span></td>
      <td class="num">${D.n} / ${L.n}</td><td class="num">${pc(D.raw)} <span class="muted">vs ${pc(L.raw)}</span></td><td class="num">${pc(D.shield)} <span class="muted">vs ${pc(L.shield)}</span></td>
      <td class="num">${D.mits} <span class="muted">vs ${L.mits}</span></td><td class="num">${pc(D.hpIn)} <span class="muted">vs ${pc(L.hpIn)}</span></td>
      <td class="small">${reasons.length ? esc(reasons.join('; ')) : '<span class="muted">no clear difference in these numbers: check the replay</span>'}</td></tr>
      ${(m.diedVsLived.deaths || []).filter(d => forPlayer(d.player.name)).length ? `<tr class="sub"><td colspan="7"><details><summary class="small">Every death on this hit (${m.diedVsLived.deaths.filter(d => forPlayer(d.player.name)).length})</summary>
        <table class="inner"><thead><tr><th>Pull</th><th>Player</th><th class="num">Raw</th><th class="num">Got through</th><th class="num">Shield</th><th class="num">HP going in</th><th>Party mits / shields on them</th><th>Compared with the others hit that pull</th><th></th></tr></thead><tbody>
        ${m.diedVsLived.deaths.filter(d => forPlayer(d.player.name)).map(d => `<tr>
          <td>#${d.pull}</td><td>${esc(d.player.name)} <span class="muted">${JOB_ABBR[d.player.job] || ''}</span><br><span class="muted small">${esc(d.category)}${d.ability ? ` · ${esc(d.ability)}` : ''}</span></td>
          <td class="num">${pc(d.raw)}</td><td class="num">${pc(d.through)}</td><td class="num">${pc(d.shield)}</td><td class="num">${pc(d.hpIn)}</td>
          <td class="small">${d.on.length ? esc(d.on.join(', ')) : '<span class="muted">none</span>'}</td>
          <td class="small">${d.why.length ? esc(d.why.join('; ')) : '<span class="muted">nothing stands out: check the replay</span>'}</td>
          <td>${fflLink({ reportCode: d.reportCode, id: d.pullId }, d.t)}</td></tr>`).join('')}
        </tbody></table></details></td></tr>` : ''}`;
    }).join('')}
    </tbody></table></section>`;
}

function missTable(list, limit) {
  return `<table><thead><tr><th>Player</th><th>Mit</th><th>Sheet: use it for</th><th class="num">Not up</th><th>Why (count)</th><th class="num">Up</th><th class="num">Timing</th><th>Actually used for</th><th>Reference clears</th></tr></thead><tbody>
  ${list.slice(0, limit).map(m => {
    const avg = m.deltas.length ? m.deltas.reduce((a, b) => a + b, 0) / m.deltas.length : null;
    const why = Object.entries(m.counts).filter(([s]) => BAD.includes(s) || s === 'cooldown').sort((a, b) => b[1] - a[1]).map(([s, v]) => chip(s, `${STATUS_SHORT[s]} ×${v}`, STATUS_TEXT[s])).join('');
    return `<tr><td>${esc(m.player.name)} <span class="muted">${esc(m.slot || '')}</span></td><td>${esc(m.label)}</td>
    <td>${esc(phaseShort(m.phaseName))} · ${esc(m.mechanic)}</td>
    <td class="num"><b>${m.bad}</b>/${m.total}</td><td>${why}</td><td class="num">${m.ok}</td>
    <td class="num">${avg == null ? '—' : `${avg > 0 ? '+' : '−'}${Math.abs(avg).toFixed(1)}s`}</td>
    <td class="small">${m.usedForTop ? `${esc(m.usedForTop.where)} <span class="muted">×${m.usedForTop.n}</span>` : '<span class="muted">—</span>'}${m.pulls.length ? `<br><span class="muted">Pulls ${pullLinks(m.pulls, 5)}</span>` : ''}</td><td class="small">${clearsCell(m)}</td></tr>`;
  }).join('')}</tbody></table>`;
}

function deathCard(p, d) {
  return `<details class="death${d.wipeOut ? ' wipeout' : ''}"><summary>
      <span class="muted">${pullLink(p.n)} · ${esc(phaseShort(d.phaseName))} ${clockAt(d.phase, d.rel, d.pullT)}</span>
      <b>${esc(d.player.name)}</b> <span class="muted">${esc(d.slot || '')}</span> — ${esc(d.mechanic)}
      <span class="chip cat">Likely: ${esc(d.category)}</span> ${conf(d.confidence)}</summary>
    <div class="death-body">
      <p class="why">${esc(d.why)}</p>
      <div class="death-grid">
        <div>${factsHtml(d.facts)}
          <div class="small">${fflLink(p, d.hitT, 'Open this moment in FFLogs')}</div></div>
        ${d.snapshot ? mapSvg(d.snapshot) : ''}
      </div>
    </div></details>`;
}

const ROLE = job => ['Warrior', 'Paladin', 'Gunbreaker', 'DarkKnight'].includes(job) ? 'tank'
  : ['WhiteMage', 'Astrologian', 'Scholar', 'Sage'].includes(job) ? 'healer' : 'dps';

/** Top-down snapshot of logged positions at the killing hit (north up, same as the in-game map). */
function mapSvg(s) {
  const pts = [...s.players.filter(p => p.pos).map(p => p.pos), ...s.enemies.map(e => e.pos), ...s.trail];
  if (!pts.length) return '';
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const half = Math.max(10, (Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))) / 2 + 4);
  const S = 240, k = S / (half * 2);
  const X = x => ((x - (cx - half)) * k).toFixed(1), Y = y => ((y - (cy - half)) * k).toFixed(1);
  const victim = s.players.find(p => p.victim);
  const grid = [];
  for (let g = Math.ceil((cx - half) / 5) * 5; g <= cx + half; g += 5) grid.push(`<line x1="${X(g)}" x2="${X(g)}" y1="0" y2="${S}"/>`);
  for (let g = Math.ceil((cy - half) / 5) * 5; g <= cy + half; g += 5) grid.push(`<line y1="${Y(g)}" y2="${Y(g)}" x1="0" x2="${S}"/>`);
  const trail = s.trail.length > 1 ? `<polyline class="trail" points="${s.trail.map(p => `${X(p.x)},${Y(p.y)}`).join(' ')}"/>` : '';
  const enemies = s.enemies.map(e => `<path class="enemy" d="M${X(e.pos.x)},${+Y(e.pos.y) - 7} l7,7 l-7,7 l-7,-7 z" data-tip="Enemy that dealt the hit"/>`).join('');
  // Label the victim first, then anyone not crowded by an existing label (hover shows everyone).
  const labelled = [];
  const roomFor = p => { const x = +X(p.pos.x), y = +Y(p.pos.y); if (labelled.some(q => Math.hypot(q[0] - x, q[1] - y) < 16)) return false; labelled.push([x, y]); return true; };
  const order = s.players.filter(p => p.pos).sort((a, b) => b.victim - a.victim);
  const show = new Set(order.filter(roomFor).map(p => p.id));
  const players = s.players.filter(p => p.pos).sort((a, b) => a.victim - b.victim).map(p => {
    const d = victim?.pos && !p.victim ? Math.hypot(p.pos.x - victim.pos.x, p.pos.y - victim.pos.y).toFixed(1) + 'y from ' + victim.name : '';
    const tip = `${esc(p.name)} (${JOB_ABBR[p.job] || ''})${p.victim ? ' — died' : p.dead ? ' — already dead' : ''}${d ? `<br>${esc(d)}` : ''}${p.pos.age > 1000 ? `<br>nearest logged position ${(p.pos.age / 1000).toFixed(1)}s away` : ''}`;
    return `<g data-tip="${esc(tip)}"><circle class="pl ${ROLE(p.job)}${p.dead ? ' dead' : ''}${p.victim ? ' victim' : ''}" cx="${X(p.pos.x)}" cy="${Y(p.pos.y)}" r="${p.victim ? 8 : 6.5}"/>
      ${show.has(p.id) ? `<text x="${X(p.pos.x)}" y="${+Y(p.pos.y) - 11}" text-anchor="middle">${JOB_ABBR[p.job] || "?"}</text>` : ""}</g>`;
  }).join('');
  const bar = 5 * k;
  return `<figure class="minimap"><svg viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img" aria-label="Positions at the killing hit">
    <g class="grid">${grid.join('')}</g>${trail}${enemies}${players}
    <line class="scale" x1="8" x2="${(8 + bar).toFixed(1)}" y1="${S - 10}" y2="${S - 10}"/><text x="8" y="${S - 14}" class="scale-t">5y</text></svg>
    <figcaption><span><i class="lg tank"></i>Tank</span><span><i class="lg healer"></i>Healer</span><span><i class="lg dps"></i>DPS</span><span><i class="lg enemy"></i>Enemy</span><span><i class="lg victim"></i>Died</span><span>- - their last 6s</span><br>
    Logged positions at the hit, north up. Grid = 5y.</figcaption></figure>`;
}

/** Death tally tab: callout matching, edits, export / import. Demo data only ever changes the in-memory demo ledger. */
function bindTally() {
  const demo = !!fullResult?.demo;
  const online = cloud.cloudOn() && !demo;
  const getL = () => demo ? demoLedger : ledger;
  const setL = v => { if (demo) demoLedger = v; else { ledger = v; saveLedger(); } };
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el[ev] = fn; };
  on('#tally-mode', 'onchange', e => { view.tallyMode = e.target.value; render(); });
  on('#tally-kind', 'onchange', e => { view.tallyKind = e.target.value; render(); });
  on('#btn-callouts', 'onclick', () => {
    const text = $('#callouts').value;
    if (!demo) store.set('callouts', text);
    const codes = loaded.map(e => e.report.code);
    const here = Object.values(getL()).filter(e => codes.includes(e.report));
    store.set('nicknames', $('#nicknames').value);
    const pullN = new Map(fullResult.pulls.map(p => [`${p.reportCode}:${p.id}`, p.n]));
    calloutRows = matchCallouts(text, here, fullResult.players.map(p => p.name), parseNicknames($('#nicknames').value), pullN);
    setL(applyCallouts(getL(), calloutRows, codes));
    render();
  });
  // Pick a different death for one name of one callout: the old death loses the callout, the new one gets it.
  document.querySelectorAll('[data-pick]').forEach(sel => sel.onchange = () => {
    const [ri, vi] = sel.dataset.pick.split(':').map(Number);
    const r = calloutRows[ri], m = r.matched[vi], L = { ...getL() };
    if (m.death && L[m.death.key]?.src === 'callout') L[m.death.key] = clearCallout(L[m.death.key]);
    const e = L[sel.value];
    if (e) L[e.key] = { ...e, note: r.text, blame: r.blame || m.victim, mech: true, src: 'callout' };
    r.matched[vi] = { victim: m.victim, death: e || null, fit: true, manual: true };
    setL(L); render();
  });
  const edit = (key, change) => { const L = getL(); if (!L[key]) return; setL({ ...L, [key]: { ...L[key], ...change, src: 'edit' } }); render(); };
  document.querySelectorAll('[data-note]').forEach(i => i.onchange = () => edit(i.dataset.note, { note: i.value.trim() }));
  document.querySelectorAll('[data-blame]').forEach(s => s.onchange = () => edit(s.dataset.blame, { blame: s.value }));
  document.querySelectorAll('[data-mech]').forEach(c => c.onchange = () => edit(c.dataset.mech, { mech: c.checked }));
  on('#btn-ledger-export', 'onclick', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(getL(), null, 1)], { type: 'application/json' }));
    a.download = `death-tally-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  on('#ledger-import', 'onchange', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const ok = Object.values(data).filter(x => x && x.key && x.report && x.player && typeof x.abs === 'number');
      if (!ok.length) throw new Error('No tally entries in that file.');
      setL({ ...getL(), ...Object.fromEntries(ok.map(x => [x.key, x])) });
      status(`Imported ${ok.length} deaths into the tally.`);
      render();
    } catch (err) { status(`Import failed: ${err.message}`, true); }
  });
  on('#btn-ledger-clear', 'onclick', async () => {
    const n = Object.keys(getL()).length;
    const where = online ? 'the online tally' : 'the tally in this browser';
    if (!n || !confirm(`Delete all ${n} deaths, callouts and edits from ${where}? This can't be undone (export it first to keep a copy).`)) return;
    if (online) {
      try { await saving; await cloud.clearTally(ff.userToken()); synced = {}; }
      catch (e) { return status(e.message, true); }
      ledger = {}; calloutRows = null; render(); return;
    }
    setL({}); calloutRows = null; render();
  });
}

function pullDetails(p) {
  const deaths = p.deaths.length ? p.deaths.map(d => deathCard(p, d)).join('') : '<p class="empty">No deaths.</p>';
  const rows = p.rows.length ? p.rows.map(r => {
    const items = r.items.filter(i => forPlayer(i.player.name));
    return `<div class="mitrow"><div class="m"><span class="phase-dot" style="background:${PHASE_COLOR(r.phase)}"></span>${esc(r.mechanic)}
      <small>${esc(phaseShort(r.phaseName))} ${clockAt(r.phase, r.rel, r.pullT)}${r.ability ? ` · ${esc(r.ability)}${r.damageType ? ` (${esc(r.damageType)})` : ''}, ${r.targets.length} hit` : ''}${r.ignoresMit ? ` · <span class="warn" title="On all ${r.ignoresMit.withMit} snapshots in this report with a mit listed, the game's damage multiplier was 1.00.">ignores mitigation</span>` : ''}${r.how === 'estimated' ? ' · <span class="warn">no hit found, timing only</span>' : ''}</small></div>
      <div>${items.map(i => `<details class="item"><summary>${chip(i.status, `${esc(i.label)}${i.carry ? ' ➔' : ''} <span class="muted">${esc(i.slot)}</span>`)}</summary>
        <div class="item-body"><b>${esc(i.player.name)}: ${esc(i.label)}${i.carry ? ' (carried over)' : ''} — ${esc(STATUS_TEXT[i.status])}</b>
        ${i.sheetText && i.sheetText !== i.label ? `<div class="muted small">Sheet says: "${esc(i.sheetText)}"</div>` : ''}${factsHtml(i.facts)}</div></details>`).join('') || '<span class="muted small">nothing planned</span>'}</div></div>`;
  }).join('') : '<p class="empty">No mechanics from the sheet reached.</p>';
  const chains = p.chains.filter(c => forPlayer(c.player.name));
  const chainHtml = chains.length ? chains.map(c => `<details class="item"><summary>${chip(c.held ? 'ok' : (c.brokeAt?.item.status || 'missing'), `${esc(c.player.name.split(' ')[0])}: ${esc(c.label)}`)}
      <span class="small">${c.links.map(l => `${dot(['ok', 'other', 'used-up', 'unaffected'].includes(l.item.status) ? 1 : 0, l.item.status === 'dead' ? 0 : 1)}${esc(l.row.mechanic)}`).join(' → ')}</span></summary>
      <div class="item-body">${factsHtml(c.facts)}</div></details>`).join('') : '<p class="empty">No carry-overs in this pull.</p>';
  return `<details class="pull" data-n="${p.n}"><summary><b>#${p.n}</b><span class="muted">${fmt(p.duration)}</span><span><span class="phase-dot" style="background:${PHASE_COLOR(Math.max(0, p.phase))}"></span>${esc(phaseShort(p.phaseName))} <span class="muted">${p.fightPct != null ? `${p.fightPct}% left` : ''}</span></span>
    <span>${p.kill ? '<b>Clear</b>' : `${esc(p.cause)} <span class="muted small">— ${esc(p.causeDetail)}</span>`}</span></summary>
    <div class="pull-body">${fflLink(p, null, 'Open pull in FFLogs')}
      <div><h4>Deaths</h4>${deaths}</div>
      <div><h4>Carry-overs</h4>${chainHtml}</div>
      <div><h4>Mit check at each mechanic</h4><p class="muted small">Click any mit for the evidence.</p>${rows}</div></div></details>`;
}

// ---------- tooltip ----------
const tip = $('#tip');
document.addEventListener('mousemove', e => {
  const el = e.target.closest?.('[data-tip]');
  if (!el) { tip.classList.remove('on'); return; }
  tip.innerHTML = el.dataset.tip;
  const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
  const y = e.clientY + 16 + tip.offsetHeight > innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 16;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
  tip.classList.add('on');
});

// ---------- boot ----------
(async () => {
  try { if (await ff.finishPkceLogin()) status('Logged in to FFLogs.'); }
  catch (e) { status(e.message, true); }
  renderConn();
  if (cloud.cloudOn()) initCloud();
  const problems = checkCatalog();
  if (problems.length) console.warn('Mit catalog problems:', problems);
})();

// Read-only handle for audits and debugging from the browser console (e.g. exporting an audit bundle).
window.__umad = {
  get loaded() { return loaded; }, get refLoaded() { return refLoaded; }, get result() { return fullResult; },
  get plan() { return plan; }, get planKey() { return planKey; }, get mapping() { return mapping; }, get planCache() { return planCache; },
  findings: () => findings(), summaryText: () => summaryText(),
};
