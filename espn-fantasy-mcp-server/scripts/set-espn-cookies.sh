#!/bin/bash
# Add the espn-fantasy MCP server + your ESPN cookies to Claude Desktop, then verify.
# Claude Desktop must be QUIT while this runs (it overwrites its config file while open).
# Usage:  bash ~/Repos/dougismybitch/espn-fantasy-mcp-server/scripts/set-espn-cookies.sh
set -uo pipefail

CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
NODE="/opt/homebrew/bin/node"
SERVER_DIR="$HOME/Repos/dougismybitch/espn-fantasy-mcp-server"
LEAGUE=1340458779

[ -f "$CFG" ] || { echo "Config not found: $CFG"; exit 1; }
[ -x "$NODE" ] || { echo "Node not found at $NODE"; exit 1; }

# 1. Claude Desktop must be closed, or it will overwrite our change.
while pgrep -qf "/Applications/Claude.app/Contents/MacOS/Claude$"; do
  echo "Claude Desktop is still open. Quit it now (click it, then Cmd+Q). Waiting..."
  sleep 5
done
echo "Claude Desktop is closed. Good."
echo

# 2. Read cookies. Turn off bracketed-paste so Terminal doesn't inject escape codes.
printf '\e[?2004l'
echo "In Chrome: fantasy.espn.com -> Cmd+Opt+I -> Application -> Cookies -> https://fantasy.espn.com"
printf 'Paste espn_s2 value (hidden), then Enter: '
IFS= read -rs RAW_S2; echo
printf 'Paste SWID value INCLUDING {braces} (hidden), then Enter: '
IFS= read -rs RAW_SWID; echo
printf '\e[?2004h'

export RAW_S2 RAW_SWID CFG SERVER_DIR NODE LEAGUE
python3 - <<'PY' || exit 1
import json, os, re, shutil, time
def clean(v):
    v = re.sub(r'\x1b\[[0-9;?]*[~A-Za-z]', '', v)       # strip terminal escape codes
    return ''.join(c for c in v if 32 < ord(c) < 127)    # drop spaces/control/non-ASCII
s2, swid = clean(os.environ['RAW_S2']), clean(os.environ['RAW_SWID'])
if len(s2) < 100:
    raise SystemExit(f"espn_s2 looks too short ({len(s2)} chars) - copy the whole value and rerun.")
if not re.fullmatch(r'\{[0-9A-Fa-f-]{36}\}', swid):
    raise SystemExit("SWID should look like {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX} with braces - rerun.")
p = os.environ['CFG']
shutil.copy2(p, p + '.bak-' + time.strftime('%Y%m%d-%H%M%S'))
d = json.load(open(p))
d.setdefault('mcpServers', {})['espn-fantasy'] = {
    "command": os.environ['NODE'],
    "args": [os.environ['SERVER_DIR'] + "/dist/index.js"],
    "env": {"ESPN_LEAGUE_ID": os.environ['LEAGUE'], "ESPN_SEASON": "2026",
            "ESPN_S2": s2, "ESPN_SWID": swid},
}
json.dump(d, open(p, 'w'), indent=2)
print("Saved to Claude Desktop config (backup made).")
PY

# 3. Verify with the saved values.
echo
echo "Testing your league..."
"$NODE" --input-type=module -e '
import fs from "fs";
const e = JSON.parse(fs.readFileSync(process.env.CFG,"utf8")).mcpServers["espn-fantasy"].env;
const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/${e.ESPN_LEAGUE_ID}?view=mTeam`;
try {
  const r = await fetch(url, {headers: {Cookie: `espn_s2=${e.ESPN_S2}; SWID=${e.ESPN_SWID}`}});
  if (r.status !== 200) { console.log(`ESPN said HTTP ${r.status}. ${r.status===401?"Cookies were rejected - copy them again and rerun.":""}`); process.exit(1); }
  const j = await r.json();
  console.log(`SUCCESS - connected to "${j.settings?.name ?? "league"}" with ${j.teams?.length} teams:`);
  for (const t of j.teams ?? []) console.log(`  ${t.name ?? ((t.location??"")+" "+(t.nickname??"")).trim()}  (${t.record?.overall?.wins ?? 0}-${t.record?.overall?.losses ?? 0})`);
} catch (err) { console.log("Network error:", err.message, err.cause?.message ?? ""); process.exit(1); }
' && { echo; echo "All set. Reopen Claude Desktop now."; }
