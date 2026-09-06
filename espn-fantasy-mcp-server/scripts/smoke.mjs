// Smoke test: spawn the server over stdio and call a few tools.
// Usage: node scripts/smoke.mjs [tool] [jsonArgs]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env } });
const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const calls = process.argv[2]
  ? [[process.argv[2], JSON.parse(process.argv[3] ?? "{}")]]
  : [
      ["espn_list_free_agents", { position: "RB", sort_by: "projected_season", limit: 5 }],
      ["espn_search_players", { name: "gibbs", limit: 3 }],
      ["espn_get_player", { player_id: 4429795 }],
      ["espn_get_league_settings", { league_id: 1340458779 }],
    ];
for (const [name, args] of calls) {
  console.log(`\n=== ${name} ${JSON.stringify(args)}`);
  const r = await client.callTool({ name, arguments: args });
  console.log(r.isError ? "ERROR:" : "", r.content[0].text.slice(0, 1800));
}
await client.close();
