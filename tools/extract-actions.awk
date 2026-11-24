# Extract action rows from an official FFXIV job guide page -> TSV: job, name, level, recast, range, radius, description
/<tr id="(pve_action|role_action|pve_role)/ || /<tr id="[a-z_]*action__/ { inrow=1; name=""; lv=""; rec=""; rng=""; desc=""; incontent=0; inrange=0; next }
inrow && /<strong>/ && name=="" { s=$0; gsub(/.*<strong>|<\/strong>.*/,"",s); name=s }
inrow && /<p>Lv\. [0-9]+<\/p>/ && lv=="" { s=$0; gsub(/.*Lv\. |<\/p>.*/,"",s); lv=s }
inrow && /class="recast"/ { s=$0; gsub(/.*class="recast">|<\/td>.*/,"",s); rec=s }
inrow && /class="distant_range"/ { inrange=1; next }
inrow && inrange { if ($0 ~ /<\/td>/) inrange=0; else { s=$0; gsub(/<[^>]*>/,"",s); gsub(/[ \t]/,"",s); rng = rng (rng==""?"":"/") s } ; next }
inrow && /class="content"/ { incontent=1; next }
inrow && incontent { if ($0 ~ /<\/td>/) { incontent=0 } else { s=$0; gsub(/<br>/," | ",s); gsub(/<[^>]*>/,"",s); gsub(/^[ \t]+|[ \t]+$/,"",s); if (s!="") desc = desc (desc==""?"":" ") s } ; next }
inrow && /<\/tr>/ { inrow=0; if (name!="") print JOB "\t" name "\t" lv "\t" rec "\t" rng "\t" desc }
