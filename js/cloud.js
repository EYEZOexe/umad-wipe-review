// Shared death tally in Supabase (see supabase/setup.sql). Plain REST calls, no library.
// Reads are open to everyone with the page; writes go through tally_upsert / tally_clear, which check the passcode.
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
    throw new Error(/passcode/i.test(msg) ? 'Wrong passcode.' : `Online tally: ${msg} (HTTP ${res.status})`);
  }
  return text ? JSON.parse(text) : null;
}

/** Every death in the shared tally, as a ledger object { key: entry }. Pages through 1000 rows at a time. */
export async function loadTally() {
  const out = {};
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${base()}/tally_deaths?select=data&order=key`, { headers: headers({ Range: `${from}-${from + 999}`, 'Range-Unit': 'items' }) });
    if (!res.ok) throw new Error(`Couldn't load the online tally (HTTP ${res.status}). Check supabaseUrl / supabaseKey in js/config.js and that supabase/setup.sql was run.`);
    const rows = await res.json();
    rows.forEach(r => { if (r.data?.key) out[r.data.key] = r.data; });
    if (rows.length < 1000) return out;
  }
}

export const checkCode = code => rpc('tally_check', { p_code: code });

/** Save these entries (in batches of 500). */
export async function saveEntries(code, entries) {
  for (let i = 0; i < entries.length; i += 500) await rpc('tally_upsert', { p_code: code, p_rows: entries.slice(i, i + 500) });
}

export const clearTally = code => rpc('tally_clear', { p_code: code });
