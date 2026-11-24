function js(s) { gsub("\"", "\\\"", s); gsub(/  +/, " ", s); return "\"" s "\"" }
BEGIN { n = split(names, a, "|"); for (i = 1; i <= n; i++) want[a[i]] = 1 }
($2 in want) && !seen[$2]++ {
  printf "  %s: { job: %s, level: %s, recast: %s, range: %s, url: %s, text: %s },\n", js($2), js($1), ($3 == "" ? "null" : $3), js($4), js($5), js("https://na.finalfantasyxiv.com/jobguide/" $1 "/"), js($6)
}
