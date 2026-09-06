/** Matchup and scoring tools: weekly scoreboard, full box score, team schedule. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultSeason } from "../constants.js";
import { getLeague } from "../services/espnClient.js";
import {
  leagueIdSchema, seasonSchema, responseFormatSchema,
  teamNameMap, summarizeRosterEntry, sortRoster, rosterTable, render, toolError, round,
} from "../services/format.js";
import type { EspnMatchup, EspnMatchupSide } from "../types.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function sideScore(s: EspnMatchupSide | undefined, week: number): { points?: number; projected?: number } {
  if (!s) return {};
  const byWeek = s.pointsByScoringPeriod?.[String(week)];
  return {
    points: round(byWeek ?? s.totalPointsLive ?? s.rosterForCurrentScoringPeriod?.appliedStatTotal ?? s.totalPoints),
    projected: round(s.totalProjectedPointsLive),
  };
}

function matchupSummary(m: EspnMatchup, names: Map<number, string>, week: number) {
  const home = sideScore(m.home, week);
  const away = sideScore(m.away, week);
  return {
    matchup_id: m.id,
    matchup_period: m.matchupPeriodId,
    playoff_tier: m.playoffTierType && m.playoffTierType !== "NONE" ? m.playoffTierType : undefined,
    winner: m.winner,
    home_team_id: m.home.teamId,
    home_team: names.get(m.home.teamId) ?? `Team ${m.home.teamId}`,
    home_points: home.points,
    home_projected: home.projected,
    away_team_id: m.away?.teamId,
    away_team: m.away ? names.get(m.away.teamId) ?? `Team ${m.away.teamId}` : "BYE",
    away_points: away.points,
    away_projected: away.projected,
  };
}

/** Matchups for a given matchup period. mMatchupScore is keyed by matchupPeriodId; with scoringPeriodId we get live/that-week points. */
export function registerMatchupTools(server: McpServer): void {
  server.registerTool(
    "espn_get_matchups",
    {
      title: "Get ESPN weekly matchups / scoreboard",
      description: `Get the scoreboard for one week of an ESPN fantasy league: every head-to-head matchup with team names, points scored, live projected points (during the current week), and winner. Optionally filter to one team.

Args:
  - league_id, season: as in other tools.
  - week (number, optional): matchup period / NFL week. Defaults to the current week.
  - team_id (number, optional): only the matchup involving this team.
  - response_format: 'markdown' | 'json'.

Returns (json): { league_id, season, week, matchups: [{ matchup_id, matchup_period, playoff_tier, winner, home_team_id, home_team, home_points, home_projected, away_team_id, away_team, away_points, away_projected }] }

For player-level detail of a matchup use espn_get_box_score.`,
      inputSchema: {
        league_id: leagueIdSchema,
        season: seasonSchema,
        week: z.number().int().min(1).max(18).optional().describe("Matchup period / NFL week. Defaults to current week."),
        team_id: z.number().int().positive().optional().describe("Filter to the matchup containing this team id."),
        response_format: responseFormatSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ league_id, season, week, team_id, response_format }) => {
      try {
        const yr = season ?? defaultSeason();
        const lg = await getLeague(league_id, yr, ["mMatchupScore", "mTeam", "mStatus"], { scoringPeriodId: week });
        const wk = week ?? lg.status?.currentMatchupPeriod ?? lg.scoringPeriodId;
        const names = teamNameMap(lg);
        let ms = (lg.schedule ?? []).filter((m) => m.matchupPeriodId === wk);
        if (team_id !== undefined) ms = ms.filter((m) => m.home.teamId === team_id || m.away?.teamId === team_id);
        const matchups = ms.map((m) => matchupSummary(m, names, wk));
        const out = { league_id: lg.id, season: yr, week: wk, matchups };
        if (!matchups.length) return render(response_format, () => `No matchups found for week ${wk}${team_id ? ` and team ${team_id}` : ""}. Regular season may not include this week.`, out);
        return render(response_format, () => [
          `# Week ${wk} scoreboard — league ${lg.id}`,
          `| Away | Pts | Proj | | Home | Pts | Proj | Result |`,
          `|---|---|---|---|---|---|---|---|`,
          ...matchups.map((m) => `| ${m.away_team} (${m.away_team_id ?? "–"}) | ${m.away_points ?? "–"} | ${m.away_projected ?? "–"} | @ | ${m.home_team} (${m.home_team_id}) | ${m.home_points ?? "–"} | ${m.home_projected ?? "–"} | ${m.winner ?? "–"}${m.playoff_tier ? ` (${m.playoff_tier})` : ""} |`),
        ].join("\n"), out);
      } catch (e) { return toolError(e); }
    },
  );

  server.registerTool(
    "espn_get_box_score",
    {
      title: "Get ESPN matchup box score (player-level)",
      description: `Get the player-by-player box score for one team's matchup in a given week: both lineups with slot, each player's actual and projected points for that week, and team totals. Use for start/sit review, "who beat me", and identifying which starters underperformed.

Args:
  - league_id, season: as in other tools.
  - team_id (number, required): the team whose matchup to show.
  - week (number, optional): NFL week / scoring period. Defaults to current week.
  - response_format: 'markdown' | 'json'.

Returns (json): { league_id, season, week, winner, home: { team_id, team, points, projected, roster: [...] }, away: {...} }
Each roster row: { slot, name, position, pro_team, week_points, week_projected, injury_status, player_id }.`,
      inputSchema: {
        league_id: leagueIdSchema,
        season: seasonSchema,
        team_id: z.number().int().positive().describe("Team id (from espn_list_teams)."),
        week: z.number().int().min(1).max(18).optional(),
        response_format: responseFormatSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ league_id, season, team_id, week, response_format }) => {
      try {
        const yr = season ?? defaultSeason();
        const lg = await getLeague(league_id, yr, ["mMatchup", "mMatchupScore", "mTeam", "mStatus"], { scoringPeriodId: week });
        const wk = week ?? lg.scoringPeriodId;
        const names = teamNameMap(lg);
        // Find matchup period containing this scoring period (playoff weeks may span 2).
        const periods = lg.settings?.scheduleSettings?.matchupPeriods ?? {};
        let mp = Number(Object.entries(periods).find(([, wks]) => wks.includes(wk))?.[0]);
        if (!mp) mp = wk;
        const m = (lg.schedule ?? []).find((x) => x.matchupPeriodId === mp && (x.home.teamId === team_id || x.away?.teamId === team_id));
        if (!m) return toolError(new Error(`No matchup for team ${team_id} in week ${wk}. Check team_id with espn_list_teams.`));
        const side = (s: EspnMatchupSide | undefined) => {
          if (!s) return undefined;
          const entries = s.rosterForCurrentScoringPeriod?.entries ?? s.rosterForMatchupPeriod?.entries ?? [];
          const roster = sortRoster(entries.map((r) => summarizeRosterEntry(r, yr, wk)));
          const starters = roster.filter((r) => r.slot_id !== 20 && r.slot_id !== 21);
          return {
            team_id: s.teamId,
            team: names.get(s.teamId) ?? `Team ${s.teamId}`,
            points: sideScore(s, wk).points ?? round(starters.reduce((a, r) => a + (r.week_points ?? 0), 0)),
            projected: round(starters.reduce((a, r) => a + (r.week_projected ?? 0), 0)),
            bench_points: round(roster.filter((r) => r.slot_id === 20).reduce((a, r) => a + (r.week_points ?? 0), 0)),
            roster,
          };
        };
        const home = side(m.home);
        const away = side(m.away);
        const out = { league_id: lg.id, season: yr, week: wk, matchup_period: mp, winner: m.winner, home, away };
        const block = (s: typeof home) => s ? `## ${s.team} (team ${s.team_id}) — ${s.points ?? "–"} pts (proj ${s.projected ?? "–"}, bench ${s.bench_points ?? 0})\n${rosterTable(s.roster, wk)}` : "## BYE";
        return render(response_format, () => `# Week ${wk} box score — ${away?.team ?? "BYE"} @ ${home?.team} · winner: ${m.winner ?? "undecided"}\n\n${block(away)}\n\n${block(home)}`, out);
      } catch (e) { return toolError(e); }
    },
  );

  server.registerTool(
    "espn_get_team_schedule",
    {
      title: "Get an ESPN team's full season schedule and results",
      description: `List every matchup for one team across the season: week, opponent, points for/against, and result (W/L/T or upcoming). Useful for strength-of-schedule and remaining-opponent analysis.

Args:
  - league_id, season: as in other tools.
  - team_id (number, required).
  - response_format: 'markdown' | 'json'.

Returns (json): { league_id, season, team_id, team, record: { wins, losses, ties }, schedule: [{ week, opponent_id, opponent, points_for, points_against, result, playoff_tier }] }`,
      inputSchema: { league_id: leagueIdSchema, season: seasonSchema, team_id: z.number().int().positive(), response_format: responseFormatSchema },
      annotations: READ_ONLY,
    },
    async ({ league_id, season, team_id, response_format }) => {
      try {
        const yr = season ?? defaultSeason();
        const lg = await getLeague(league_id, yr, ["mMatchupScore", "mTeam"]);
        const names = teamNameMap(lg);
        if (!names.has(team_id)) return toolError(new Error(`No team with id ${team_id}. Use espn_list_teams to find ids.`));
        const rows = (lg.schedule ?? [])
          .filter((m) => m.home.teamId === team_id || m.away?.teamId === team_id)
          .sort((a, b) => a.matchupPeriodId - b.matchupPeriodId)
          .map((m) => {
            const isHome = m.home.teamId === team_id;
            const me = isHome ? m.home : m.away!;
            const opp = isHome ? m.away : m.home;
            const pf = round(me.totalPoints);
            const pa = round(opp?.totalPoints);
            let result = "upcoming";
            if (m.winner === "TIE") result = "T";
            else if (m.winner === "HOME" || m.winner === "AWAY") result = (m.winner === "HOME") === isHome ? "W" : "L";
            else if (!opp) result = "BYE";
            return {
              week: m.matchupPeriodId,
              opponent_id: opp?.teamId,
              opponent: opp ? names.get(opp.teamId) ?? `Team ${opp.teamId}` : "BYE",
              home_away: isHome ? "home" : "away",
              points_for: pf, points_against: pa, result,
              playoff_tier: m.playoffTierType && m.playoffTierType !== "NONE" ? m.playoffTierType : undefined,
            };
          });
        const rec = { wins: rows.filter((r) => r.result === "W").length, losses: rows.filter((r) => r.result === "L").length, ties: rows.filter((r) => r.result === "T").length };
        const out = { league_id: lg.id, season: yr, team_id, team: names.get(team_id), record: rec, schedule: rows };
        return render(response_format, () => [
          `# ${out.team} schedule (${rec.wins}-${rec.losses}-${rec.ties})`,
          `| Wk | Opponent | H/A | PF | PA | Result |`, `|---|---|---|---|---|---|`,
          ...rows.map((r) => `| ${r.week} | ${r.opponent} (${r.opponent_id ?? "–"}) | ${r.home_away} | ${r.points_for ?? "–"} | ${r.points_against ?? "–"} | ${r.result}${r.playoff_tier ? ` (${r.playoff_tier})` : ""} |`),
        ].join("\n"), out);
      } catch (e) { return toolError(e); }
    },
  );
}
