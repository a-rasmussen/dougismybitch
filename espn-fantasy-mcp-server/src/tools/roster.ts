/** Roster-changing tools: lineup moves and free-agent add/drop. These are the only tools that write to ESPN. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultSeason, SLOT_MAP } from "../constants.js";
import { EspnApiError, espnPost, getLeague, loadAuthFromEnv } from "../services/espnClient.js";
import { leagueIdSchema, seasonSchema, teamDisplayName, teamNameMap, slotName, positionOf, proTeamOf, idsFilter, toolResult, toolError } from "../services/format.js";
import type { EspnLeague, EspnRosterEntry, EspnTeam, EspnTransaction } from "../types.js";

const SLOT_LABELS = ["QB", "RB", "WR", "TE", "FLEX", "D/ST", "K", "BE", "IR"] as const;
const SLOT_ID: Record<string, number> = Object.fromEntries(Object.entries(SLOT_MAP).map(([id, label]) => [label, Number(id)]));
const BENCH = 20;
const IR = 21;

const confirmSchema = z
  .boolean()
  .default(false)
  .describe("false (default) = preview only: validate and describe the change without touching ESPN. true = execute it for real.");

interface Ctx { league: EspnLeague; season: number; week: number; team: EspnTeam; entries: EspnRosterEntry[]; swid: string }

/** Load the league and the team the logged-in member manages. Writes are only ever made to that team. */
async function loadContext(leagueId: number | undefined, season: number | undefined, teamId: number | undefined, week?: number): Promise<Ctx> {
  const { swid } = loadAuthFromEnv();
  if (!swid) throw new EspnApiError("Changing a roster requires ESPN_S2 and ESPN_SWID cookies (run scripts/save-espn-cookies.sh).");
  const yr = season ?? defaultSeason();
  const league = await getLeague(leagueId, yr, ["mTeam", "mRoster", "mSettings"], week !== undefined ? { scoringPeriodId: week } : undefined);
  const mine = (league.teams ?? []).filter((t) => (t.owners ?? []).some((o) => o.toLowerCase() === swid.toLowerCase()));
  if (!mine.length) throw new EspnApiError("The saved ESPN cookies don't belong to a manager of any team in this league, so there is no roster to change.");
  const team = teamId !== undefined ? mine.find((t) => t.id === teamId) : mine[0];
  if (!team) throw new EspnApiError(`Team ${teamId} isn't managed by the logged-in ESPN account (yours is team ${mine.map((t) => t.id).join(", ")}). Only your own roster can be changed.`);
  if (week !== undefined && week < league.scoringPeriodId) throw new EspnApiError(`Week ${week} is already over (current week is ${league.scoringPeriodId}).`);
  return { league, season: yr, week: week ?? league.scoringPeriodId, team, entries: team.roster?.entries ?? [], swid };
}

function label(e: EspnRosterEntry): string {
  const p = e.playerPoolEntry.player;
  return `${p.fullName} (${positionOf(p)}, ${proTeamOf(p)})`;
}

async function submit(ctx: Ctx, type: "ROSTER" | "FREEAGENT", items: Record<string, unknown>[]): Promise<EspnTransaction> {
  return espnPost<EspnTransaction>(`/seasons/${ctx.season}/segments/0/leagues/${ctx.league.id}/transactions/`, {
    isLeagueManager: false,
    teamId: ctx.team.id,
    type,
    memberId: ctx.swid,
    scoringPeriodId: ctx.week,
    executionType: "EXECUTE",
    items,
  });
}

const PREVIEW_FOOTER = "\n\nPREVIEW ONLY - nothing was changed. Call again with confirm=true to execute.";

export function registerRosterTools(server: McpServer): void {
  server.registerTool(
    "espn_set_lineup",
    {
      title: "Move players between lineup slots (WRITES to ESPN)",
      description: `Change YOUR team's lineup: move players between starting slots, the bench (BE) and injured reserve (IR). This changes the real roster on ESPN.

All moves are sent as one transaction, so to swap two players list both moves (e.g. starter -> BE and bench player -> RB). A starting slot or IR that is already full must be vacated in the same call.

Args:
  - moves (array, required): [{ player_id, to_slot }] where to_slot is one of ${SLOT_LABELS.join(", ")}. Get player_id and current slots from espn_get_roster.
  - week (number, optional): NFL week whose lineup to set. Defaults to the current week.
  - team_id (number, optional): only needed if the account manages more than one team in the league.
  - confirm (boolean): default false = PREVIEW (validates, changes nothing). Pass true to execute.
  - league_id, season: as in other tools.

Always run a preview first and show the user what will change before calling with confirm=true. Fails if a player is locked (game started), not eligible for the slot, or ESPN rejects the move (e.g. IR needs an IR-eligible injury status).`,
      inputSchema: {
        league_id: leagueIdSchema,
        season: seasonSchema,
        team_id: z.number().int().positive().optional(),
        week: z.number().int().min(1).max(18).optional(),
        moves: z.array(z.object({ player_id: z.number().int(), to_slot: z.enum(SLOT_LABELS) })).min(1).max(20),
        confirm: confirmSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (a) => {
      try {
        const ctx = await loadContext(a.league_id, a.season, a.team_id, a.week);
        const byId = new Map(ctx.entries.map((e) => [e.playerId, e]));
        if (new Set(a.moves.map((m) => m.player_id)).size !== a.moves.length) throw new EspnApiError("Each player can appear in moves only once.");

        const final = new Map(ctx.entries.map((e) => [e.playerId, e.lineupSlotId]));
        const items: Record<string, unknown>[] = [];
        const lines: string[] = [];
        for (const m of a.moves) {
          const e = byId.get(m.player_id);
          if (!e) throw new EspnApiError(`Player ${m.player_id} is not on ${teamDisplayName(ctx.team)}'s roster. Use espn_get_roster for current player ids.`);
          const to = SLOT_ID[m.to_slot];
          if (e.lineupSlotId === to) continue;
          if (e.playerPoolEntry.lineupLocked) throw new EspnApiError(`${label(e)} is locked for week ${ctx.week} (game already started) and can't be moved.`);
          const eligible = e.playerPoolEntry.player.eligibleSlots;
          if (eligible && !eligible.includes(to)) throw new EspnApiError(`${label(e)} is not eligible for the ${m.to_slot} slot.`);
          final.set(m.player_id, to);
          items.push({ playerId: m.player_id, type: "LINEUP", fromLineupSlotId: e.lineupSlotId, toLineupSlotId: to });
          lines.push(`- ${label(e)}: ${slotName(e.lineupSlotId)} -> ${m.to_slot}`);
        }
        if (!items.length) return toolResult("Nothing to do - every listed player is already in the requested slot.");

        const caps = ctx.league.settings?.rosterSettings?.lineupSlotCounts ?? {};
        const counts = new Map<number, number>();
        for (const slot of final.values()) counts.set(slot, (counts.get(slot) ?? 0) + 1);
        for (const [slot, n] of counts) {
          const cap = caps[String(slot)];
          if (cap !== undefined && n > cap) {
            const occupants = ctx.entries.filter((e) => final.get(e.playerId) === slot && !a.moves.some((m) => m.player_id === e.playerId)).map(label);
            throw new EspnApiError(`These moves would put ${n} players in ${slotName(slot)}, which holds ${cap}. Also move one of the current occupants out in the same call: ${occupants.join(", ") || "(none)"}.`);
          }
        }

        const head = `${teamDisplayName(ctx.team)} - week ${ctx.week} lineup`;
        if (!a.confirm) return toolResult(`${head}, proposed moves:\n${lines.join("\n")}${PREVIEW_FOOTER}`, { executed: false, team_id: ctx.team.id, week: ctx.week, items });
        const tx = await submit(ctx, "ROSTER", items);
        return toolResult(`${head}, moves submitted (ESPN status: ${tx.status ?? "unknown"}):\n${lines.join("\n")}`, { executed: true, status: tx.status, transaction_id: tx.id, team_id: ctx.team.id, week: ctx.week, items });
      } catch (e) { return toolError(e); }
    },
  );

  server.registerTool(
    "espn_add_drop",
    {
      title: "Add a free agent and/or drop a player (WRITES to ESPN)",
      description: `Add a free agent to YOUR team, drop a player from it, or both in one transaction. This changes the real roster on ESPN, shows in the league's activity feed, and counts against acquisition limits. A dropped player goes to waivers and can be claimed by another team, so a drop cannot reliably be undone.

Args:
  - add_player_id (number, optional): player to add. Must be a FREE AGENT (see status in espn_list_free_agents / espn_search_players). Players on WAIVERS need a waiver claim, which this tool does not make.
  - drop_player_id (number, optional): player on your roster to drop. Required with add_player_id when the roster is full.
  - team_id (number, optional): only needed if the account manages more than one team in the league.
  - confirm (boolean): default false = PREVIEW (validates, changes nothing). Pass true to execute.
  - league_id, season: as in other tools.

Always run a preview first and get the user's explicit go-ahead on the exact players before calling with confirm=true. The added player lands on the bench; use espn_set_lineup to start him.`,
      inputSchema: {
        league_id: leagueIdSchema,
        season: seasonSchema,
        team_id: z.number().int().positive().optional(),
        add_player_id: z.number().int().optional(),
        drop_player_id: z.number().int().optional(),
        confirm: confirmSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (a) => {
      try {
        if (a.add_player_id === undefined && a.drop_player_id === undefined) throw new EspnApiError("Give add_player_id, drop_player_id, or both.");
        const ctx = await loadContext(a.league_id, a.season, a.team_id);
        const items: Record<string, unknown>[] = [];
        const lines: string[] = [];

        let dropEntry: EspnRosterEntry | undefined;
        if (a.drop_player_id !== undefined) {
          dropEntry = ctx.entries.find((e) => e.playerId === a.drop_player_id);
          if (!dropEntry) throw new EspnApiError(`Player ${a.drop_player_id} is not on ${teamDisplayName(ctx.team)}'s roster. Use espn_get_roster for current player ids.`);
          if (dropEntry.playerPoolEntry.lineupLocked) throw new EspnApiError(`${label(dropEntry)} is locked (game already started) and can't be dropped right now.`);
          if (dropEntry.playerPoolEntry.player.droppable === false) throw new EspnApiError(`ESPN marks ${label(dropEntry)} as undroppable.`);
        }

        if (a.add_player_id !== undefined) {
          if (ctx.entries.some((e) => e.playerId === a.add_player_id)) throw new EspnApiError(`Player ${a.add_player_id} is already on your roster.`);
          const pool = await getLeague(ctx.league.id, ctx.season, ["kona_player_info"], undefined, idsFilter([a.add_player_id]));
          const entry = (pool.players ?? []).find((p) => p.id === a.add_player_id);
          if (!entry) throw new EspnApiError(`No player with id ${a.add_player_id}. Use espn_search_players to find the id.`);
          const who = `${entry.player.fullName} (${positionOf(entry.player)}, ${proTeamOf(entry.player)})`;
          if (entry.onTeamId) throw new EspnApiError(`${who} is already on ${teamNameMap(ctx.league).get(entry.onTeamId) ?? `team ${entry.onTeamId}`}.`);
          if (entry.status === "WAIVERS") throw new EspnApiError(`${who} is on waivers, so he needs a waiver claim, which this tool doesn't make. Place the claim on ESPN, or add him once he clears to free agency.`);
          if (entry.status !== "FREEAGENT") throw new EspnApiError(`${who} is not available to add (status ${entry.status ?? "unknown"}).`);

          const caps = ctx.league.settings?.rosterSettings?.lineupSlotCounts ?? {};
          const capacity = Object.entries(caps).reduce((n, [slot, c]) => (Number(slot) === IR ? n : n + c), 0);
          const active = ctx.entries.filter((e) => e.lineupSlotId !== IR).length;
          const after = active + 1 - (dropEntry && dropEntry.lineupSlotId !== IR ? 1 : 0);
          if (capacity && after > capacity) throw new EspnApiError(`The roster is full (${active} of ${capacity} spots, not counting IR). Pass drop_player_id for a non-IR player to make room.`);
          items.push({ playerId: a.add_player_id, type: "ADD", toTeamId: ctx.team.id });
          lines.push(`- ADD ${who} -> ${slotName(BENCH)}`);
        }
        if (dropEntry) {
          items.push({ playerId: dropEntry.playerId, type: "DROP", fromTeamId: ctx.team.id });
          lines.push(`- DROP ${label(dropEntry)} (currently ${slotName(dropEntry.lineupSlotId)}) -> waivers`);
        }

        const head = teamDisplayName(ctx.team);
        if (!a.confirm) return toolResult(`${head}, proposed transaction:\n${lines.join("\n")}${PREVIEW_FOOTER}`, { executed: false, team_id: ctx.team.id, items });
        // ESPN rejects a FREEAGENT transaction with no ADD item; a drop on its own is a ROSTER transaction.
        const tx = await submit(ctx, a.add_player_id !== undefined ? "FREEAGENT" : "ROSTER", items);
        return toolResult(`${head}, transaction submitted (ESPN status: ${tx.status ?? "unknown"}):\n${lines.join("\n")}`, { executed: true, status: tx.status, transaction_id: tx.id, team_id: ctx.team.id, items });
      } catch (e) { return toolError(e); }
    },
  );
}
