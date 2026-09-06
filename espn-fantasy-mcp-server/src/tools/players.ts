/** Player tools: free agents / waiver wire, player search, player detail. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultSeason, POSITION_TO_FILTER_SLOT } from "../constants.js";
import { espnGet, getLeague, defaultLeagueId, EspnApiError } from "../services/espnClient.js";
import {
  leagueIdSchema, seasonSchema, responseFormatSchema,
  summarizePoolEntry, playerTable, render, toolError, teamNameMap, round, positionOf, proTeamOf, idsFilter,
} from "../services/format.js";
import type { EspnLeague, EspnPlayerPoolEntry } from "../types.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const positionSchema = z
  .enum(["QB", "RB", "WR", "TE", "K", "D/ST", "DST", "FLEX"])
  .optional()
  .describe("Restrict to one position. FLEX = RB/WR/TE.");

type SortKey = "projected_season" | "projected_week" | "points_season" | "points_week" | "percent_owned" | "adp";

/** Build the X-Fantasy-Filter for the player pool. */
function buildPlayerFilter(opts: {
  season: number; week?: number; limit: number; offset: number; status?: string[]; position?: string; sort: SortKey; injured?: boolean; ids?: number[];
}): Record<string, unknown> {
  const f: Record<string, unknown> = { limit: opts.limit, offset: opts.offset };
  if (opts.status) f.filterStatus = { value: opts.status };
  if (opts.position) f.filterSlotIds = { value: [POSITION_TO_FILTER_SLOT[opts.position]] };
  if (opts.ids) f.filterIds = { value: opts.ids };
  if (opts.injured === false) f.filterInjured = { value: false };
  const s = opts.season;
  const wk = opts.week ?? 0;
  // ESPN stat key: "{split}{source}{season}" with scoringPeriod segment: e.g. "102026" = projected season, "002026" = actual season,
  // "1120263" = projected week 3 (split 1 = weekly, source 1 = projected, season, week).
  const keyMap: Record<SortKey, unknown> = {
    projected_season: { sortAppliedStatTotal: { sortAsc: false, sortPriority: 1, value: `10${s}` } },
    points_season: { sortAppliedStatTotal: { sortAsc: false, sortPriority: 1, value: `00${s}` } },
    projected_week: { sortAppliedStatTotal: { sortAsc: false, sortPriority: 1, value: `11${s}${wk}` } },
    points_week: { sortAppliedStatTotal: { sortAsc: false, sortPriority: 1, value: `01${s}${wk}` } },
    percent_owned: { sortPercOwned: { sortAsc: false, sortPriority: 1 } },
    adp: { sortAdp: { sortAsc: true, sortPriority: 1 } },
  };
  Object.assign(f, keyMap[opts.sort]);
  // Always request season actual + projected, and the target week actual + projected.
  f.filterStatsForTopScoringPeriodIds = { value: 1, additionalValue: [`00${s}`, `10${s}`, `11${s}${wk}`, `01${s}${wk}`] };
  return { players: f };
}

async function fetchPlayers(leagueId: number | undefined, season: number, filter: Record<string, unknown>, week?: number): Promise<{ league: EspnLeague | undefined; entries: EspnPlayerPoolEntry[] }> {
  const id = leagueId ?? defaultLeagueId();
  if (id) {
    const lg = await getLeague(id, season, ["kona_player_info", "mTeam"], { scoringPeriodId: week }, filter);
    return { league: lg, entries: lg.players ?? [] };
  }
  // No league: use ESPN's default PPR pool (public, no auth).
  const res = await espnGet<{ players: EspnPlayerPoolEntry[] }>(`/seasons/${season}/segments/0/leaguedefaults/3`, { views: ["kona_player_info"], params: { scoringPeriodId: week }, fantasyFilter: filter });
  return { league: undefined, entries: res.players ?? [] };
}

export function registerPlayerTools(server: McpServer): void {
  server.registerTool(
    "espn_list_free_agents",
    {
      title: "List ESPN free agents / waiver wire",
      description: `List players available on the waiver wire or as free agents in an ESPN league, sorted by projection, points, or ownership, with position filter and pagination. Each row shows position, NFL team, % owned, season points, season projection, this week's projection, injury status, and player_id.

Args:
  - league_id, season: as in other tools. If no league is available, uses ESPN's default PPR player pool (public).
  - position ('QB'|'RB'|'WR'|'TE'|'K'|'D/ST'|'FLEX', optional).
  - sort_by ('projected_season' | 'projected_week' | 'points_season' | 'points_week' | 'percent_owned' | 'adp'): default 'projected_week' during season.
  - week (number, optional): NFL week for weekly stats/projections. Defaults to current week.
  - include_waivers (boolean): include players currently on waivers (default true) as well as free agents.
  - exclude_injured (boolean): drop players flagged injured (default false).
  - limit (1-100, default 25), offset (default 0).
  - response_format: 'markdown' | 'json'.

Returns (json): { league_id, season, week, sort_by, position, count, offset, has_more, next_offset, players: [{ player_id, name, position, pro_team, status ('FREEAGENT'|'WAIVERS'), injury_status, percent_owned, percent_started, adp, season_points, season_avg, season_projected, week_points, week_projected }] }

Note: ESPN does not return a total count; has_more is true when a full page came back.`,
      inputSchema: {
        league_id: leagueIdSchema,
        season: seasonSchema,
        position: positionSchema,
        sort_by: z.enum(["projected_season", "projected_week", "points_season", "points_week", "percent_owned", "adp"]).default("projected_week"),
        week: z.number().int().min(1).max(18).optional(),
        include_waivers: z.boolean().default(true),
        exclude_injured: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
        response_format: responseFormatSchema,
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        const yr = a.season ?? defaultSeason();
        // Need current week for weekly sorts if not given.
        let wk = a.week;
        if (wk === undefined) {
          const id = a.league_id ?? defaultLeagueId();
          if (id) {
            const lg = await getLeague(id, yr, ["mStatus"]);
            wk = lg.scoringPeriodId;
          } else {
            const g = await espnGet<{ currentScoringPeriod?: { id: number } }>(`/seasons/${yr}`, { views: ["proTeamSchedules_wl"] }).catch(() => ({}) as { currentScoringPeriod?: { id: number } });
            wk = g.currentScoringPeriod?.id ?? 1;
          }
        }
        const status = a.include_waivers ? ["FREEAGENT", "WAIVERS"] : ["FREEAGENT"];
        const filter = buildPlayerFilter({ season: yr, week: wk, limit: a.limit, offset: a.offset, status, position: a.position, sort: a.sort_by, injured: a.exclude_injured ? false : undefined });
        const { league, entries } = await fetchPlayers(a.league_id, yr, filter, wk);
        const players = entries.map((e) => summarizePoolEntry(e, yr, wk));
        const out = {
          league_id: league?.id, season: yr, week: wk, sort_by: a.sort_by, position: a.position,
          count: players.length, offset: a.offset, has_more: players.length === a.limit, next_offset: players.length === a.limit ? a.offset + a.limit : undefined,
          players,
        };
        return render(a.response_format, () =>
          `# Free agents${a.position ? ` — ${a.position}` : ""} (week ${wk}, sorted by ${a.sort_by}, ${a.offset + 1}–${a.offset + players.length})\n${playerTable(players, wk)}${out.has_more ? `\n\nMore available: call again with offset=${out.next_offset}.` : ""}`, out);
      } catch (e) { return toolError(e); }
    },
  );

  server.registerTool(
    "espn_search_players",
    {
      title: "Search ESPN players by name",
      description: `Find NFL players by (partial) name across the whole player pool — rostered or not — and report position, NFL team, injury status, ownership, season/week points and projections, and which fantasy team (if any) owns them in the league.

Args:
  - name (string, required): case-insensitive substring of the player's full name, e.g. "gibbs" or "ja'marr".
  - league_id, season: as in other tools (league needed to see fantasy ownership).
  - week (number, optional): NFL week for weekly stats.
  - limit (1-50, default 10).
  - response_format: 'markdown' | 'json'.

Returns (json): { season, week, query, count, players: [{ player_id, name, position, pro_team, injury_status, percent_owned, season_points, season_projected, week_points, week_projected, status, on_team_id, on_team }] }`,
      inputSchema: {
        name: z.string().min(2).max(60).describe("Partial or full player name"),
        league_id: leagueIdSchema,
        season: seasonSchema,
        week: z.number().int().min(1).max(18).optional(),
        limit: z.number().int().min(1).max(50).default(10),
        response_format: responseFormatSchema,
      },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        const yr = a.season ?? defaultSeason();
        const wk = a.week;
        const filter = buildPlayerFilter({ season: yr, week: wk, limit: a.limit, offset: 0, sort: "percent_owned" });
        (filter.players as Record<string, unknown>).filterName = { value: a.name };
        const { league, entries } = await fetchPlayers(a.league_id, yr, filter, wk);
        const names = league ? teamNameMap(league) : new Map<number, string>();
        const players = entries.map((e) => ({ ...summarizePoolEntry(e, yr, wk ?? league?.scoringPeriodId), on_team: e.onTeamId ? names.get(e.onTeamId) ?? `Team ${e.onTeamId}` : undefined }));
        const out = { season: yr, week: wk, query: a.name, count: players.length, players };
        if (!players.length) return render(a.response_format, () => `No players matching "${a.name}". Try a shorter substring or check spelling.`, out);
        return render(a.response_format, () => [
          `# Players matching "${a.name}"`,
          `| Player | Pos | NFL | Fantasy team | %Own | Season pts | Proj | Inj | ID |`, `|---|---|---|---|---|---|---|---|---|`,
          ...players.map((p) => `| ${p.name} | ${p.position} | ${p.pro_team} | ${p.on_team ?? (p.status ?? "FA")} | ${p.percent_owned ?? "–"} | ${p.season_points ?? "–"} | ${p.season_projected ?? "–"} | ${p.injury_status ?? ""} | ${p.player_id} |`),
        ].join("\n"), out);
      } catch (e) { return toolError(e); }
    },
  );

  server.registerTool(
    "espn_get_player",
    {
      title: "Get ESPN player detail with weekly stat lines",
      description: `Get one player's full detail: position, NFL team, injury status, ownership/ADP, ESPN draft ranks, season totals and projection, and a week-by-week table of actual vs projected fantasy points for the season so far.

Args:
  - player_id (number, required): ESPN player id (from espn_search_players, rosters, or free-agent lists).
  - league_id, season: as in other tools.
  - response_format: 'markdown' | 'json'.

Returns (json): { player_id, name, position, pro_team, injury_status, injured, droppable, percent_owned, percent_started, adp, draft_rank_ppr, season_points, season_projected, season_avg, on_team_id, on_team, weekly: [{ week, points, projected }] }`,
      inputSchema: { player_id: z.number().int().positive(), league_id: leagueIdSchema, season: seasonSchema, response_format: responseFormatSchema },
      annotations: READ_ONLY,
    },
    async (a) => {
      try {
        const yr = a.season ?? defaultSeason();
        const filter = idsFilter([a.player_id], { filterStatsForTopScoringPeriodIds: { value: 20, additionalValue: [`00${yr}`, `10${yr}`] } });
        const { league, entries } = await fetchPlayers(a.league_id, yr, filter);
        const e = entries[0];
        if (!e) throw new EspnApiError(`No player with id ${a.player_id} in season ${yr}. Use espn_search_players to find the id.`);
        const p = e.player;
        const base = summarizePoolEntry(e, yr);
        const weekly = (p.stats ?? [])
          .filter((s) => s.seasonId === yr && s.statSplitTypeId === 1)
          .reduce((m, s) => {
            const w = m.get(s.scoringPeriodId) ?? { week: s.scoringPeriodId, points: undefined as number | undefined, projected: undefined as number | undefined };
            if (s.statSourceId === 0) w.points = round(s.appliedTotal); else w.projected = round(s.appliedTotal);
            m.set(s.scoringPeriodId, w);
            return m;
          }, new Map<number, { week: number; points?: number; projected?: number }>());
        const weeks = [...weekly.values()].sort((x, y) => x.week - y.week);
        const names = league ? teamNameMap(league) : new Map<number, string>();
        const out = {
          ...base,
          injured: p.injured, droppable: p.droppable,
          draft_rank_ppr: p.draftRanksByRankType?.PPR?.rank,
          on_team: e.onTeamId ? names.get(e.onTeamId) ?? `Team ${e.onTeamId}` : undefined,
          position: positionOf(p), pro_team: proTeamOf(p),
          weekly: weeks,
        };
        return render(a.response_format, () => [
          `# ${out.name} — ${out.position}, ${out.pro_team} (id ${out.player_id})`,
          `- Status: ${p.injuryStatus ?? "ACTIVE"}${out.on_team ? ` · Fantasy team: ${out.on_team}` : ` · ${e.status ?? "free agent"}`}`,
          `- Owned ${out.percent_owned ?? "–"}% · started ${out.percent_started ?? "–"}% · ADP ${out.adp ?? "–"} · ESPN PPR draft rank ${out.draft_rank_ppr ?? "–"}`,
          `- Season: ${out.season_points ?? 0} pts (avg ${out.season_avg ?? "–"}), projected ${out.season_projected ?? "–"}`,
          ``, `| Week | Points | Projected |`, `|---|---|---|`,
          ...weeks.map((w) => `| ${w.week} | ${w.points ?? "–"} | ${w.projected ?? "–"} |`),
        ].join("\n"), out);
      } catch (e) { return toolError(e); }
    },
  );
}
