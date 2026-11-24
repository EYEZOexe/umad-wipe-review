// Mitigation catalog used to check the mit plan.
//
// Every number here must come from the official Job Guide text in jobguide.js (checkCatalog() verifies
// that each `sec` appears there as "Duration: <sec>s"). Status names marked `seen` were confirmed in a
// real FFLogs report (the status the caster applied within 1.5s of pressing the action); the app also
// re-checks every status name against whatever report you load (see learnStatuses in analyze.js).
import { JOB_GUIDE } from './jobguide.js';

/**
 * kind:
 *  'mit'     damage reduction on players (must be on the player when the hit lands)
 *  'debuff'  damage-down on the enemy (must be on the enemy that deals the hit)
 *  'shield'  barrier on players (can be used up by earlier damage, which is not a mistake)
 *  'heal'    healing tool the sheet schedules; checked for timing only, it doesn't reduce damage
 * sec: how long the relevant effect lasts, per the official tooltip.
 */
// Tank Limit Break statuses (LB1/LB2/LB3 of each tank job), as FFLogs names them.
export const TANK_LB_STATUSES = ['Shield Wall', 'Stronghold', 'Last Bastion', 'Land Waker', 'Dark Force', 'Gunmetal Soul'];

export const CATALOG = {
  // Role actions
  'Reprisal': { kind: 'debuff', statuses: ['Reprisal'], sec: 15, seen: true },
  'Feint': { kind: 'debuff', statuses: ['Feint'], sec: 15, seen: true },
  'Addle': { kind: 'debuff', statuses: ['Addle'], sec: 15, seen: true },
  // Tanks
  'Shake It Off': { kind: 'shield', statuses: ['Shake It Off'], sec: 30 },
  'Divine Veil': { kind: 'shield', statuses: ['Divine Veil'], sec: 30, seen: true },
  'Heart of Light': { kind: 'mit', statuses: ['Heart of Light'], sec: 15 },
  'Dark Missionary': { kind: 'mit', statuses: ['Dark Missionary'], sec: 15, seen: true },
  'Passage of Arms': { kind: 'mit', statuses: ['Passage of Arms'], sec: 18, seen: true, note: 'Only covers players standing in the cone behind the paladin, and ends if they act or move.' },
  // Ranged DPS
  'Troubadour': { kind: 'mit', statuses: ['Troubadour'], sec: 15, note: "Doesn't stack with Tactician or Shield Samba." },
  'Tactician': { kind: 'mit', statuses: ['Tactician'], sec: 15, note: "Doesn't stack with Troubadour or Shield Samba." },
  'Shield Samba': { kind: 'mit', statuses: ['Shield Samba'], sec: 15, seen: true, note: "Doesn't stack with Troubadour or Tactician." },
  'Dismantle': { kind: 'debuff', statuses: ['Dismantled', 'Dismantle'], sec: 10 },
  'Magick Barrier': { kind: 'mit', statuses: ['Magick Barrier'], sec: 10, dmg: 'magic', note: 'Magic damage only.' },
  'Tempera Grassa': { kind: 'shield', statuses: ['Tempera Grassa'], sec: 10 },
  // White Mage
  'Temperance': { kind: 'mit', statuses: ['Temperance'], sec: 20 },
  'Divine Caress': { kind: 'shield', statuses: ['Divine Caress'], sec: 10 },
  'Plenary Indulgence': { kind: 'mit', statuses: ['Confession'], sec: 10 },
  'Liturgy of the Bell': { kind: 'heal', statuses: ['Liturgy of the Bell'], sec: 20 },
  'Asylum': { kind: 'heal', statuses: ['Asylum'], sec: 24 },
  // Astrologian
  'Neutral Sect': { kind: 'shield', statuses: ['Neutral Sect'], sec: 30, timingSec: 50, noWindow: true, seen: true, note: 'The shield comes from casting Helios Conjunction while Neutral Sect (20s) is active; it lasts 30s.' },
  'Sun Sign': { kind: 'mit', statuses: ['Sun Sign'], sec: 15, seen: true },
  'Collective Unconscious': { kind: 'mit', statuses: ['Collective Unconscious'], sec: 10, seen: true, note: 'The 10% reduction lasts 10s; the ring itself lasts 18s.' },
  'Macrocosmos': { kind: 'heal', statuses: ['Macrocosmos'], sec: 15, seen: true, note: 'Stores 50% of damage taken and heals it back; not damage reduction.' },
  'Celestial Opposition': { kind: 'heal', statuses: ['Opposition'], sec: 15, seen: true },
  // Scholar
  'Expedient': { kind: 'mit', statuses: ['Desperate Measures'], sec: 20 },
  'Sacred Soil': { kind: 'mit', statuses: ['Sacred Soil'], sec: 15, note: 'Only covers players standing in the circle.' },
  'Deployment Tactics': { kind: 'shield', statuses: ['Galvanize', 'Catalyze'], sec: 30, secFrom: 'Adloquium', note: 'Spreads the Adloquium shield; it keeps the original shield\'s remaining time (max 30s).' },
  'Fey Illumination': { kind: 'mit', statuses: ['Fey Illumination', 'Seraphic Illumination'], sec: 20, dmg: 'magic', note: 'Magic damage only (5%).' },
  'Summon Seraph': { kind: 'shield', statuses: ['Seraphic Veil'], sec: 22, timingSec: 52, noWindow: true, note: 'Seraph lasts 22s; her shields come from Seraphic Veil/Consolation.' },
  'Consolation': { kind: 'shield', statuses: ['Seraphic Veil'], sec: 30 },
  'Seraphism': { kind: 'heal', statuses: ['Seraphism'], sec: 20 },
  'Dissipation': { kind: 'heal', statuses: ['Dissipation'], sec: 30 },
  // Sage
  'Kerachole': { kind: 'mit', statuses: ['Kerachole'], sec: 15, seen: true },
  'Holos': { kind: 'mit', statuses: ['Holos'], sec: 20, seen: true, note: 'Also a 30s barrier (Holosakos).' },
  'Panhaima': { kind: 'shield', statuses: ['Panhaima', 'Panhaimatinon'], sec: 15, seen: true },
  'Philosophia': { kind: 'heal', statuses: ['Eudaimonia', 'Philosophia'], sec: 20 },
  'Eukrasian Prognosis II': { kind: 'shield', statuses: ['Eukrasian Prognosis'], sec: 30, seen: true },
  'Eukrasian Prognosis': { kind: 'shield', statuses: ['Eukrasian Prognosis'], sec: 30, seen: true },
  'Zoe': { kind: 'heal', statuses: ['Zoe'], sec: 30, seen: true },
  // Single-target tools (official range "30y/0y"): up if it's on any player that hit landed on.
  'Aquaveil': { kind: 'mit', single: true, statuses: ['Aquaveil'], sec: 8 },
  'Divine Benison': { kind: 'shield', single: true, statuses: ['Divine Benison'], sec: 15 },
  'Exaltation': { kind: 'mit', single: true, statuses: ['Exaltation'], sec: 8 },
  'Celestial Intersection': { kind: 'shield', single: true, statuses: ['Intersection'], sec: 30, seen: true },
  'Haima': { kind: 'shield', single: true, statuses: ['Haima', 'Haimatinon'], sec: 15 },
  'Taurochole': { kind: 'mit', single: true, statuses: ['Taurochole'], sec: 15, note: "Doesn't stack with Kerachole." },
  'Eukrasian Diagnosis': { kind: 'shield', single: true, statuses: ['Eukrasian Diagnosis', 'Differential Diagnosis'], sec: 30 },
  'Adloquium': { kind: 'shield', single: true, statuses: ['Galvanize', 'Catalyze'], sec: 30 },
  'Excogitation': { kind: 'heal', single: true, statuses: ['Excogitation'], sec: 45 },
  'Protraction': { kind: 'heal', single: true, statuses: ['Protraction'], sec: 10 },
  // Party-wide GCD shields / heals
  'Concitation': { kind: 'shield', statuses: ['Galvanize', 'Catalyze'], sec: 30, note: 'Succor\'s level-96 replacement.' },
  'Physis II': { kind: 'heal', statuses: ['Physis II'], sec: 15 },
  // Tank Limit Break: a party resource (either tank may press it), so a missing one is never one player's miss.
  // Status names as logged by FFLogs (LB1 / LB2 / LB3 for each tank job). Not a Job Guide action: no official duration.
  'Tank LB3': { kind: 'lb', statuses: TANK_LB_STATUSES, sec: null, noGuide: true, note: 'Party Limit Break; either tank can use it.' },
  // Tank cooldowns (level-100 versions). tank: true keeps them out of party-mit numbers; they're used for tank
  // deaths (what was up, what was ready) and checked if a sheet lists them. Status names marked seen were found on
  // hits in real DMU logs ("Blackest Night" has no "The"; Guardian's barrier is "Guardian's Will").
  'Rampart': { kind: 'mit', tank: true, single: true, statuses: ['Rampart'], sec: 20, seen: true },
  'Guardian': { kind: 'mit', tank: true, single: true, big: true, statuses: ['Guardian', "Guardian's Will"], sec: 15, seen: true },
  'Holy Sheltron': { kind: 'mit', tank: true, single: true, statuses: ['Holy Sheltron', "Knight's Resolve"], sec: 8, seen: true },
  'Intervention': { kind: 'mit', tank: true, single: true, statuses: ['Intervention', "Knight's Resolve"], sec: 8, seen: true, note: 'Cast on another party member.' },
  'Bulwark': { kind: 'mit', tank: true, single: true, statuses: ['Bulwark'], sec: 10, seen: true, note: 'Blocks attacks; no fixed %.' },
  'Hallowed Ground': { kind: 'mit', tank: true, single: true, invuln: true, statuses: ['Hallowed Ground'], sec: 10, seen: true },
  'Damnation': { kind: 'mit', tank: true, single: true, big: true, statuses: ['Damnation'], sec: 15, seen: true },
  'Bloodwhetting': { kind: 'mit', tank: true, single: true, statuses: ['Bloodwhetting', 'Stem the Flow'], sec: 8, seen: true },
  'Thrill of Battle': { kind: 'mit', tank: true, single: true, statuses: ['Thrill of Battle'], sec: 10, seen: true, note: 'Raises max HP by 20%; no damage reduction.' },
  'Holmgang': { kind: 'mit', tank: true, single: true, invuln: true, statuses: ['Holmgang'], sec: 10, seen: true },
  'Shadowed Vigil': { kind: 'mit', tank: true, single: true, big: true, statuses: ['Shadowed Vigil', 'Vigilant'], sec: 15, seen: true },
  'Dark Mind': { kind: 'mit', tank: true, single: true, statuses: ['Dark Mind'], sec: 10, seen: true },
  'The Blackest Night': { kind: 'shield', tank: true, single: true, statuses: ['Blackest Night'], sec: 7, seen: true },
  'Oblation': { kind: 'mit', tank: true, single: true, statuses: ['Oblation'], sec: 10, seen: true },
  'Living Dead': { kind: 'mit', tank: true, single: true, invuln: true, statuses: ['Living Dead', 'Walking Dead', 'Undead Rebirth'], sec: 10, seen: true, note: 'Walking Dead kills unless healed for max HP within 10s.' },
  'Camouflage': { kind: 'mit', tank: true, single: true, statuses: ['Camouflage'], sec: 20 },
  'Great Nebula': { kind: 'mit', tank: true, single: true, big: true, statuses: ['Great Nebula'], sec: 15 },
  'Heart of Corundum': { kind: 'mit', tank: true, single: true, statuses: ['Heart of Corundum', 'Clarity', 'Catharsis of Corundum'], sec: 8 },
  'Superbolide': { kind: 'mit', tank: true, single: true, invuln: true, statuses: ['Superbolide'], sec: 10 },
};

// Each tank job's own cooldowns, biggest first (Rampart is a tank role action).
export const TANK_KIT = {
  Paladin: ['Hallowed Ground', 'Guardian', 'Rampart', 'Bulwark', 'Holy Sheltron'],
  Warrior: ['Holmgang', 'Damnation', 'Rampart', 'Thrill of Battle', 'Bloodwhetting'],
  DarkKnight: ['Living Dead', 'Shadowed Vigil', 'Rampart', 'Dark Mind', 'Oblation', 'The Blackest Night'],
  Gunbreaker: ['Superbolide', 'Great Nebula', 'Rampart', 'Camouflage', 'Heart of Corundum'],
};
// Statuses that reduce a tank's damage and can come from someone else (co-tank or own cooldown on the tank).
export const TANK_STATUSES = new Set(Object.values(CATALOG).filter(c => c.tank).flatMap(c => c.statuses));

// Healer barriers that can't be on a player together. Official: Eukrasian Prognosis II "Effect cannot be stacked
// with those of Eukrasian Diagnosis or scholar's Galvanize" (same for Eukrasian Diagnosis).
export const SHIELD_CLASH = [['Eukrasian Prognosis', 'Eukrasian Diagnosis', 'Differential Diagnosis', 'Galvanize']];

// FFLogs ability "type" for enemy attacks, checked against this fight's own damage multipliers:
// on type 1024 hits Addle gave 0.90 and Feint 0.95 (magic); on type 128 Feint gave 0.90, Addle and Dark Missionary 0.95
// (physical). Type 32 ("darkness"/unique) isn't consistent, so it's shown but never used to judge a mit.
export const DAMAGE_TYPE = { 128: 'physical', 1024: 'magic', 32: 'unique (darkness)' };

// Role actions are shared by a whole role, so they're checked by role instead of by job page.
export const ROLE_ACTIONS = { Reprisal: 'tank', Rampart: 'tank', Feint: 'melee', Addle: 'caster' };

// "Party Mit" in the sheet = the job's party-wide mitigation (official action names).
export const PARTY_MIT_BY_JOB = {
  Warrior: ['Shake It Off'], Paladin: ['Divine Veil'], Gunbreaker: ['Heart of Light'], DarkKnight: ['Dark Missionary'],
  Bard: ['Troubadour'], Machinist: ['Tactician'], Dancer: ['Shield Samba'],
  RedMage: ['Magick Barrier'], Pictomancer: ['Tempera Grassa'],
};

export const JOB_ABBR = {
  Warrior: 'WAR', Paladin: 'PLD', Gunbreaker: 'GNB', DarkKnight: 'DRK',
  WhiteMage: 'WHM', Astrologian: 'AST', Scholar: 'SCH', Sage: 'SGE',
  Monk: 'MNK', Dragoon: 'DRG', Ninja: 'NIN', Samurai: 'SAM', Reaper: 'RPR', Viper: 'VPR',
  Bard: 'BRD', Machinist: 'MCH', Dancer: 'DNC',
  BlackMage: 'BLM', Summoner: 'SMN', RedMage: 'RDM', Pictomancer: 'PCT', BlueMage: 'BLU',
};
export const TANKS = ['Warrior', 'Paladin', 'Gunbreaker', 'DarkKnight'];
export const HEALERS = ['WhiteMage', 'Astrologian', 'Scholar', 'Sage'];
export const MELEE = ['Monk', 'Dragoon', 'Ninja', 'Samurai', 'Reaper', 'Viper'];
export const PRANGED = ['Bard', 'Machinist', 'Dancer'];
export const CASTERS = ['BlackMage', 'Summoner', 'RedMage', 'Pictomancer'];

// Sheet shorthand / typos -> official action names.
const ALIASES = {
  'spreadlo': ['Deployment Tactics'],
  'zoe shields': ['Eukrasian Prognosis II', 'Eukrasian Prognosis'],
  'seraph': ['Summon Seraph'], 'serpah': ['Summon Seraph'],
  'fey illumuniation': ['Fey Illumination'],
  'scared soil': ['Sacred Soil'],
  'the troubadour': ['Troubadour'],
};
// Sheet entries that aren't a single checkable action.
const SKIP = { 'assist tanks': 'Healer note, not one action', 'enrage!': 'Enrage', 'enrage': 'Enrage', '✔': 'Sheet marker', '': '' };

const CANON = Object.fromEntries(Object.keys(CATALOG).map(k => [k.toLowerCase(), k]));

/** Every action we need casts for, and every status we need buff events for. */
export function allActionNames() {
  const s = new Set(Object.keys(CATALOG));
  Object.values(PARTY_MIT_BY_JOB).flat().forEach(n => s.add(n));
  ['Helios Conjunction', 'Adloquium', 'Tempera Coat', ...TANK_LB_STATUSES].forEach(n => s.add(n));
  return [...s];
}
export function allStatusNames() {
  return [...new Set(Object.values(CATALOG).flatMap(c => c.statuses))];
}
export const ENEMY_DEBUFF_STATUSES = [...new Set(Object.values(CATALOG).filter(c => c.kind === 'debuff').flatMap(c => c.statuses))];

const SUPERSCRIPTS = /[⁰¹²³⁴⁵⁶⁷⁸⁹]/g;

/**
 * Parse one sheet cell into planned tokens.
 * "Reprisal + Party Mit (GNB/DRK)\n➔ Sacred Soil" ->
 *   [{label:'Reprisal'}, {label:'Party Mit', party:true, jobs:['GNB','DRK']}, {label:'Sacred Soil', carry:true}]
 */
export function parseCell(text) {
  if (!text) return [];
  const out = [];
  let prevCarry = false;
  for (let line of String(text).split(/\r?\n/)) {
    const footnotes = (line.match(SUPERSCRIPTS) || []).join('');
    line = line.replace(SUPERSCRIPTS, '').trim();
    if (!line) continue;
    // "➔ Collective Unconscious\n+ Sun Sign": a line starting with "+" continues the line above, carry included.
    const carry = line.startsWith('+') ? prevCarry : line.startsWith('➔');
    prevCarry = carry;
    line = line.replace(/^[+➔]\s*/, '');
    for (let tok of line.split('+')) {
      tok = tok.trim();
      let note = null, jobs = null;
      const m = tok.match(/\(([^)]*)\)/);
      if (m) {
        const inner = m[1].trim();
        if (/^[A-Z]{3}(\/[A-Z]{3})*$/.test(inner)) jobs = inner.split('/');
        else note = inner;
        tok = tok.replace(m[0], '').trim();
      }
      const key = tok.toLowerCase();
      if (key in SKIP) {
        if (SKIP[key]) out.push({ label: tok, skip: SKIP[key], carry, note, jobs, raw: tok });
        continue;
      }
      if (key === 'lb3' || key === 'tank lb3' || key === 'tank lb') out.push({ label: 'Tank LB3', lb: true, carry, note, jobs, names: ['Tank LB3'], footnotes, raw: tok });
      else if (key === 'party mit') out.push({ label: 'Party Mit', party: true, jobs, carry, note, names: null, footnotes, raw: tok });
      else {
        const names = ALIASES[key] || (CANON[key] ? [CANON[key]] : [tok]);
        out.push({ label: tok, party: false, jobs, carry, note, names, footnotes, raw: tok, unknown: !ALIASES[key] && !CANON[key] });
      }
    }
  }
  return out;
}

/** Can this job press this action? Role actions by role, everything else by the job page it's on in the Job Guide. */
export function canUse(name, job) {
  const role = ROLE_ACTIONS[name];
  if (role) return role === 'tank' ? TANKS.includes(job) : role === 'melee' ? MELEE.includes(job) : CASTERS.includes(job);
  const g = JOB_GUIDE[name];
  return !g || g.job === String(job).toLowerCase();
}

/** Official action names that satisfy this token for a player's job; null when it doesn't apply to them. */
export function resolveToken(tok, job) {
  // Unrecognised text is never expected from anyone.
  if (tok.skip || tok.unknown) return null;
  if (tok.lb) return TANKS.includes(job) ? ['Tank LB3'] : null;
  if (tok.alts) { for (const a of tok.alts) { const r = resolveToken(a, job); if (r) return r; } return null; }
  if (tok.jobs && !tok.jobs.includes(JOB_ABBR[job])) return null;
  if (tok.party) return PARTY_MIT_BY_JOB[job] || null;
  const usable = (tok.names || []).filter(n => canUse(n, job));
  return usable.length ? usable : null;
}

// ---------- free-text sheets (LPDU style) ----------
// Each rule matches the START of a token ("Kera end of Kefka says castbar" → Kerachole). Order matters
// (Seraphism before Seraph, Panhaima before Haima). Anything unmatched is listed as a note, never guessed.
const LOOSE_RULES = [
  [/^(party mit|pranged 90s|90s)\b/, 'party'],
  [/^(shake|veil)\b/, 'party-wp'],
  [/^(rep|reprisal)\b/, ['Reprisal']], [/^feint\b/, ['Feint']], [/^addle\b/, ['Addle']],
  [/^(zoe )?e ?prog/, ['Eukrasian Prognosis II', 'Eukrasian Prognosis']], [/^e ?diag/, ['Eukrasian Diagnosis']],
  [/^kera/, ['Kerachole']], [/^philo/, ['Philosophia']], [/^physis/, ['Physis II']], [/^holos/, ['Holos']],
  [/^panhaima/, ['Panhaima']], [/^haima/, ['Haima']], [/^taurochole/, ['Taurochole']], [/^zoe\b/, ['Zoe']],
  [/^(succor|concitation)/, ['Concitation']], [/^(spreadlo|deployment)/, ['Deployment Tactics']],
  [/^(early )?(sacred )?soil/, ['Sacred Soil']], [/^(fey )?illum/, ['Fey Illumination']], [/^seraphism/, ['Seraphism']],
  [/^seraph\b/, ['Summon Seraph']], [/^exped/, ['Expedient']], [/^excog/, ['Excogitation']], [/^adlo/, ['Adloquium']],
  [/^protraction/, ['Protraction']], [/^dissipation/, ['Dissipation']],
  [/^temper[ae]nce/, ['Temperance']], [/^(divine )?caress/, ['Divine Caress']], [/^plenary/, ['Plenary Indulgence']],
  [/^(lily ?bell|liturgy)/, ['Liturgy of the Bell']], [/^asylum/, ['Asylum']], [/^(divine benison|benison|bene)\b/, ['Divine Benison']],
  [/^aqua ?veil/, ['Aquaveil']], [/^neutral/, ['Neutral Sect']], [/^sun sign/, ['Sun Sign']], [/^collective/, ['Collective Unconscious']],
  [/^macro/, ['Macrocosmos']], [/^exalt/, ['Exaltation']], [/^celestial intersection/, ['Celestial Intersection']],
  [/^celestial opposition/, ['Celestial Opposition']],
];
const LOOSE_SKIP = /^(kitchen|shorts?|ramp|rampart|invuln|provoke|voke|120s|card|all single target|regen|tether|stand under|pepsis|pneuma|start with|lb|ewer|share)/;
const PARTY_WORDS = { hol: 'GNB', heart: 'GNB', missionary: 'DRK', shake: 'WAR', veil: 'PLD' };

function looseToken(raw, slot) {
  let s = raw.toLowerCase().replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, '').trim();
  // Which tanks' party mit: "(Hol/Missionary)" is a job filter; "(shake/veil can be used earlier)" is a timing note,
  // so it's a filter only when every word is a tank party-mit word.
  let jobs = null;
  const paren = s.match(/\(([^)]*)\)/);
  if (paren) {
    const words = paren[1].split(/[\/,\s]+/).filter(Boolean);
    if (words.length && words.every(w => PARTY_WORDS[w])) jobs = words.map(w => PARTY_WORDS[w]);
    s = s.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  }
  if (/^prep\b/.test(s)) return { label: raw.trim(), skip: 'Prepare for a later mechanic (not checked here)', raw: raw.trim() };
  s = s.replace(/^(early|then|and)\s+/, '');
  if (!s) return null;
  // "90s" in a tank column is the tank's own 90s cooldown list, not the party mit.
  if (/^(90s|pranged 90s)\b/.test(s) && /^(MT|OT)$/.test(slot || '')) return { label: raw.trim(), skip: 'Tank 90s cooldown (personal, not checked)', raw: raw.trim() };
  if (/^(tank )?lb ?3?\b/.test(s) && /^(MT|OT)$/.test(slot || '')) return { label: 'Tank LB3', lb: true, carry: false, names: ['Tank LB3'], raw: raw.trim() };
  if (LOOSE_SKIP.test(s)) return { label: raw.trim(), skip: 'Tank personal / note (not checked)', raw: raw.trim() };
  for (const [re, what] of LOOSE_RULES) {
    if (!re.test(s)) continue;
    if (what === 'party') return { label: 'Party Mit', party: true, jobs, carry: false, names: null, raw: raw.trim() };
    if (what === 'party-wp') return { label: 'Party Mit', party: true, jobs: jobs || ['WAR', 'PLD'], carry: false, names: null, raw: raw.trim() };
    return { label: what[0], party: false, jobs: null, carry: false, names: what, raw: raw.trim() };
  }
  return { label: raw.trim(), skip: 'Not recognised as a mit (not checked)', raw: raw.trim() };
}

/** Parse a free-text cell (LPDU sheet): "Benison + Aquaveil MT // Asylum off cd", "Addle / Pranged 90s". */
export function parseCellLoose(text, slot) {
  if (!text) return [];
  const out = [];
  const parts = String(text).split(/\r?\n|\/\/|->|,|\+/).map(p => p.trim()).filter(Boolean);
  for (const p of parts) {
    // "A / B" (spaced slash) = either, depending on who's in the column; "Hol/Missionary" (no spaces) isn't split.
    const alts = p.split(/\s+\/\s+/).map(x => looseToken(x, slot)).filter(Boolean);
    if (alts.length > 1) {
      const live = alts.filter(a => !a.skip);
      // Alternatives only when they're for different jobs ("Addle / Pranged 90s"); two actions of the same job
      // ("Taurochole MT / Eprog between hits") are both assigned.
      const jobOf = a => a.party ? 'party' : (ROLE_ACTIONS[a.names?.[0]] || JOB_GUIDE[a.names?.[0]]?.job || a.names?.[0]);
      if (live.length > 1 && new Set(live.map(jobOf)).size === 1) out.push(...live);
      else if (live.length) out.push({ label: live.map(a => a.label).join(' or '), alts: live, carry: false, raw: p });
      else out.push(alts[0]);
    } else if (alts.length) out.push(alts[0]);
  }
  // "party mit after knock, shake/veil after stack/spread" names the same press twice: one party mit per cell.
  const seen = new Set();
  return out.filter(t => { const k = t.skip ? `skip:${t.raw}` : t.party ? 'party' : t.label; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function infoFor(names) {
  for (const n of names) if (CATALOG[n]) return { name: n, ...CATALOG[n], guide: JOB_GUIDE[n] || null };
  return { name: names[0], kind: 'unknown', statuses: [names[0]], sec: null, guide: JOB_GUIDE[names[0]] || null };
}

/** Recast in seconds from the official guide ("120s" -> 120). */
export function recastOf(name) {
  const r = JOB_GUIDE[name]?.recast;
  const m = r && r.match(/^(\d+(?:\.\d+)?)s$/);
  return m ? +m[1] : null;
}

/** Self-check: every duration in CATALOG must be stated in the official tooltip. Returns problems. */
export function checkCatalog() {
  const problems = [];
  for (const [name, c] of Object.entries(CATALOG)) {
    if (c.noGuide) continue;
    const g = JOB_GUIDE[name];
    if (!g) { problems.push(`${name}: not found in the official Job Guide data`); continue; }
    const text = c.secFrom ? JOB_GUIDE[c.secFrom]?.text || "" : g.text;
    if (c.sec != null && !new RegExp(`Duration: ${c.sec}s`).test(text)) problems.push(`${name}: catalog says ${c.sec}s, official text doesn't say "Duration: ${c.sec}s"`);
  }
  return problems;
}
