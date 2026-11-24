# UMAD Wipe Review

A static web page that takes your static's FFLogs reports and answers "why do we keep wiping?". It checks every pull against
the Ikuya mit sheet and shows the evidence behind every finding, so nobody gets called out on a guess.

## What it shows (tabs)

- **Summary**: "What to work on", ranked by how many pulls each issue affects, with a *Discord export* button (see below). It also shows
  progress per pull, where pulls end, and a per-player overview.
- **Mechanics**: every sheet mechanic, with how often it was reached, deaths there, pulls that ended there, % of planned mits up,
  damage per player, and which logged ability it was matched to.
- **Carry-overs**: every ➔ chain on the sheet (one press that should cover several hits), whether it lasted each hit, the median
  press time, and the press window that covers every hit.
- **Mit plan**: planned mits that weren't up, why, and what they were used for instead. Assignments your static consistently
  does differently from the sheet are listed separately and aren't blamed for deaths.
- **Deaths**: every death before the wipe-out, with the log facts and a likely cause plus a confidence level.
- **Pulls**: each pull's deaths, carry-overs and mit check, with an FFLogs link.
- **Death tally**: deaths per player by raid week (weekly reset, Tuesday 08:00 UTC) and by month, kept across every
  report analyzed in this browser (see below).
- **How it works & sources**: the method, data self-checks, the sheet-to-log mechanic mapping, and the official data used.

A **Player** filter at the top narrows everything to one person, for 1:1 feedback instead of public callouts.

**Discord export** (Summary, `js/discord.js`) makes text ready to paste, in Discord's own formatting (headings, bullets,
bold, small grey footnotes; links in `<…>` so they don't make preview cards). Discord cuts a message at 2,000 characters,
so anything longer comes in parts marked "(1/2)", each with its own Copy button.
- **Team recap** for the raid channel: pulls, best pull, deaths per pull, mits up and carry-overs held; where pulls go
  wrong (first deaths); closest to pushing; party-wide points (chain wipes, what differed for the players a hit killed);
  up to 3 plan/sheet points. It names nobody unless you tick *Name players in the recap*: plan items use the sheet column
  (MT, D3…).
- **Player notes**, one per player, to send as a DM: their deaths and the 3 worth a look (with FFLogs links at that
  moment), planned mits often not up, carry-overs and how to time the weakest, failure debuffs, and how often they were
  out of range of party heals and shields.

Both follow the Phase and Player filters.

A **Phase** filter narrows every tab to one phase: pulls that reached it, with only that phase's mechanics, deaths,
carry-overs and reference comparison. Pull numbers stay the same. A pull counts under "Where pulls end" for a phase only if its
first death was in that phase.

The Summary also has a **By phase** table:
- how many pulls reached each phase;
- how many had their first death there;
- how many reached the next phase;
- deaths per pull, planned mits up, and carry-overs lasted;
- mits vs the reference clears;
- the most common wipe.

Click a phase there to switch the filter.

## Death tally (`js/tally.js`)

Every analyzed report's deaths go into a ledger saved in this browser (localStorage), so nights add up. Re-analyzing a
report updates its log facts and keeps your callouts and edits. Demo data is never saved.

- **Raid callouts**: paste the night's death notes, one per line, each starting with the pull number shown on the Pulls tab:
  - `#7 Arune - Forsaken - Stack not there` (or `Pull 7: …`) → Arune's death in pull #7.
  - `#21 Calerie + Arune died to statue` → each one's death in pull #21.
  - `#21 Alistar died due to Ryujin no feint` → Alistar's death, counted against Ryujin ("due to", "because of", "caused by").
  - `#24 Arrows too far apart` (no player name first) → a party note, counted against nobody.

  Only lines with a pull number count by themselves. In a wipe or reset everyone dies, so the log can't say whose mistake
  it was: a line without a pull number gets a guess (from line order and mechanic words) that counts against nobody until
  you pick the death in its drop-down. If the player didn't die in the given pull, the line says so.

  **Your names for mechanics** (under the callouts box) help the guesses and pick between two deaths of one player in the
  same pull: `statue, gaze = flagrant fire iii, mystery magic` means "statue" fits a death whose logged ability, sheet
  mechanic or phase contains those words. "8th tower" means the sheet's Towers VIII. Lines like "Deaths:" are skipped.

  Names match on first or last name, a 4+ letter prefix ("Reimui" → Reimu) or one typo. Each line takes that player's
  first unclaimed death in the same pull as the line before or later, preferring one (of their next 3) whose logged
  mechanic contains a word from the line. Matches by order alone are flagged "order only". Re-matching replaces earlier
  callouts for the loaded reports.
- **Mechanical** deaths: counted by a callout or ticked by hand. The log analysis alone never marks one (in a wipe or reset its "Mechanic fail" lands on whoever died first). If a callout names a player who lived through that pull, it goes on the pull's first death and counts against them.
  The tally counts them against the player responsible. Switch to "All deaths" to
  count every death before the wipe-out against who died.
- **Deaths in these pulls**: edit each death's callout, who it counts against (or nobody), and the mechanical tick.
- **Export / Import** the tally as JSON to move it to another browser or merge another officer's copy.

### Private online tally (Supabase, free)

With Supabase set up, the tally is stored online and is **private to one FFLogs account** (the owner). For anyone else,
including people logged in with their own FFLogs account, the Death tally tab doesn't exist and the page never receives
any tally data.

How it's enforced: the table can't be read or written with the public key. Every tally call goes through a database
function that receives the viewer's FFLogs login token, asks FFLogs who it belongs to (`api/v2/user`, `currentUser`)
and only answers for the owner's FFLogs user ID. The header shows the logged-in FFLogs name and ID.

1. Create a free project at https://supabase.com.
2. Open **SQL Editor → New query**, paste `supabase/setup.sql` and click **Run** (safe to run again).
3. Under **Project Settings → API keys**, copy the project URL and the **publishable** key (`sb_publishable_…`, or the
   legacy `anon` key). Put them in `js/config.js` as `supabaseUrl` and `supabaseKey`.
4. Log in with FFLogs on the site. The header shows `FFLogs: logged in as NAME (#ID)`. In the SQL Editor, run
   `insert into public.tally_owner (fflogs_user_id) values (ID) on conflict do nothing;` and reload the page.

Only the FFLogs login button (a public client) identifies a person; a client ID + secret in Settings doesn't, so the
tally stays hidden in that mode. Never put the `service_role` / secret key in `js/config.js`.

Free Supabase projects pause after about a week with no requests. Restore the project from the dashboard if that happens.

### No FFLogs details for the static

Put a public FFLogs client ID in `js/config.js` as `fflogsClientId` (see "Connect to FFLogs", option B, below). The page
then shows a **Log in with FFLogs** button, and Analyze sends people to the FFLogs login. Nobody types a client ID or secret.

## Mit sheets: Ikuya and LPDU

Pick which sheet your pulls are checked against with **Check against** next to Analyze. The options are the Ikuya sheet, the
LPDU sheet, or a custom sheet set in Settings. Both presets use the same tab layout:

| | Ikuya | LPDU |
|---|---|---|
| Clock | phase time | fight time (offset per phase is measured from the log) |
| DPS columns | D1–D4 | M1, M2, R1, R2 (mapped to D1–D4) |
| Cells | one action per "+", ➔ carry-overs | free text: "Kera end of Kefka says castbar", "Addle / Pranged 90s" |

How LPDU cells are read:
- Each piece is matched to an official action by how it starts. For example, "Rep" → Reprisal, "90s" → ranged party mit,
  "Succor" → Concitation (its level-96 name), "Party mit (Hol/Missionary)" → GNB/DRK party mit only.
- "A / B" means whichever applies to the job in that column, e.g. Addle for a caster, ranged party mit for a physical ranged.
- Tank personals ("Kitchen Sink", "Shorts", "Invuln"), positioning notes and heals with nothing to check are listed as not
  checked, never guessed.
- Single-target tools (Aquaveil, Taurochole, Haima…; official range "30y/0y") count as up when they were on the player the hit
  landed on.

Every action now also checks the player can use it: role actions by role (Reprisal tanks, Feint melee, Addle casters),
everything else by its Job Guide page.

## Reference clears

The **Reference clears** tab takes FFLogs links to clears, each with its fight number (`…/reports/CODE?fight=25`). It comes
pre-filled with 8 top-parse clears. Once loaded, they're cached and re-load automatically on Analyze. It answers two separate
questions:

1. **Plan-independent (the fair reference).** For each mechanic, measured from each clear's log:
   - the share of raw damage removed by mits and debuffs ("Mit");
   - the share soaked by shields;
   - HP before the hit;
   - which mit statuses were on the players.

   These are compared with your pulls. This holds whatever mit plan a group runs (Ikuya, LPDU or their own).
2. **Plan agreement.** Each clear (and your static) is scored against every preset sheet: the share of that sheet's
   checkable entries for the clear's jobs that were up at the hit.
   - The sheets differ in detail, so the fair score is **party mits only** (party-wide mits and enemy debuffs).
   - "Closest plan" uses that score, and only when one sheet beats the other by 5+ points and reaches 60%. Otherwise it says
     "can't tell" or "own plan".
   - In the 8 preset clears: 7 are closest to Ikuya (65–83% vs 48–68% for LPDU) and 1 can't be told apart (70% vs 69%).
     Your static (P1/P2 so far) is about equally close to both (59% vs 56%).
   - Sheet entries most clears skip are listed as "the field plays it differently".
   - Entries where clears split are listed as "different plans in use".

Every miss of yours (Mit plan tab, Summary) shows what the clears did at that same sheet entry:
- "clears skip it too: plan/sheet issue": the sheet expects something even top clears don't do.
- "clears do this": a real gap.

Carry-over findings show how often the clears' press lasted every hit and when they pressed. Statuses from jobs your comp
doesn't have (e.g. Temperance with no WHM) are labelled as such.

The sheet-to-log mapping is learned from your pulls and the clears together, so phases you haven't reached are mapped too.
Each phase's clock offset comes from a vote over every same-named hit within ±90s. The sheet's P3 and P5 clocks start about
45s and 40s before FFLogs' phase start.

## Times

Times are shown on both clocks:
- **Sheet mechanics** use the sheet's own columns. "Wings of Destruction 2:54 · 6:11 into pull" means 2:54 into Phase 2,
  6:11 from the pull.
- **Logged moments** (a hit, a press, a death) read like "P1 2:57 (2:58 into pull)". The first time is on the sheet's phase
  clock (FFLogs' phase start corrected by the measured offset); the second counts from the pull.
- The two can differ by a second or so even in P1, because the sheet's P1 0:00 isn't exactly the pull. In your log, FFLogs
  starts P1 about 1.1s before the sheet's 0:00.
- With the LPDU sheet (fight clock only) times read just "6:11 into pull".
- "Phase timing" on the Reference tab is when each phase starts, so it's always from the pull.

## Evidence rules

Every fact on the page is tagged with where it comes from:

| Tag | Source |
|---|---|
| **Log** | The FFLogs report: hit times, damage, who pressed what and when, and the statuses on each player when a hit landed (FFLogs' `buffs` field). Buff/debuff apply/remove events say *who* applied a status. |
| **Official** | The official FINAL FANTASY XIV Job Guide (https://na.finalfantasyxiv.com/jobguide/), Patch 7.5, level-100 tooltips. |
| **Math** | Worked out from the two above, e.g. "pressed at 0:31.2 + 15s = ran out at 0:46.2". |

- **"Was the mit up?"** is answered from the log, not from assumed durations. The game calculates each hit about 0.7s before
  the damage shows (FFLogs' `calculateddamage` row). That row's status list decides: a planned mit is up when its status was on
  at least half of the players hit (one player for single-target tools). For Reprisal, Feint, Addle and Dismantle, it's up when
  the game listed the debuff on the hit. Many hits come from helper actors, not the boss the debuff was put on, so the hit
  itself decides.
- **Shields** are often missing from that status list, because they absorb damage instead of reducing it. A shield counts as
  up when the log's apply/remove rows have it on the player when the damage landed, including one removed at that exact moment
  (broken by this hit).
- **Why it wasn't up** is one of these, in this order:
  - Running, but this attack isn't reduced by it (e.g. targeted mitigation on Wave Cannon, which the sheet's notes also say).
  - Replaced by someone else's same effect (e.g. two Reprisals).
  - Shield already used up by earlier damage (not a mistake).
  - Pressed in time but not on most players hit (range).
  - Pressed after the hit.
  - Ran out before the hit.
  - On cooldown from an earlier use.
  - Not pressed.

  Two outcomes are never counted as a player's miss:
  - **Impossible on the sheet**: the sheet asks for the same action twice within its official recast, and the other one was
    done, or the pull ended before it.
  - **Unclear**: pressed in time with everyone in range, but the log doesn't show it on the players and no remove row
    explains why. Check the replay.
- **Attacks that ignore mitigation**: FFLogs' snapshot row carries the game's damage `multiplier`. If an attack's multiplier
  is 1.00 on every snapshot (4 or more in the report) where a mit or enemy debuff was listed, the attack is tagged "ignores
  mitigation" and planned mits there read "attack ignores it", never a miss. In our logs, The Path of Light was 1.00 on all
  177 snapshots, with Kerachole, Sacred Soil, Collective Unconscious, Sun Sign or Temperance up.
- **Damage type** (FFLogs ability `type`) is shown next to each matched attack. It was checked against the multipliers: on
  `1024` hits Addle gave 0.90 and Feint 0.95 (magic); on `128` hits Feint gave 0.90, Addle and Dark Missionary 0.95
  (physical). A magic-only mit (Magick Barrier, Fey Illumination) on a physical attack reads "attack ignores it". Type `32`
  ("darkness") isn't consistent in the logs, so it's shown but not used to judge anything.
- **Healer barriers that can't stack**: Eukrasian Prognosis II / Eukrasian Diagnosis "cannot be stacked with … Galvanize"
  (official). When most players missing a planned barrier already had the other one, it's "overwritten", not a miss.
- **Tank LB3**: a planned LB3 is up when a tank Limit Break status (Shield Wall, Stronghold, Last Bastion, Land Waker, Dark
  Force, Gunmetal Soul) was on at least half the players hit. The LB is shared, so a missing one shows once per mechanic
  as "no tank LB (party)" and isn't counted against either tank.
- **Carry-overs**: each "➔ X" is linked to the cell where X was pressed. The chain "lasted" if X was up at every hit. The press
  window is (last hit − official duration) up to the first hit. Neutral Sect and Summon Seraph shields arrive through a later
  action, so they get no window. When 3+ players' carry-overs break at the same hit, the summary reports it once as a
  party-wide timing/plan issue instead of naming people. A shield that an earlier planned hit uses up can't carry on however
  it's timed, so that's reported as a sheet question with no player named. When 4+ reference clears with that job mostly
  don't hold a carry-over either, it's reported as a sheet issue.
- **Death categories are inferences** with a confidence level:
  - **High**: overkill above max HP, players dying at the same instant with no damage logged, or a vuln still on them.
  - **Medium**: based on how many players a hit usually lands on, missing mits, and HP before the hit.
  - **Low**: no damage logged at all.

  Every death lists the facts behind it, including how many others survived the same hit, their median damage, and statuses
  most others had but the victim didn't (e.g. out of Kerachole range). Check the replay before raising it with someone.
- **Self-checks** (How it works tab):
  - Every duration in the mit catalog must appear verbatim in the official tooltip.
  - Every status name is confirmed against the loaded report (the status the presser applied within 1.5s).
  - Each phase's clock offset between the sheet and the log is measured and corrected. FFLogs started P2 about 11s after the
    sheet's P2 0:00 in our report.
- **Matching caveat**: sheet mechanics with no same-named ability in the log (e.g. "Towers I") are matched by timing to the
  nearest hit on 4+ players. Findings that depend on such a match say so.

- **Late, ran out or used up** is read from each player's status timeline in the log (when the status went on and came off),
  not from the press time. For example: Feint pressed 0.4s before a hit but applied 0.1s after it is "late"; Collective
  Unconscious that came off 0.2s before the hit "ran out".
- **Neutral Sect** shields come from Helios Conjunction cast while it's up, so that cast is what gets checked (and range-checked
  against Helios Conjunction's official 20y).
- **Killing hit** is the instance of the ability that took the player to 0 HP. If the log only has a hit that left them above 0,
  the death says so and is marked low confidence.
- **Positions** come from the x/y FFLogs logs on every cast and every hit taken (the same data its replay uses):
  - Each death shows a mini-map of everyone at the killing hit, plus the victim's last 6s.
  - Facts listed with it: the distance to the nearest player and to the middle of the group, and how far apart the players
    sharing that hit were.
  - When a self-centred mit (Kerachole, Shield Samba, Holos, Expedient…) wasn't on someone, the page measures how far they
    were from the caster at the press and compares that with the official radius (e.g. Kerachole "0y/30y").
  - Positions are centre points and the game adds hitbox size, so within 1y of the edge is reported as borderline.
  - Ground circles (Sacred Soil, Asylum) aren't range-checked, because the log doesn't record where they were placed.

- **Deaths and healing**:
  - For each death the page reads the HP the game had for the player just before the fatal hit (from the hit's own
    snapshot), the damage in the 1.5s before death, and the healing received in the 15s before.
  - If the fatal hit wouldn't have killed them from full HP, the death is put down to entering the hit with low HP (or to
    several hits landing at once). The heals they got are listed, so you can see whether healing was missing or the damage
    outpaced it.
  - A missing mit is only blamed when the planned mits would have brought the hit below the HP they had.
  - FFLogs adds duplicate "Combined HoTs" rows under Limit Break; those are dropped so healing isn't counted twice.
- **Tank deaths**: for a tank killed by a hit below their max HP, the page lists the tank cooldowns on them at the fatal hit
  (the game's status list, plus barriers from the apply/remove rows), the big ones (60s+ recast) still on cooldown, and the
  ones ready and unused. For each ready one it works out from the official % whether it alone would have kept them alive;
  invulns always would. Short gauge/charge tools (Sheltron, Bloodwhetting, TBN, Oblation, Heart of Corundum) aren't counted
  as "saved". A Dark Knight who died while Walking Dead (no Undead Rebirth) is "Walking Dead not healed", with the healing
  that landed vs the max HP the tooltip says was needed. FFLogs doesn't log Walking Dead itself, so its start is read from
  Living Dead coming off early (well before its 10s, when HP hit 0). The healers' single-target tools are listed the same
  way: on the tank at the hit (Aquaveil, Exaltation, Taurochole, Haima, Intersection, Benison, E. Diagnosis, Adloquium),
  and ready and unused (single-charge tools with a 45s+ recast only: Aquaveil, Exaltation, Haima, Taurochole). Press data
  for tank cooldowns is only in downloads made after this was added; clear the cached events to refetch.
- **Multi-hit mechanics**: every hit of the same attack on a player (until the next sheet row, max 10s) is recorded. A mit or
  enemy debuff that was up for the first hit but missing from most of the players hit again at a later hit is "ran out",
  naming the hit (e.g. "hit 2 of 3"). Later hits on only a few players (someone taking an extra tower) are ignored.
- **Debuffs that are part of a mechanic**: many attacks give a vuln to everyone they hit by design (in DMU: Double-Trouble
  Trap on 99% of its hits, Wave Cannon 99%, Spellwave 93%). From the loaded pulls the page learns, per attack, how often a hit
  comes with each vuln / Damage Down. Such a debuff counts as part of the mechanic when the attack gives it on 60%+ of its
  hits (5+ hits, 3+ pulls) and shows up in 30%+ of the pulls that lasted long enough to see it. The 30% allows for
  mechanics that pick one of several attacks per pull (Indulgent / Idyllic / Indolent Will). Fail-only attacks (Unmitigated
  Explosion, Blizzard III Blowout) show up in far fewer pulls, so their debuffs still count as failures. Debuffs that are
  part of a mechanic never make a death a "mechanic failed earlier" case; the death's facts say so.
- **Failure signals and chain wipes**: vulns and Damage Down that aren't part of a mechanic are collected for everyone,
  dead or alive. The person who fails a mechanic often survives it. When 5+ players die within 3s, the pull is a chain
  wipe: its summary says so, lists personal failure debuffs from the 30s before (or says there were none), and nobody's
  "Died first" count goes up for it. The Players table also counts each player's failure debuffs, and how many they lived
  through (a Damage Down that didn't kill still costs damage).
- **Out of range**: for every press of a party-wide action centred on its caster (official range "0y/Ny": E.Prog,
  Helios Conjunction, Kerachole, Holos, Panhaima, Celestial Opposition, Divine Veil, Shield Samba…), the players who were
  alive, more than N+1y from the caster (logged positions; the game adds hitbox size) and didn't get the effect. Counted per
  player in the Players table; anyone with 5+ gets a Summary finding.
- **Same hit, different outcome** (Mechanics tab): for each mechanic that killed some players and not others, the median
  raw damage, shield, party mits on them and HP going in for those who died vs those who lived, plus a one-line read:
  far more raw damage (an extra hit or the wrong spot: a mechanic problem), less shield, fewer mits, or less HP going in.
  Deaths after the pull was already lost are left out.
- **Where pulls ended**: "Most common first death" files a pull under its first death. "Closest to pushing" lists pulls
  that wiped with 10% or less of the boss's HP left (FFLogs' figure), by where they actually ended, noting the ones that
  recovered from an earlier death.
- **Tank swaps on the sheet**: a note above a tab's header that moves a tank job to the other column "from this point
  onwards" (LPDU P3: the Paladin becomes offtank) swaps the MT/OT players for that phase and every later one.
- **Reference clears**: "kept off" = 1 − (damage taken incl. overkill) / unmitigated damage. The mit, shield and kept-off
  shares are pooled over every hit (total kept off ÷ total raw damage), so mit + shield always equals kept off. Large
  failed hits weigh more than in a median. Comparisons with fewer than 4 clears that have that job are marked "too few".

**Not covered / known limits:**
- Ground telegraphs and waymarks (the log has player and enemy positions, not AoE shapes).
- Limit Break other than a planned tank LB3.
- The LPDU sheet's "Fake Melee Extras" column.
- Sheet rows with no logged hit are judged on press timing only, and say so.

## Run it

```bash
powershell -ExecutionPolicy Bypass -File serve.ps1
```

Then open http://localhost:8000/. Click **Try with demo data** to see a report built from made-up pulls.

To share it with the static, put these files on any static host (GitHub Pages works) and use option B below.

## Connect to FFLogs

Create a client at https://www.fflogs.com/api/clients/, then open **Settings**:

- **Option A (just you):** paste the client ID and secret. They're stored in your browser's localStorage and only sent to fflogs.com.
- **Option B (shared page):** create the client as a *public client* and set its redirect URL to exactly what the Settings
  dialog shows. Everyone then clicks "Log in with FFLogs".

Paste one or more report links (one per prog night). Use **Only the last N pulls** to focus on recent pulls. Downloaded events
are cached in the browser (IndexedDB), so re-analyzing is instant. *Settings → Clear cached events* resets that.

## Roster

The sheet's columns are MT, OT, White Mage, Astrologian, Scholar, Sage, and D1 to D4. Healers map to their job's column.
MT/OT, D1/D2 and D3/D4 are picked by trying each swap and keeping the one where the most planned mits match what was actually
pressed. Fix anything wrong in the Roster box and click **Re-check with this roster**.

## Updating the official data after a patch

`js/jobguide.js` is generated from the official Job Guide pages:

```bash
bash tools/extract-jobguide.sh
```

It downloads the 21 job pages, extracts the actions listed in `tools/names.txt`, and rewrites `js/jobguide.js` with the patch
number. Then open the page: the "Data checks" panel flags any catalog duration that no longer matches the official text
(durations live in `js/mits.js`).

## Files

- `js/jobguide.js`: official tooltip text, level, recast and range for 95 defensive/support actions (generated)
- `js/mits.js`: mit catalog (kind, statuses, duration), sheet shorthand (Spreadlo, Zoe Shields…), "Party Mit" per job, self-check
- `js/plan.js`: loads the mit sheet from Google Sheets and links each ➔ carry-over to its original press
- `js/fflogs.js`: FFLogs auth (client credentials or PKCE login), GraphQL, event paging, cache
- `js/analyze.js`: mechanic matching, mit and carry-over checks, death recaps, totals
- `js/app.js`: the page
- `js/tally.js`: death ledger, callout matching, weekly / monthly tally
- `js/cloud.js`: shared tally in Supabase (REST, no library); `supabase/setup.sql`: its table and the FFLogs-owner check
- `js/config.js`: public site settings (FFLogs public client ID, Supabase URL + publishable key)
- `js/demo.js`: made-up demo data
- `tools/`: the official-data extractor
