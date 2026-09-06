/** Transactions / league activity tool. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultSeason, TRANSACTION_TYPE_MAP } from "../constants.js";
import { getLeague, espnGet } from "../services/espnClient.js";
import { leagueIdSchema, seasonSchema, responseFormatSchema, teamNameMap, render, toolError, fmtDate, positionOf, proTeamOf, idsFilter } from "../services/format.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/** ESPN "Recent Activity" message type ids (per cwendt94/espn-api). */
const ACTIVITY_MAP: Record<number, string> = { 178: "FA ADDED", 180: "WAIVER ADDED", 179: "DROPPED", 239: "DROPPED", 244: "TRADED", 181: "TRADED" };

interface ActivityMessage { messageTypeId: number; targetId: number; from?: number; to?: number; for?: number; date?: number }
interface ActivityTopic { id: string; date: number; messages: ActivityMessage[] }

export function registerTransactionTools(server: McpServer): void {
  server.registerTool(
    "espn_get_recent_activity",
    {
      title: "Get ESPN league recent activity feed",
      description: `The league's "Recent Activity" feed for the whole season: every completed add, waiver claim (with FAAB bid), drop, and trade, newest first. This is the tool to use for "what moves has everyone made", "who dropped X", or waiver history. Members-only: requires ESPN_S2/ESPN_SWID.

Args:
  - league_id, season: as in other tools.
  - team_id (number, optional): only activity involving this team.
  - limit (1-100, default 25), offset (default 0).
  - response_format: 'markdown' | 'json'.

Returns (json): { league_id, season, count, offset, has_more, next_offset, activity: [{ date, actions: [{ team_id, team, action ('FA ADDED'|'WAIVER ADDED'|'DROPPED'|'TRADED'), player_id, player, position, pro_team, bid }] }] }

For the current week's pending waiver claims and trade proposals use espn_list_transactions instead.`,
      inputSchema: {
        league_id: leagueIdSchema,
        season: seasonSchema,
        team_id: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
        response_format: responseFormatSchema,
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        const yr = a.season ?? defaultSeason();
        const lg = await getLeague(a.league_id, yr, ["mTeam"]);
        const names = teamNameMap(lg);
        const filter = {
          topics: {
            filterType: { value: ["ACTIVITY_TRANSACTIONS"] },
            limit: a.limit, offset: a.offset,
            limitPerMessageSet: { value: 25 },
            sortMessageDate: { sortPriority: 1, sortAsc: false },
            sortFor: { sortPriority: 2, sortAsc: false },
            filterIncludeMessageTypeIds: { value: Object.keys(ACTIVITY_MAP).map(Number) },
          },
        };
        const res = await espnGet<{ topics?: ActivityTopic[] }>(`/seasons/${yr}/segments/0/leagues/${lg.id}/communication/`, { views: ["kona_league_communication"], fantasyFilter: filter });
        const topics = res.topics ?? [];
        const ids = [...new Set(topics.flatMap((t) => t.messages.map((m) => m.targetId)))];
        const byId = new Map<number, { fullName: string; defaultPositionId: number; proTeamId: number }>();
        if (ids.length) {
          const pool = await getLeague(a.league_id, yr, ["kona_player_info"], undefined, idsFilter(ids));
          for (const e of pool.players ?? []) byId.set(e.id, e.player);
        }
        const tn = (id: number | undefined) => (id ? names.get(id) ?? `Team ${id}` : "–");
        let activity = topics.map((t) => ({
          date: fmtDate(t.date),
          actions: t.messages.map((m) => {
            const teamId = m.messageTypeId === 244 ? m.from : m.messageTypeId === 239 ? m.for : m.to;
            const p = byId.get(m.targetId);
            return {
              team_id: teamId, team: tn(teamId), action: ACTIVITY_MAP[m.messageTypeId] ?? `TYPE_${m.messageTypeId}`,
              player_id: m.targetId, player: p?.fullName ?? `Player ${m.targetId}`,
              position: p ? positionOf(p as never) : "?", pro_team: p ? proTeamOf(p as never) : "?",
              bid: m.messageTypeId === 180 ? m.from : undefined,
            };
          }),
        }));
        if (a.team_id !== undefined) activity = activity.filter((t) => t.actions.some((x) => x.team_id === a.team_id));
        const out = { league_id: lg.id, season: yr, count: activity.length, offset: a.offset, has_more: topics.length === a.limit, next_offset: topics.length === a.limit ? a.offset + a.limit : undefined, activity };
        if (!activity.length) return render(a.response_format, () => `No activity found${a.team_id ? ` for team ${a.team_id}` : ""} (offset ${a.offset}). If the league is private, confirm ESPN_S2/ESPN_SWID are set.`, out);
        return render(a.response_format, () => [
          `# Recent activity (${a.offset + 1}–${a.offset + activity.length})`,
          ...activity.map((t) => `- **${t.date}**: ` + t.actions.map((x) => `${x.team} ${x.action} ${x.player} (${x.position}, ${x.pro_team})${x.bid ? ` for $${x.bid}` : ""}`).join("; ")),
          out.has_more ? `\nMore: call again with offset=${out.next_offset}.` : "",
        ].join("\n"), out);
      } catch (e) { return toolError(e); }
    },
  );

  server.registerTool(
    "espn_list_transactions",
    {
      title: "List ESPN league transactions / activity",
      description: `List the league's CURRENT transaction queue: this week's executed adds/drops, pending waiver claims (with FAAB bids), and pending/accepted trade proposals. Newest first, with pagination and optional filters by team, type, or week. ESPN only keeps recent transactions here — for full-season history use espn_get_recent_activity.

Args:
  - league_id, season: as in other tools.
  - team_id (number, optional): only transactions initiated by / involving this team.
  - type ('adds_drops' | 'waivers' | 'trades' | 'all'): default 'all' (excludes plain lineup changes).
  - week (number, optional): only transactions processed in this NFL week.
  - include_pending (boolean): include pending waiver claims and trade proposals (default true).
  - limit (1-100, default 25), offset (default 0).
  - response_format: 'markdown' | 'json'.

Returns (json): { league_id, season, count, offset, has_more, next_offset, transactions: [{ id, type, type_label, status, team_id, team, bid, week, date, items: [{ action ('ADD'|'DROP'), player_id, player, position, pro_team, from_team, to_team }] }] }`,
      inputSchema: {
        league_id: leagueIdSchema,
        season: seasonSchema,
        team_id: z.number().int().positive().optional(),
        type: z.enum(["adds_drops", "waivers", "trades", "all"]).default("all"),
        week: z.number().int().min(1).max(18).optional(),
        include_pending: z.boolean().default(true),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
        response_format: responseFormatSchema,
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        const yr = a.season ?? defaultSeason();
        const lg = await getLeague(a.league_id, yr, ["mTransactions2", "mTeam"]);
        const names = teamNameMap(lg);
        const typeSets: Record<string, string[]> = {
          adds_drops: ["FREEAGENT", "WAIVER"],
          waivers: ["WAIVER", "WAIVER_ERROR"],
          trades: ["TRADE_ACCEPT", "TRADE_PROPOSAL"],
          all: ["FREEAGENT", "WAIVER", "WAIVER_ERROR", "TRADE_ACCEPT", "TRADE_PROPOSAL"],
        };
        const allowed = new Set(typeSets[a.type]);
        let txs = (lg.transactions ?? []).filter((t) => allowed.has(t.type));
        if (!a.include_pending) txs = txs.filter((t) => t.status === "EXECUTED");
        if (a.week !== undefined) txs = txs.filter((t) => t.scoringPeriodId === a.week);
        if (a.team_id !== undefined) txs = txs.filter((t) => t.teamId === a.team_id || (t.items ?? []).some((i) => i.fromTeamId === a.team_id || i.toTeamId === a.team_id));
        txs.sort((x, y) => (y.processDate ?? y.proposedDate ?? 0) - (x.processDate ?? x.proposedDate ?? 0));
        const total = txs.length;
        const page = txs.slice(a.offset, a.offset + a.limit);

        // Resolve player names in one call.
        const ids = [...new Set(page.flatMap((t) => (t.items ?? []).map((i) => i.playerId)))];
        const byId = new Map<number, { fullName: string; defaultPositionId: number; proTeamId: number }>();
        if (ids.length) {
          const pool = await getLeague(a.league_id, yr, ["kona_player_info"], undefined, idsFilter(ids));
          for (const e of pool.players ?? []) byId.set(e.id, e.player);
        }
        const tn = (id: number) => (id ? names.get(id) ?? `Team ${id}` : "FA/Waivers");
        const rows = page.map((t) => ({
          id: t.id, type: t.type, type_label: TRANSACTION_TYPE_MAP[t.type] ?? t.type, status: t.status,
          team_id: t.teamId, team: tn(t.teamId), bid: t.bidAmount || undefined, week: t.scoringPeriodId,
          date: fmtDate(t.processDate ?? t.proposedDate),
          items: (t.items ?? []).filter((i) => i.type !== "LINEUP").map((i) => {
            const p = byId.get(i.playerId);
            return {
              action: i.type, player_id: i.playerId, player: p?.fullName ?? `Player ${i.playerId}`,
              position: p ? positionOf(p as never) : "?", pro_team: p ? proTeamOf(p as never) : "?",
              from_team: tn(i.fromTeamId), to_team: tn(i.toTeamId),
            };
          }),
        }));
        const out = { league_id: lg.id, season: yr, total, count: rows.length, offset: a.offset, has_more: a.offset + rows.length < total, next_offset: a.offset + rows.length < total ? a.offset + rows.length : undefined, transactions: rows };
        if (!rows.length) return render(a.response_format, () => `No ${a.type === "all" ? "" : a.type + " "}transactions found${a.team_id ? ` for team ${a.team_id}` : ""}${a.week ? ` in week ${a.week}` : ""}.`, out);
        return render(a.response_format, () => [
          `# Transactions (${a.offset + 1}–${a.offset + rows.length} of ${total})`,
          ...rows.map((t) => {
            const moves = t.items.map((i) => i.action === "ADD" ? `+${i.player} (${i.position}, ${i.pro_team})${t.type.startsWith("TRADE") ? ` → ${i.to_team}` : ""}` : `−${i.player} (${i.position})${t.type.startsWith("TRADE") ? ` from ${i.from_team}` : ""}`).join(", ");
            return `- **${t.date}** · ${t.type_label}${t.status !== "EXECUTED" ? ` [${t.status}]` : ""} · ${t.team}${t.bid ? ` · bid $${t.bid}` : ""}${t.week ? ` · wk ${t.week}` : ""}: ${moves || "(no player moves)"}`;
          }),
          out.has_more ? `\nMore: call again with offset=${out.next_offset}.` : "",
        ].join("\n"), out);
      } catch (e) { return toolError(e); }
    },
  );
}
