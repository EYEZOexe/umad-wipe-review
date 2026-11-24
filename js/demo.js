// Synthetic report in FFLogs API shape, built from the real mit plan, so the page can be tried without a login.
// Everything here is made up: player names, pulls, deaths, presses.
import { resolveToken, infoFor } from './mits.js';
import { SLOTS } from './plan.js';

export function buildDemo(plan) {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  const roster = [
    ['MT', 'Tank Alpha', 'Warrior'], ['OT', 'Tank Bravo', 'DarkKnight'],
    ['White Mage', 'Heal Charlie', 'WhiteMage'], ['Scholar', 'Heal Delta', 'Scholar'],
    ['D1', 'Melee Echo', 'Reaper'], ['D2', 'Melee Foxtrot', 'Monk'],
    ['D3', 'Ranged Golf', 'Bard'], ['D4', 'Caster Hotel', 'Pictomancer'],
  ];
  const actors = roster.map(([, name, job], i) => ({ id: i + 1, name, subType: job, server: 'Demo' }));
  const BOSS = 100;
  const abilities = [];
  const ids = new Map();
  const ab = (name, status = false) => {
    const key = (status ? 's:' : 'a:') + name;
    if (!ids.has(key)) { const id = (status ? 1000000 : 40000) + abilities.length; ids.set(key, id); abilities.push({ gameID: id, name, type: '1024' }); }
    return ids.get(key);
  };
  const assignments = Object.fromEntries(roster.map(([slot], i) => [slot, i + 1]));
  // Made-up positions (1/100 yalm, arena centre 100,100): everyone stacked loosely; the caster (id 8) drifts 35y out
  // every ~40s so the range check has something to find.
  const spot = (pid, ts) => {
    const far = pid === 8 && Math.floor(ts / 20000) % 2 === 1;
    const a = pid * 0.8 + ts / 9000;
    return { x: Math.round(10000 + Math.cos(a) * (far ? 3500 : 300)), y: Math.round(10000 + Math.sin(a) * (far ? 3500 : 300)) };
  };
  const phases = plan.phases.map((p, i) => ({ id: i + 1, name: p.name, isIntermission: false }));
  const phaseLen = plan.phases.map(p => (p.rows.at(-1)?.phaseTime ?? 60) * 1000 + 25000);

  const fights = [], deaths = [], damage = [], casts = [], debuffs = [], buffs = [], enemyDebuffs = [];
  // Scripted story: early pulls die in P1/P2, then a wall in P3, a couple reach P4/P5.
  const script = [[0, 'raid'], [1, 'fail'], [1, 'raid'], [2, 'fail'], [2, 'fail'], [2, 'raid'], [2, 'vuln'], [2, 'fail'], [3, 'raid'], [2, 'tank'], [3, 'fail'], [4, 'raid']];
  let clock = 0;
  script.forEach(([reachPhase, how], fi) => {
    const id = fi + 1, start = clock + 30000;
    const trans = [];
    let t = start;
    for (let k = 0; k <= reachPhase; k++) { trans.push({ id: k + 1, startTime: t }); if (k < reachPhase) t += phaseLen[k]; }
    const lastPhase = plan.phases[reachPhase];
    const failRow = lastPhase.rows[Math.min(lastPhase.rows.length - 1, Math.floor(rnd() * lastPhase.rows.length))];
    const failT = t + failRow.phaseTime * 1000 + 300;
    const end = failT + 9000;
    const active = []; // {status, src, target, from, to}

    // Presses for every planned (non carry-over) mit, mostly on time; earlier pulls sloppier.
    plan.phases.slice(0, reachPhase + 1).forEach((ph, k) => {
      const ps = trans[k].startTime;
      for (const row of ph.rows) {
        const ht = ps + row.phaseTime * 1000;
        if (ht > end) continue;
        for (const slot of SLOTS) {
          const pid = assignments[slot]; if (!pid) continue;
          for (const tok of row.cells[slot] || []) {
            if (tok.carry || tok.skip) continue;
            const names = resolveToken(tok, actors[pid - 1].subType); if (!names) continue;
            const info = infoFor(names);
            const r = rnd();
            if ((fi < 6 && r < 0.12) || r < 0.04) continue; // forgot
            const ts = r < 0.1 ? ht + 1500 : ht - 800 - Math.round(rnd() * 3500);
            casts.push({ timestamp: ts, type: 'cast', sourceID: pid, targetID: -1, abilityGameID: ab(names[0]), fight: id, sourceResources: spot(pid, ts) });
            const dur = (info.sec || 15) * 1000;
            const st = info.statuses[0];
            const targets = info.kind === 'debuff' ? [BOSS] : actors.map(a => a.id);
            for (const tg of targets) {
              active.push({ status: st, src: pid, target: tg, from: ts, to: ts + dur });
              const ev = info.kind === 'debuff' ? enemyDebuffs : buffs;
              ev.push({ timestamp: ts + 100, type: info.kind === 'debuff' ? 'applydebuff' : 'applybuff', sourceID: pid, targetID: tg, abilityGameID: ab(st, true), fight: id });
              ev.push({ timestamp: ts + dur, type: info.kind === 'debuff' ? 'removedebuff' : 'removebuff', sourceID: pid, targetID: tg, abilityGameID: ab(st, true), fight: id });
            }
          }
        }
      }
    });
    const statusesOn = (target, ts) => active.filter(a => (a.target === target || a.target === BOSS) && a.from <= ts && a.to >= ts).map(a => ab(a.status, true));

    // Raidwides at every reached row.
    plan.phases.slice(0, reachPhase + 1).forEach((ph, k) => {
      const ps = trans[k].startTime;
      for (const row of ph.rows) {
        const ht = ps + row.phaseTime * 1000;
        if (ht > end) continue;
        const name = row.mechanic.replace(/\([^)]*\)/g, '').split('/')[0].trim();
        for (const a of actors) {
          const ts = ht + a.id * 20;
          damage.push({ timestamp: ts, type: 'damage', sourceID: BOSS, targetID: a.id, abilityGameID: ab(name), fight: id,
            amount: 90000 + Math.round(rnd() * 20000), absorbed: 30000, unmitigatedAmount: 200000,
            buffs: statusesOn(a.id, ts).map(x => x + '.').join(''), targetResources: { hitPoints: 70000, maxHitPoints: 160000, ...spot(a.id, ts) }, sourceResources: { x: 10000, y: 9200 } });
        }
      }
    });

    // The death that ends the pull.
    const victim = how === 'tank' ? 1 : 3 + Math.floor(rnd() * 6);
    if (how === 'fail' || how === 'vuln') {
      const failName = ['Forsaken Cleave', 'Graven Image', 'Revolting Ruin III', 'Tower Explosion'][Math.floor(rnd() * 4)];
      if (how === 'vuln') {
        debuffs.push({ timestamp: failT - 12000, type: 'applydebuff', sourceID: BOSS, targetID: victim, abilityGameID: ab('Vulnerability Up', true), fight: id });
        damage.push({ timestamp: failT - 12000, type: 'damage', sourceID: BOSS, targetID: victim, abilityGameID: ab(failName), fight: id, amount: 40000, absorbed: 0, targetResources: { hitPoints: 120000, maxHitPoints: 160000 } });
      } else {
        damage.push({ timestamp: failT - 200, type: 'damage', sourceID: BOSS, targetID: victim, abilityGameID: ab(failName), fight: id, amount: 130000, absorbed: 0, overkill: 420000, targetResources: { hitPoints: 0, maxHitPoints: 160000 } });
      }
    }
    if (how === 'tank') damage.push({ timestamp: failT - 100, type: 'damage', sourceID: BOSS, targetID: 1, abilityGameID: ab('attack'), fight: id, amount: 120000, overkill: 40000, absorbed: 0, targetResources: { hitPoints: 0, maxHitPoints: 230000 } });
    if (how === 'raid' || how === 'vuln') {
      const ev = damage.filter(e => e.fight === id && e.targetID === victim && Math.abs(e.timestamp - failT) < 1500).at(-1);
      if (ev) { ev.overkill = 35000; ev.amount = 70000; ev.targetResources = { hitPoints: 0, maxHitPoints: 160000 }; }
    }
    deaths.push({ timestamp: failT, type: 'death', sourceID: -1, targetID: victim, abilityGameID: 0, fight: id });
    // Follow-up deaths, then the wipe.
    actors.map(a => a.id).filter(x => x !== victim).slice(0, 2 + Math.floor(rnd() * 5)).forEach((pid, j) => {
      deaths.push({ timestamp: failT + 3000 + j * 1500, type: 'death', sourceID: -1, targetID: pid, abilityGameID: 0, fight: id });
    });

    const total = plan.phases.length;
    const into = (failT - t) / phaseLen[reachPhase];
    const pct = Math.max(1, Math.round(100 - ((reachPhase + Math.min(1, into)) / total) * 100));
    fights.push({ id, encounterID: 1099, name: 'Demo Ultimate', kill: false, startTime: start, endTime: end, fightPercentage: pct,
      bossPercentage: Math.round(100 - into * 100), lastPhase: reachPhase + 1, lastPhaseIsIntermission: false, phaseTransitions: trans, friendlyPlayers: actors.map(a => a.id) });
    clock = end;
  });

  const report = { code: 'DEMO000000000000', title: 'Demo prog night (made-up data)', startTime: 0, fights,
    phases: [{ encounterID: 1099, separatesWipes: true, phases }], masterData: { actors, abilities } };
  // Same compact position list fflogs.js builds from casts and hits.
  const positions = [];
  const add = (f, t, i, r) => { if (r && r.x != null) positions.push([f, t, i, r.x, r.y]); };
  casts.forEach(e => add(e.fight, e.timestamp, e.sourceID, e.sourceResources));
  damage.forEach(e => { add(e.fight, e.timestamp, e.targetID, e.targetResources); add(e.fight, e.timestamp, e.sourceID, e.sourceResources); });
  return { report, events: { deaths, damage, casts, debuffs, buffs, enemyDebuffs, positions }, assignments };
}
