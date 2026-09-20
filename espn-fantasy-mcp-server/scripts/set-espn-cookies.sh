#!/bin/bash
# Paste your two ESPN cookies into claude_desktop_config.json, then verify.
# Usage:  bash ~/Repos/dougismybitch/espn-fantasy-mcp-server/scripts/set-espn-cookies.sh
set -euo pipefail

CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
NODE="${NODE:-/opt/homebrew/bin/node}"
SERVER_DIR="$HOME/Repos/dougismybitch/espn-fantasy-mcp-server"

[ -f "$CFG" ] || { echo "Config not found: $CFG"; exit 1; }

echo "Get these from Chrome at https://fantasy.espn.com:"
echo "  DevTools (Cmd+Opt+I) -> Application -> Cookies -> https://fantasy.espn.com"
echo
printf 'Paste espn_s2 value (input hidden), then Enter: '
read -rs ESPN_S2; echo
printf 'Paste SWID value INCLUDING the {braces}, then Enter: '
read -rs ESPN_SWID; echo

[ -n "$ESPN_S2" ] && [ -n "$ESPN_SWID" ] || { echo "Both values are required."; exit 1; }
case "$ESPN_SWID" in "{"*"}") ;; *) echo "Warning: SWID usually looks like {XXXXXXXX-....}"; ;; esac

cp "$CFG" "$CFG.bak-$(date +%Y%m%d-%H%M%S)"

ESPN_S2="$ESPN_S2" ESPN_SWID="$ESPN_SWID" CFG="$CFG" python3 - <<'PY'
import json, os
p = os.environ['CFG']
d = json.load(open(p))
srv = d.setdefault('mcpServers', {}).setdefault('espn-fantasy', {})
srv.setdefault('env', {})
srv['env']['ESPN_S2'] = os.environ['ESPN_S2']
srv['env']['ESPN_SWID'] = os.environ['ESPN_SWID']
json.dump(d, open(p, 'w'), indent=2)
print("Config updated.")
PY

echo
echo "Verifying against league 1340458779 ..."
cd "$SERVER_DIR"
if ESPN_S2="$ESPN_S2" ESPN_SWID="$ESPN_SWID" "$NODE" scripts/smoke.mjs espn_list_teams '{"league_id":1340458779}' 2>&1 | head -20; then
  echo
  echo "If you see your standings above, quit Claude Desktop (Cmd+Q) and reopen it."
else
  echo "Verification failed - check that the cookies were pasted correctly."
fi
