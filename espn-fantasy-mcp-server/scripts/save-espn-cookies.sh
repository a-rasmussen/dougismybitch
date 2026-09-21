#!/bin/bash
# Save your ESPN cookies for the espn-fantasy MCP server. Claude Desktop can stay OPEN.
# Cookies go to ~/.config/espn-fantasy/credentials.json (readable only by you),
# NOT to Claude Desktop's config file, which Claude Desktop rewrites on its own.
# Usage:  bash ~/Repos/dougismybitch/espn-fantasy-mcp-server/scripts/save-espn-cookies.sh
set -uo pipefail
NODE="/opt/homebrew/bin/node"
DIR="$HOME/.config/espn-fantasy"; FILE="$DIR/credentials.json"
LEAGUE=1340458779

printf '\e[?2004l'
echo "In Chrome: fantasy.espn.com -> Cmd+Opt+I -> Application -> Cookies -> https://fantasy.espn.com"
printf 'Paste espn_s2 value (hidden), then Enter: '
IFS= read -rs RAW_S2; echo
printf 'Paste SWID value INCLUDING {braces} (hidden), then Enter: '
IFS= read -rs RAW_SWID; echo
printf '\e[?2004h'

mkdir -p "$DIR" && chmod 700 "$DIR"
export RAW_S2 RAW_SWID FILE
python3 - <<'PY' || exit 1
import json, os, re
def clean(v):
    v = re.sub(r'\x1b\[[0-9;?]*[~A-Za-z]', '', v)
    return ''.join(c for c in v if 32 < ord(c) < 127)
s2, swid = clean(os.environ['RAW_S2']), clean(os.environ['RAW_SWID'])
if len(s2) < 100: raise SystemExit(f"espn_s2 looks too short ({len(s2)} chars) - copy the whole value and rerun.")
if not re.fullmatch(r'\{[0-9A-Fa-f-]{36}\}', swid): raise SystemExit("SWID should look like {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX} with braces - rerun.")
f = os.environ['FILE']
fd = os.open(f, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as fh: json.dump({"espn_s2": s2, "swid": swid}, fh)
os.chmod(f, 0o600)
print("Saved to", f)
PY

echo; echo "Testing your league..."
FILE="$FILE" LEAGUE="$LEAGUE" "$NODE" --input-type=module -e '
import fs from "fs";
const c = JSON.parse(fs.readFileSync(process.env.FILE,"utf8"));
const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/${process.env.LEAGUE}?view=mTeam&view=mSettings`;
try {
  const r = await fetch(url, {headers: {Cookie: `espn_s2=${c.espn_s2}; SWID=${c.swid}`}});
  if (r.status !== 200) { console.log(`ESPN said HTTP ${r.status}. ${r.status===401?"Cookies were rejected - copy them again and rerun.":""}`); process.exit(1); }
  const j = await r.json();
  console.log(`SUCCESS - connected to "${j.settings?.name ?? "league"}" with ${j.teams?.length} teams.`);
} catch (err) { console.log("Network error:", err.message, err.cause?.message ?? ""); process.exit(1); }
' && echo "Done. No restart needed for the cookies."
