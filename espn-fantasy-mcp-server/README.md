# espn-fantasy-mcp-server

Read-only MCP server for ESPN Fantasy Football. Lets Claude Desktop read your league: settings, standings, rosters, matchups, box scores, schedules, draft results, free agents, player lookups, and transaction/activity history.

It talks to ESPN's undocumented v3 API (`lm-api-reads.fantasy.espn.com`). ESPN can change this API without notice; if a tool starts failing, that is the most likely reason.

## Tools

| Tool | What it returns |
|---|---|
| `espn_get_league_settings` | Roster slots, scoring rules (PPR etc.), waivers/FAAB, trade deadline, playoffs, draft |
| `espn_list_teams` | Standings with owners, record, PF/PA, streak, waiver priority, FAAB spent |
| `espn_get_roster` | One team's (or all teams') roster with season + weekly points/projections |
| `espn_get_draft_results` | Every draft pick (filter by round or team) |
| `espn_get_matchups` | Weekly scoreboard |
| `espn_get_box_score` | Player-level box score for one team's matchup |
| `espn_get_team_schedule` | Season schedule/results for one team |
| `espn_list_free_agents` | Waiver wire, filter by position, sort by weekly/season projection, points, %owned, ADP |
| `espn_search_players` | Find any player by name, see who owns them |
| `espn_get_player` | Player detail with week-by-week actual vs projected |
| `espn_get_recent_activity` | Full-season activity feed: adds, drops, waiver bids, trades |
| `espn_list_transactions` | Current-week transaction queue incl. pending waiver claims and trade proposals |

All tools accept `response_format: "markdown"` (default, compact) or `"json"` (full structured data).

## Setup on a Mac (Claude Desktop)

### Step 1 — Install Node.js (once)

Open **Terminal** (Cmd+Space, type "Terminal") and run:

```bash
node -v
```

If you see a version like `v22.x`, skip ahead. Otherwise install it: go to https://nodejs.org, download the **LTS** installer, run it, then re-open Terminal and check `node -v` again.

### Step 2 — Put the server somewhere permanent

Unzip `espn-fantasy-mcp-server.zip` and move the folder to your home directory so the path is `/Users/<you>/espn-fantasy-mcp-server`. Then in Terminal:

```bash
cd ~/espn-fantasy-mcp-server
npm install
npm run build
```

`npm install` downloads the two dependencies; `npm run build` compiles the TypeScript into `dist/index.js`. Both should finish without red error text.

### Step 3 — Copy your two ESPN cookies

Private leagues are only visible to logged-in members, so the server needs the same two cookies your browser sends. They are just copied once; they are not your password.

1. In Chrome, go to https://fantasy.espn.com and make sure you're logged in.
2. Press **Cmd+Option+I** to open DevTools.
3. Click the **Application** tab (if hidden, click the `»` overflow arrow).
4. In the left sidebar, expand **Cookies** and click `https://fantasy.espn.com`.
5. In the filter box, type `espn_s2`. Double-click the **Value** cell, Cmd+A, Cmd+C. It's a very long string ending in `%3D` or similar. Paste it somewhere temporary.
6. Now filter for `SWID`. Copy its value — it looks like `{1A2B3C4D-1234-5678-ABCD-1234567890AB}` **including the braces**.

These cookies usually last for months, but they do expire. If the server starts returning "not authorized," repeat this step with fresh values.

### Step 4 — Tell Claude Desktop about the server

1. Open Claude Desktop → menu bar **Claude → Settings… → Developer → Edit Config**. This opens `claude_desktop_config.json` in Finder.
2. Open that file in TextEdit and make it look like this (if there is already an `mcpServers` block, add the `espn-fantasy` entry inside it):

```json
{
  "mcpServers": {
    "espn-fantasy": {
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/espn-fantasy-mcp-server/dist/index.js"],
      "env": {
        "ESPN_LEAGUE_ID": "1340458779",
        "ESPN_SEASON": "2026",
        "ESPN_S2": "PASTE_ESPN_S2_VALUE_HERE",
        "ESPN_SWID": "{PASTE-SWID-HERE-WITH-BRACES}"
      }
    }
  }
}
```

Replace `YOUR_USERNAME` with your Mac username (run `whoami` in Terminal if unsure). If `node` isn't found by Claude Desktop, replace `"command": "node"` with the full path from running `which node` in Terminal (often `/usr/local/bin/node` or `/opt/homebrew/bin/node`).

3. Save, then fully quit Claude Desktop (Cmd+Q) and reopen it.
4. In a new chat, click the tools/connectors icon — you should see **espn-fantasy** with 12 tools. Try: *"Show me my league standings."*

### Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `ESPN_S2` | for private leagues | `espn_s2` cookie |
| `ESPN_SWID` | for private leagues | `SWID` cookie, with braces |
| `ESPN_LEAGUE_ID` | optional | Default league so you don't have to say the ID every time |
| `ESPN_SEASON` | optional | Default season year (auto-detects otherwise) |

## Testing without Claude Desktop

```bash
npm run build
node scripts/smoke.mjs                                  # runs a few public calls
node scripts/smoke.mjs espn_list_teams '{"league_id":48347143,"season":2025}'   # a public league
ESPN_S2=... ESPN_SWID=... node scripts/smoke.mjs espn_list_teams '{"league_id":1340458779}'
```

Or use the MCP Inspector: `npx @modelcontextprotocol/inspector node dist/index.js`.

## Security notes

- Read-only: no tool can change lineups, make claims, or trade. ESPN's write API is not implemented.
- Cookies live only in your local `claude_desktop_config.json`. Don't share that file or paste the cookies into chats.
- The server makes requests only to `lm-api-reads.fantasy.espn.com`.

## Known limitations

- ESPN's player pool does not return a total count, so `has_more` is inferred from a full page.
- `espn_list_transactions` (view `mTransactions2`) only holds current/recent transactions; `espn_get_recent_activity` is the season-long feed. The activity feed's message format follows the community-documented structure in [cwendt94/espn-api](https://github.com/cwendt94/espn-api); it could not be tested against a public league (ESPN restricts the feed to members), so verify on first use.
- Weekly "actual" points appear only after games are played.
