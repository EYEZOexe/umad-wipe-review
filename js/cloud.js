// Death tally in Supabase (see supabase/setup.sql). Plain REST calls, no library.
// Every call carries the viewer's FFLogs login token; the database asks FFLogs who it belongs to and only answers
// for the owner's account. Nobody else can read or change the tally, whatever they do with the public key.
import { CONFIG } from './config.js';

export const cloudOn = () => !!(CONFIG.supabaseUrl && CONFIG.supabaseKey);

function headers(extra = {}) {
  const k = CONFIG.supabaseKey;
  // New keys (sb_publishable_…) go in `apikey` only; legacy anon keys are JWTs and also go in Authorization.
  return { apikey: k, ...(k.startsWith('eyJ') ? { Authorization: `Bearer ${k}` } : {}), ...extra };
}
const base = () => CONFIG.supabaseUrl.replace(/\/+$/, '') + '/rest/v1';

async function rpc(name, body) {
  const res = await fetch(`${base()}/rpc/${name}`, { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch {}
    throw new Error(/not allowed/i.test(msg) ? 'This FFLogs account isn\'t allowed to use the death tally.' : `Online tally: ${msg} (HTTP ${res.status})`);
  }
  return text ? JSON.parse(text) : null;
}

/** { id, name, owner } for this FFLogs token, or null if FFLogs doesn't recognise it. */
export const whoami = token => rpc('tally_whoami', { p_token: token });

/** Every death in the tally, as a ledger object { key: entry }. Owner only. */
export async function loadTally(token) {
  const rows = await rpc('tally_load', { p_token: token }) || [];
  return Object.fromEntries(rows.filter(r => r?.key).map(r => [r.key, r]));
}

/** Save these entries (in batches of 500). Owner only. */
export async function saveEntries(token, entries) {
  for (let i = 0; i < entries.length; i += 500) await rpc('tally_upsert', { p_token: token, p_rows: entries.slice(i, i + 500) });
}

export const clearTally = token => rpc('tally_clear', { p_token: token });
