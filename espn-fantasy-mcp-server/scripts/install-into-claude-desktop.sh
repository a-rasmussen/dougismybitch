#!/bin/bash
# Quit Claude Desktop, add the espn-fantasy entry to its config (no cookies in it), relaunch.
# Meant to run detached (launchd) so it survives Claude Desktop quitting. Log: /tmp/espn-install.log
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
APP="/Applications/Claude.app/Contents/MacOS/Claude"
exec >>/tmp/espn-install.log 2>&1
echo "=== $(date) start"
sleep 3
osascript -e 'tell application "Claude" to quit'
for i in $(seq 1 60); do ps -axo comm | grep -qx "$APP" || break; sleep 1; done
if ps -axo comm | grep -qx "$APP"; then echo "Claude did not quit; aborting"; exit 1; fi
echo "Claude quit at $(date +%T)"
sleep 2
python3 - "$CFG" <<'PY'
import json, shutil, sys, time
p = sys.argv[1]
shutil.copy2(p, p + '.bak-' + time.strftime('%Y%m%d-%H%M%S'))
d = json.load(open(p))
d.setdefault('mcpServers', {})['espn-fantasy'] = {
  "command": "/opt/homebrew/bin/node",
  "args": ["/Users/angie/Repos/dougismybitch/espn-fantasy-mcp-server/dist/index.js"],
  "env": {"ESPN_LEAGUE_ID": "1340458779", "ESPN_SEASON": "2026"}}
json.dump(d, open(p, 'w'), indent=2)
print("entry written; keys now", list(d.keys()))
PY
open -a Claude
echo "relaunched at $(date +%T)"
sleep 45
python3 -c "import json;d=json.load(open('$CFG'));print('45s after launch, entry present:', 'espn-fantasy' in d.get('mcpServers',{}))"
grep -i "espn" "$HOME/Library/Logs/Claude/mcp.log" | tail -5
echo "=== done"
