// Site settings for the shared page. Everything here is PUBLIC (anyone opening the page can read it):
// never put an FFLogs client secret, a Supabase secret/service_role key or the tally passcode in this file.
export const CONFIG = {
  // FFLogs *public* client ID (https://www.fflogs.com/api/clients/, "public client", redirect URL = this page's URL).
  // When set, people just click "Log in with FFLogs": no client ID or secret to type in.
  fflogsClientId: '01a20e72-f2c0-7140-9815-4bc0651a5dff',

  // Supabase project for the shared death tally (Project Settings -> API / Data API):
  // the project URL (https://xxxx.supabase.co) and the PUBLISHABLE key (sb_publishable_...) or legacy "anon" key.
  // Run supabase/setup.sql once first. Leave empty to keep the tally in this browser only.
  supabaseUrl: 'https://aouybejqbmxapduzcewn.supabase.co',
  supabaseKey: 'sb_publishable_PauydltQ6jtkJYmOc7BuzQ_lnFaFWoq',
};
