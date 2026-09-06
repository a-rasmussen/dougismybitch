#!/usr/bin/env node
/**
 * espn-fantasy-mcp-server — read-only MCP server for ESPN Fantasy Football.
 *
 * Environment variables:
 *   ESPN_LEAGUE_ID  default league id (optional; tools accept league_id too)
 *   ESPN_S2         espn_s2 cookie (required for private leagues)
 *   ESPN_SWID       SWID cookie including braces, e.g. {ABCDEF12-...}
 *   ESPN_SEASON     override season year (optional)
 *
 * Transport: stdio (for Claude Desktop). Logs go to stderr only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerLeagueTools } from "./tools/league.js";
import { registerMatchupTools } from "./tools/matchups.js";
import { registerPlayerTools } from "./tools/players.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { loadAuthFromEnv, defaultLeagueId } from "./services/espnClient.js";
import { defaultSeason } from "./constants.js";

const server = new McpServer({ name: "espn-fantasy-mcp-server", version: "1.0.0" });

registerLeagueTools(server);
registerMatchupTools(server);
registerPlayerTools(server);
registerTransactionTools(server);

async function main(): Promise<void> {
  const auth = loadAuthFromEnv();
  const lid = defaultLeagueId();
  if (!auth.espnS2 || !auth.swid) {
    console.error("[espn-fantasy-mcp-server] WARNING: ESPN_S2 / ESPN_SWID not set — only public leagues and the default player pool will work.");
  }
  if (auth.swid && !/^\{[0-9A-Fa-f-]{36}\}$/.test(auth.swid)) {
    console.error("[espn-fantasy-mcp-server] WARNING: ESPN_SWID should look like {XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX} including the braces.");
  }
  console.error(`[espn-fantasy-mcp-server] starting · season ${defaultSeason()} · default league ${lid ?? "(none)"} · auth ${auth.espnS2 && auth.swid ? "cookies loaded" : "none"}`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[espn-fantasy-mcp-server] fatal:", err);
  process.exit(1);
});
