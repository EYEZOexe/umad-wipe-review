// FFLogs v2 API client: auth (client credentials or PKCE login), GraphQL, event paging.
import { allActionNames, allStatusNames, ENEMY_DEBUFF_STATUSES } from './mits.js';

const BASE = 'https://www.fflogs.com';
const LS = 'umad-wipes.';

// ---------- auth ----------
export function getAuth() {
  try { return JSON.parse(localStorage.getItem(LS + 'auth')) || {}; } catch { return {}; }
}
function setAuth(a) { localStorage.setItem(LS + 'auth', JSON.stringify(a)); }
export function signOut() { const a = getAuth(); delete a.token; delete a.expires; setAuth(a); }

export function saveClientCredentials(clientId, clientSecret) {
  setAuth({ ...getAuth(), mode: 'client', clientId, clientSecret, token: null });
}

async function clientCredentialsToken({ clientId, clientSecret }) {
  // Sent as form body (no Authorization header) so the browser doesn't need a CORS preflight.
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
  const res = await fetch(`${BASE}/oauth/token`, { method: 'POST', body });
  if (!res.ok) throw new Error(`FFLogs rejected the client ID/secret (HTTP ${res.status}).`);
  return res.json();
}

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function startPkceLogin(clientId) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const redirect = location.origin + location.pathname;
  sessionStorage.setItem(LS + 'pkce', JSON.stringify({ verifier, state, clientId, redirect }));
  const p = new URLSearchParams({ client_id: clientId, code_challenge: challenge, code_challenge_method: 'S256', state, redirect_uri: redirect, response_type: 'code' });
  location.href = `${BASE}/oauth/authorize?${p}`;
}

/** Call on page load; finishes a PKCE redirect if one is in the URL. */
export async function finishPkceLogin() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  if (!code) return false;
  const saved = JSON.parse(sessionStorage.getItem(LS + 'pkce') || 'null');
  history.replaceState(null, '', location.pathname);
  if (!saved || saved.state !== q.get('state')) throw new Error('FFLogs login state mismatch; try logging in again.');
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: saved.clientId, code_verifier: saved.verifier, redirect_uri: saved.redirect, code });
  const res = await fetch(`${BASE}/oauth/token`, { method: 'POST', body });
  if (!res.ok) throw new Error(`FFLogs login failed (HTTP ${res.status}).`);
  const t = await res.json();
  setAuth({ mode: 'user', clientId: saved.clientId, token: t.access_token, expires: Date.now() + t.expires_in * 1000 });
  return true;
}

export function isConfigured() {
  const a = getAuth();
  return (a.mode === 'client' && a.clientId && a.clientSecret) || (a.mode === 'user' && a.token && a.expires > Date.now());
}

async function token() {
  const a = getAuth();
  if (a.token && a.expires > Date.now() + 60_000) return a;
  if (a.mode === 'client' && a.clientId && a.clientSecret) {
    const t = await clientCredentialsToken(a);
    const next = { ...a, token: t.access_token, expires: Date.now() + t.expires_in * 1000 };
    setAuth(next);
    return next;
  }
  throw new Error('Not connected to FFLogs. Open Settings and connect first.');
}

export async function gql(query, variables) {
  const a = await token();
  const endpoint = a.mode === 'user' ? `${BASE}/api/v2/user` : `${BASE}/api/v2/client`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.token}` },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) { signOut(); throw new Error('FFLogs session expired; reconnect in Settings.'); }
  if (res.status === 429) throw new Error('FFLogs rate limit reached (3600 points/hour). Wait a bit and retry.');
  const j = await res.json();
  if (j.errors?.length) throw new Error('FFLogs: ' + j.errors.map(e => e.message).join('; '));
  return j.data;
}

// ---------- report data ----------
export function parseReportCode(input) {
  const s = input.trim();
  const m = s.match(/reports\/(?:a:)?([A-Za-z0-9]{16})/) || s.match(/^([A-Za-z0-9]{16})$/);
  if (!m) return null;
  const f = s.match(/fight=(\d+|last)/);
  return { code: m[1], fight: f ? f[1] : null };
}

const REPORT_Q = `query($code:String!){ reportData{ report(code:$code){
  code title startTime
  fights(translate:true){ id encounterID name kill startTime endTime fightPercentage bossPercentage lastPhase lastPhaseIsIntermission phaseTransitions{ id startTime } friendlyPlayers }
  phases{ encounterID separatesWipes phases{ id name isIntermission } }
  masterData(translate:true){ actors{ id name type subType server petOwner } abilities{ gameID name type } }
}}}`;

const EVENTS_Q = `query($code:String!,$fights:[Int],$start:Float,$end:Float,$type:EventDataType,$host:HostilityType,$filter:String,$res:Boolean){
 reportData{ report(code:$code){ events(fightIDs:$fights,startTime:$start,endTime:$end,dataType:$type,hostilityType:$host,filterExpression:$filter,includeResources:$res,limit:10000){ data nextPageTimestamp } } } }`;

async function allEvents(code, fights, start, end, opts, onPage) {
  const out = [];
  let cursor = start;
  for (let page = 0; page < 200; page++) {
    const d = await gql(EVENTS_Q, { code, fights, start: cursor, end, ...opts });
    const ev = d.reportData.report.events;
    out.push(...ev.data);
    onPage?.(out.length);
    if (!ev.nextPageTimestamp) break;
    cursor = ev.nextPageTimestamp;
  }
  return out;
}

/** Fetch with a server-side filter; if FFLogs rejects the filter, refetch unfiltered and filter here. */
async function filteredEvents(code, fights, start, end, opts, filter, localPred, onPage) {
  try {
    return await allEvents(code, fights, start, end, { ...opts, filter }, onPage);
  } catch (e) {
    if (!/filter|expression|pin/i.test(e.message)) throw e;
    return (await allEvents(code, fights, start, end, opts, onPage)).filter(localPred);
  }
}

const quoteList = names => names.map(n => `"${n.replace(/"/g, '')}"`).join(', ');
const DEBUFF_NAMES = ['Vulnerability Up', 'Magic Vulnerability Up', 'Physical Vulnerability Up', 'Damage Down', 'Doom', 'Walking Dead'];

export async function fetchReport(code, progress = () => {}) {
  progress(`Loading report ${code}…`);
  const d = await gql(REPORT_Q, { code });
  const report = d.reportData.report;
  if (!report) throw new Error(`Report ${code} not found (is it private?).`);
  return report;
}

// ---------- event cache (IndexedDB) ----------
// Report events never change once uploaded, so cache them per report + pull list.
// Bump whenever the action or status lists change: cached downloads are filtered to the lists at the time.
const CACHE_VERSION = 7; // 6: adds healing · 7: Walking Dead debuff
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('umad-wipes', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('events');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function cacheGet(key) {
  try { const db = await idb(); return await new Promise(res => { const q = db.transaction('events').objectStore('events').get(key); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); }
  catch { return null; }
}
async function cachePut(key, val) {
  try { const db = await idb(); await new Promise(res => { const t = db.transaction('events', 'readwrite'); t.objectStore('events').put(val, key); t.oncomplete = res; t.onerror = res; }); }
  catch { /* cache is optional */ }
}
export async function clearCache() {
  try { const db = await idb(); await new Promise(res => { const t = db.transaction('events', 'readwrite'); t.objectStore('events').clear(); t.oncomplete = res; t.onerror = res; }); } catch { }
}

/** Pull all event streams the analysis needs for the chosen fights. */
export async function fetchEvents(report, fightIds, progress = () => {}) {
  // The key includes a fingerprint of the action/status lists, so adding a mit to the catalog re-downloads
  // instead of silently reusing events that were filtered without it.
  const lists = [...allActionNames(), ...allStatusNames(), ...ENEMY_DEBUFF_STATUSES].sort().join('|');
  let h = 0; for (let i = 0; i < lists.length; i++) h = (h * 31 + lists.charCodeAt(i)) | 0;
  const key = `v${CACHE_VERSION}:${(h >>> 0).toString(36)}:${report.code}:${[...fightIds].sort((a, b) => a - b).join(',')}`;
  const hit = await cacheGet(key);
  if (hit) { progress('Using cached events'); return hit; }

  const fights = report.fights.filter(f => fightIds.includes(f.id));
  const start = Math.min(...fights.map(f => f.startTime));
  const end = Math.max(...fights.map(f => f.endTime));
  const abil = new Map(report.masterData.abilities.map(a => [a.gameID, a.name]));
  const actions = allActionNames(), statuses = allStatusNames();
  const step = (label) => (n) => progress(`${label}: ${n.toLocaleString()} events`);
  const nameIn = list => e => list.includes(abil.get(e.abilityGameID));

  const deaths = await allEvents(report.code, fightIds, start, end, { type: 'Deaths', host: 'Friendlies' }, step('Deaths'));
  const damage = await allEvents(report.code, fightIds, start, end, { type: 'DamageTaken', host: 'Friendlies', res: true }, step('Damage taken'));
  // Every friendly cast, with resources: mit presses, plus the caster's x/y on each one (the position track
  // the replays use). Only mit presses and a compact position list are kept.
  const allCasts = await allEvents(report.code, fightIds, start, end, { type: 'Casts', host: 'Friendlies', res: true }, step('Casts & positions'));
  const casts = allCasts.filter(nameIn(actions));
  const positions = [];
  const addPos = (fight, t, id, r) => { if (r && r.x != null && r.y != null) positions.push([fight, t, id, r.x, r.y]); };
  for (const e of allCasts) addPos(e.fight, e.timestamp, e.sourceID, e.sourceResources);
  for (const e of damage) { addPos(e.fight, e.timestamp, e.targetID, e.targetResources); addPos(e.fight, e.timestamp, e.sourceID, e.sourceResources); }
  // Mit statuses on players (who applied what to whom, and when it came off).
  const buffs = await filteredEvents(report.code, fightIds, start, end, { type: 'Buffs', host: 'Friendlies' },
    `ability.name in (${quoteList(statuses)})`, nameIn(statuses), step('Mit statuses on players'));
  // Reprisal/Feint/Addle/Dismantle on the boss.
  const enemyDebuffs = await filteredEvents(report.code, fightIds, start, end, { type: 'Debuffs', host: 'Enemies' },
    `ability.name in (${quoteList(ENEMY_DEBUFF_STATUSES)})`, nameIn(ENEMY_DEBUFF_STATUSES), step('Mit debuffs on the boss'));
  const debuffs = await filteredEvents(report.code, fightIds, start, end, { type: 'Debuffs', host: 'Friendlies' },
    `ability.name in (${quoteList(DEBUFF_NAMES)})`, nameIn(DEBUFF_NAMES), step('Vulnerability debuffs'));
  // Healing received: who healed whom, how much (and overheal), and the target's HP afterwards. Kept compact:
  // [fight, time, source, target, ability, amount, overheal, isTick, hpAfter, maxHp]. Heals also carry positions.
  const healRaw = await allEvents(report.code, fightIds, start, end, { type: 'Healing', host: 'Friendlies', res: true }, step('Healing'));
  const heals = [];
  for (const e of healRaw) {
    if (e.type !== 'heal') continue;
    heals.push([e.fight, e.timestamp, e.sourceID, e.targetID, e.abilityGameID, e.amount || 0, e.overheal || 0, e.tick ? 1 : 0, e.targetResources?.hitPoints ?? null, e.targetResources?.maxHitPoints ?? null]);
    addPos(e.fight, e.timestamp, e.targetID, e.targetResources); addPos(e.fight, e.timestamp, e.sourceID, e.sourceResources);
  }
  const out = { deaths, damage, casts, buffs, enemyDebuffs, debuffs, positions, heals };
  await cachePut(key, out);
  return out;
}
