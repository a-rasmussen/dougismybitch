/** Shared formatting helpers: player summaries, team names, stat extraction, markdown tables, truncation, tool result envelope. */

import { z } from "zod";
import { CHARACTER_LIMIT, POSITION_MAP, PRO_TEAM_MAP, SLOT_MAP } from "../constants.js";
import type { EspnLeague, EspnPlayer, EspnPlayerPoolEntry, EspnRosterEntry, EspnStat, EspnTeam } from "../types.js";
import { EspnApiError } from "./espnClient.js";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

export const responseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("Output format: 'markdown' (compact, human-readable, default) or 'json' (full structured data)");

export const leagueIdSchema = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("ESPN league ID (the number after leagueId= in the ESPN URL). Optional if ESPN_LEAGUE_ID is set in the server environment.");

export const seasonSchema = z
  .number()
  .int()
  .min(2018)
  .max(2100)
  .optional()
  .describe("Season year, e.g. 2026. Defaults to the current season (or ESPN_SEASON env).");

export function positionOf(p: EspnPlayer): string {
  return POSITION_MAP[p.defaultPositionId] ?? `POS${p.defaultPositionId}`;
}
export function proTeamOf(p: EspnPlayer): string {
  return PRO_TEAM_MAP[p.proTeamId] ?? `T${p.proTeamId}`;
}
export function slotName(slotId: number): string {
  return SLOT_MAP[slotId] ?? `SLOT${slotId}`;
}

export function teamDisplayName(t: EspnTeam): string {
  if (t.name) return t.name;
  const joined = `${t.location ?? ""} ${t.nickname ?? ""}`.trim();
  return joined || t.abbrev || `Team ${t.id}`;
}

/** Map of teamId → display name, plus owner names via league.members. */
export function teamNameMap(league: EspnLeague): Map<number, string> {
  const m = new Map<number, string>();
  for (const t of league.teams ?? []) m.set(t.id, teamDisplayName(t));
  return m;
}

export function ownerNames(team: EspnTeam, league: EspnLeague): string {
  const members = new Map((league.members ?? []).map((mm) => [mm.id, mm.displayName]));
  return (team.owners ?? []).map((o) => members.get(o) ?? o).join(", ");
}

/**
 * Pull season-total actual points, season-total projected points, and
 * a specific week's actual + projected points from a player's stats array.
 * statSourceId: 0 actual, 1 projected. statSplitTypeId: 0 season, 1 weekly.
 */
export function extractPoints(stats: EspnStat[] | undefined, season: number, week?: number) {
  const find = (src: number, split: number, sp?: number) =>
    stats?.find((s) => s.seasonId === season && s.statSourceId === src && s.statSplitTypeId === split && (sp === undefined || s.scoringPeriodId === sp));
  const seasonActual = find(0, 0, 0);
  const seasonProj = find(1, 0, 0);
  const weekActual = week !== undefined ? find(0, 1, week) : undefined;
  const weekProj = week !== undefined ? find(1, 1, week) : undefined;
  return {
    season_points: round(seasonActual?.appliedTotal),
    season_avg: round(seasonActual?.appliedAverage),
    season_projected: round(seasonProj?.appliedTotal),
    week_points: round(weekActual?.appliedTotal),
    week_projected: round(weekProj?.appliedTotal),
  };
}

export function round(n: number | undefined, d = 1): number | undefined {
  if (n === undefined || n === null || Number.isNaN(n)) return undefined;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export interface PlayerSummary {
  player_id: number;
  name: string;
  position: string;
  pro_team: string;
  injury_status?: string;
  percent_owned?: number;
  percent_started?: number;
  adp?: number;
  season_points?: number;
  season_avg?: number;
  season_projected?: number;
  week_points?: number;
  week_projected?: number;
  on_team_id?: number;
  status?: string;
}

export function summarizePoolEntry(e: EspnPlayerPoolEntry, season: number, week?: number): PlayerSummary {
  const p = e.player;
  return {
    player_id: p.id,
    name: p.fullName,
    position: positionOf(p),
    pro_team: proTeamOf(p),
    injury_status: p.injuryStatus && p.injuryStatus !== "ACTIVE" ? p.injuryStatus : undefined,
    percent_owned: round(p.ownership?.percentOwned),
    percent_started: round(p.ownership?.percentStarted),
    adp: round(p.ownership?.averageDraftPosition),
    ...extractPoints(p.stats, season, week),
    on_team_id: e.onTeamId || undefined,
    status: e.status,
  };
}

export interface RosterRow extends PlayerSummary {
  slot: string;
  slot_id: number;
  acquisition_type?: string;
}

export function summarizeRosterEntry(r: EspnRosterEntry, season: number, week?: number): RosterRow {
  return {
    slot: slotName(r.lineupSlotId),
    slot_id: r.lineupSlotId,
    acquisition_type: r.acquisitionType,
    ...summarizePoolEntry(r.playerPoolEntry, season, week),
  };
}

/** Sort roster: starters in slot order, then bench, then IR. */
export function sortRoster(rows: RosterRow[]): RosterRow[] {
  const order = [0, 2, 4, 6, 23, 3, 5, 7, 16, 17, 20, 21];
  return [...rows].sort((a, b) => {
    const ia = order.indexOf(a.slot_id);
    const ib = order.indexOf(b.slot_id);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

const fmt = (n: number | undefined) => (n === undefined ? "–" : String(n));

export function rosterTable(rows: RosterRow[], week?: number): string {
  const head = week !== undefined
    ? `| Slot | Player | Pos | Team | Wk${week} pts | Wk${week} proj | Season pts | Inj |\n|---|---|---|---|---|---|---|---|`
    : `| Slot | Player | Pos | Team | Season pts | Proj | Avg | Inj |\n|---|---|---|---|---|---|---|---|`;
  const body = rows.map((r) =>
    week !== undefined
      ? `| ${r.slot} | ${r.name} | ${r.position} | ${r.pro_team} | ${fmt(r.week_points)} | ${fmt(r.week_projected)} | ${fmt(r.season_points)} | ${r.injury_status ?? ""} |`
      : `| ${r.slot} | ${r.name} | ${r.position} | ${r.pro_team} | ${fmt(r.season_points)} | ${fmt(r.season_projected)} | ${fmt(r.season_avg)} | ${r.injury_status ?? ""} |`,
  );
  return [head, ...body].join("\n");
}

export function playerTable(rows: PlayerSummary[], week?: number): string {
  const head = `| # | Player | Pos | Team | %Own | Season pts | Proj${week !== undefined ? ` | Wk${week} proj` : ""} | Inj | ID |\n|---|---|---|---|---|---|---|${week !== undefined ? "---|" : ""}---|---|`;
  const body = rows.map((r, i) =>
    `| ${i + 1} | ${r.name} | ${r.position} | ${r.pro_team} | ${fmt(r.percent_owned)} | ${fmt(r.season_points)} | ${fmt(r.season_projected)}${week !== undefined ? ` | ${fmt(r.week_projected)}` : ""} | ${r.injury_status ?? ""} | ${r.player_id} |`,
  );
  return [head, ...body].join("\n");
}

/** X-Fantasy-Filter that fetches specific player ids (ESPN requires a sort whenever limit is set). */
export function idsFilter(ids: number[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { players: { filterIds: { value: ids }, limit: Math.max(ids.length, 1), sortPercOwned: { sortAsc: false, sortPriority: 1 }, ...extra } };
}

export function fmtDate(ms: number | undefined): string {
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "–";
}

/** Standard tool result. Truncates text if over CHARACTER_LIMIT. */
export function toolResult(text: string, structured?: Record<string, unknown>) {
  let out = text;
  if (out.length > CHARACTER_LIMIT) {
    out = out.slice(0, CHARACTER_LIMIT) + `\n\n[Truncated at ${CHARACTER_LIMIT} characters. Use a smaller limit, a position filter, or response_format='markdown'.]`;
  }
  return {
    content: [{ type: "text" as const, text: out }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

export function toolError(err: unknown) {
  const msg = err instanceof EspnApiError ? err.message : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${msg}` }] };
}

/** Choose text output by format; JSON is pretty-printed structured data. */
export function render(format: ResponseFormat, markdown: () => string, structured: Record<string, unknown>) {
  const text = format === ResponseFormat.JSON ? JSON.stringify(structured, null, 2) : markdown();
  return toolResult(text, structured);
}
