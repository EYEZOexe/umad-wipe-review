#!/usr/bin/env bash
# Rebuilds js/jobguide.js from the official FFXIV Job Guide pages.
# Usage (Git Bash / Linux / macOS): bash tools/extract-jobguide.sh
set -euo pipefail
export LC_ALL=C.UTF-8
cd "$(dirname "$0")"
work=$(mktemp -d)
for j in paladin warrior darkknight gunbreaker whitemage scholar astrologian sage monk dragoon ninja samurai reaper viper bard machinist dancer blackmage summoner redmage pictomancer; do
  curl -sfL -A "Mozilla/5.0" -o "$work/$j.html" "https://na.finalfantasyxiv.com/jobguide/$j/"
  awk -v JOB="$j" -f extract-actions.awk "$work/$j.html"
done > "$work/actions.tsv"
patch=$(grep -oh 'Patch [0-9.]*' "$work/paladin.html" | head -1 | cut -d' ' -f2)
NAMES=$(sed -n 's/^NAMES=//p' names.txt)
{
  echo "// GENERATED from the official FINAL FANTASY XIV Job Guide (https://na.finalfantasyxiv.com/jobguide/), Patch $patch pages,"
  echo "// fetched $(date +%F). 'text' is the official level-100 tooltip, verbatim (line breaks shown as ' | ')."
  echo "// Do not edit by hand: re-run tools/extract-jobguide.sh after a patch."
  echo "export const JOB_GUIDE_PATCH = '$patch';"
  echo "export const JOB_GUIDE = {"
  awk -F'\t' -v names="$NAMES" -f gen-jobguide.awk "$work/actions.tsv"
  echo "};"
} > ../js/jobguide.js
echo "Wrote js/jobguide.js ($(grep -c 'job:' ../js/jobguide.js) actions, patch $patch)"
