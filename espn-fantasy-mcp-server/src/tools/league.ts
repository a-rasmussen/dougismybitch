/** League-level tools: settings, teams/standings, rosters, draft results. */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { defaultSeason, SLOT_MAP } from "../constants.js";
import { getLeague } from "../services/espnClient.js";
import {
  leagueIdSchema, seasonSchema, responseFormatSchema, ResponseFormat,
  teamDisplayName, ownerNames, teamNameMap, summarizeRosterEntry, sortRoster, rosterTable,
  render, toolError, fmtDate, round, positionOf, proTeamOf, idsFilter,
} from "../services/format.js";
import type { EspnTeam } from "../types.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function teamRow(t: EspnTeam, leagueMembers: Parameters<typeof ownerNames>[1]) {
  const r = t.record?.overall;
  return {
    team_id: t.id,
    name: teamDisplayName(t),
    abbrev: t.abbrev,
    owners: ownerNames(t, leagueMembers),
    wins: r?.wins ?? 0,
    losses: r?.losses ?? 0,
    ties: r?.ties ?? 0,
    points_for: round(r?.pointsFor),
    points_against: round(r?.pointsAgainst),
    streak: r?.streakType && r.streakLength ? `${r.streakType === "WIN" ? "W" : "L"}${r.streakLength}` : undefined,
    playoff_seed: t.playoffSeed,
    waiver_rank: t.waiverRank,
    faab_spent: t.transactionCounter?.acquisitionBudgetSpent,
    acquisitions: t.transactionCounter?.acquisitions,
    trades: t.transactionCounter?.trades,
  };
}

export function registerLeagueTools(server: McpServer): void {
  server.registerTool(
    "espn_get_league_settings",
    {
      title: "Get ESPN league settings",
      description: `Get an ESPN fantasy football league's configuration: name, size, current week, roster slot counts, scoring type (PPR etc.), key scoring rules, waiver/FAAB settings, trade deadline, playoff format, and draft info.

Args:
  - league_id (number, optional): ESPN league ID; defaults to ESPN_LEAGUE_ID env.
  - season (number, optional): season year; defaults to current season.
  - response_format ('markdown' | 'json'): default 'markdown'.

Returns (json): { league_id, season, name, size, current_week, current_matchup_period, final_week, is_public, roster_slots: {slot: count}, scoring_type, ppr_points, key_scoring: {...}, waivers: {...}, trade_deadline, playoffs: {...}, draft: {...} }

Use first when you need to know how the league scores or how many teams/roster slots exist. Private leagues require ESPN_S2/ESPN_SWID cookies.`,
      inputSchema: { league_id: leagueIdSchema, season: seasonSchema, response_format: responseFormatSchema },
      annotations: READ_ONLY,
    },
    async ({ league_id, season, response_format }) => {
      try {
        const yr = season ?? defaultSeason();
        const lg = await getLeague(league_id, yr, ["mSettings", "mStatus"]);
        const s = lg.settings;
        const slots: Record<string, number> = {};
        for (const [k, v] of Object.entries(s?.rosterSettings?.lineupSlotCounts ?? {})) {
          if (v > 0) slots[SLOT_MAP[Number(k)] ?? `SLOT${k}`] = v;
        }
        const items = s?.scoringSettings?.scoringItems ?? [];
        const pts = (statId: number) => items.find((i) => i.statId === statId)?.points;
        const keyScoring = {
          passing_yards_per_point: pts(3) ? round(1 / pts(3)!, 0) : undefined,
          passing_td: pts(4),
          interception: pts(20),
          rushing_yards_per_point: pts(24) ? round(1 / pts(24)!, 0) : undefined,
          rushing_td: pts(25),
          reception: pts(53),
          receiving_yards_per_point: pts(42) ? round(1 / pts(42)!, 0) : undefined,
          receiving_td: pts(43),
          fumble_lost: pts(72),
        };
        const out = {
          league_id: lg.id,
          season: lg.seasonId,
          name: s?.name,
          size: s?.size,
          is_public: s?.isPublic,
          current_week: lg.scoringPeriodId,
          current_matchup_period: lg.status?.currentMatchupPeriod,
          first_week: lg.status?.firstScoringPeriod,
          final_week: lg.status?.finalScoringPeriod,
          roster_slots: slots,
          scoring_type: s?.scoringSettings?.scoringType,
          ppr_points: pts(53),
          key_scoring: keyScoring,
          waivers: {
            type: s?.acquisitionSettings?.acquisitionType,
            faab_budget: s?.acquisitionSettings?.acquisitionBudget,
            waiver_hours: s?.acquisitionSettings?.waiverHours,
            min_bid: s?.acquisitionSettings?.minimumBid,
          },
          trade_deadline: fmtDate(s?.tradeSettings?.deadlineDate),
          trade_veto_votes: s?.tradeSettings?.vetoVotesRequired,
          playoffs: {
            teams: s?.scheduleSettings?.playoffTeamCount,
            regular_season_weeks: s?.scheduleSettings?.matchupPeriodCount,
            playoff_matchup_length_weeks: s?.scheduleSettings?.playoffMatchupPeriodLength,
          },
          draft: { type: s?.draftSettings?.type, date: fmtDate(s?.draftSettings?.date), auction_budget: s?.draftSettings?.auctionBudget, keepers: s?.draftSettings?.keeperCount },
        };
        return render(response_format, () => [
          `# ${out.name} (league ${out.league_id}, ${out.season})`,
          `- Teams: ${out.size} · Current week: ${out.current_week} (matchup period ${out.current_matchup_period}) · Final week: ${out.final_week}`,
          `- Roster: ${Object.entries(slots).map(([k, v]) => `${v}×${k}`).join(", ")}`,
          `- Scoring: ${out.scoring_type}; reception = ${out.ppr_points ?? 0} pt; pass TD ${keyScoring.passing_td}, rush/rec TD ${keyScoring.rushing_td}/${keyScoring.receiving_td}, INT ${keyScoring.interception}, fumble ${keyScoring.fumble_lost}; 1 pt per ${keyScoring.passing_yards_per_point} pass yds / ${keyScoring.rushing_yards_per_point} rush yds / ${keyScoring.receiving_yards_per_point} rec yds`,
          `- Waivers: ${out.waivers.type}${out.waivers.faab_budget ? ` (FAAB $${out.waivers.faab_budget}, min bid ${out.waivers.min_bid})` : ""}, ${out.waivers.waiver_hours}h waiver period`,
          `- Trade deadline: ${out.trade_deadline}; veto votes required: ${out.trade_veto_votes}`,
          `- Playoffs: ${out.playoffs.teams} teams after ${out.playoffs.regular_season_weeks} regular-season weeks`,
          `- Draft: ${out.draft.type} on ${out.draft.date}${out.draft.keepers ? `, ${out.draft.keepers} keepers` : ""}`,
        ].join("\n"), out);
      } catch (e) { return toolError(e); }
    },
  );

  server.registerTool(
    "espn_list_teams",
    {
      title: "List ESPN league teams and standings",
      description: `List all teams in an ESPN fantasy league with owners, record, points for/against, streak, playoff seed, waiver priority, and FAAB spent. Sorted by standings (playoff seed, then wins, then points for).

Args:
  - league_id, season, response_format as in espn_get_league_settings.

Returns (json): { league_id, season, week, teams: [{ team_id, name, abbrev, owners, wins, losses, ties, points_for, points_against, streak, playoff_seed, waiver_rank, faab_spent, acquisitions, trades }] }

Use to map team names to team_id before calling espn_get_roster or espn_get_matchups.`,
      inputSchema: { league_id: leagueIdSchema, season: seasonSchema, response_format: responseFormatSchema },
      annotations: READ_ONLY,
    },
    async ({ league_id, season, response_format }) => {
      try {
        const lg = await getLeague(league_id, season, ["mTeam", "mSettings"]);
        const teams = (lg.teams ?? []).map((t) => teamRow(t, lg)).sort((a, b) =>
          (a.playoff_seed ?? 99) - (b.playoff_seed ?? 99) || b.wins - a.wins || (b.points_for ?? 0) - (a.points_for ?? 0));
        const out = { league_id: lg.id, season: lg.seasonId, week: lg.scoringPeriodId, name: lg.settings?.name, teams };
        return render(response_format, () => [
          `# ${out.name} standings (week ${out.week}, ${out.season})`,
          `| Seed | Team | ID | Owner(s) | W-L-T | PF | PA | Streak | Waiver # | FAAB spent |`,
          `|---|---|---|---|---|---|---|---|---|---|`,
          ...teams.map((t) => `| ${t.playoff_seed ?? "–"} | ${t.name} | ${t.team_id} | ${t.owners} | ${t.wins}-${t.losses}-${t.ties} | ${t.points_for ?? 0} | ${t.points_against ?? 0} | ${t.streak ?? "–"} | ${t.waiver_rank ?? "–"} | ${t.faab_spent ?? "–"} |`),
        ].join("\n"), out);
      } catch (e) { return toolError(e); }
    },
  );

  server.registerTool(
    "espn_get_roster",
    {
      title: "Get an ESPN team's roster",
      description: `Get the full roster of one fantasy team (or all teams) with lineup slot, position, NFL team, season points, season projection, and optionally a specific week's actual and projected points.

Args:
  - league_id, season: as above.
  - team_id (number, optional): ESPN team id (from espn_list_teams). Omit to return ALL rosters (large; prefer markdown).
  - week (number, optional): scoring period (NFL week). If given, roster and points reflect that week; otherwise the current week.
  - response_format: 'markdown' | 'json'.

Returns (json): { league_id, season, week, teams: [{ team_id, name, owners, roster: [{ slot, name, position, pro_team, injury_status, season_points, season_projected, season_avg, week_points, week_projected, percent_owned, player_id, acquisition_type }] }] }

Starters are listed first (QB, RB, WR, TE, FLEX, D/ST, K), then BE (bench) and IR.`,
      inputSchema: {
        league_id: leagueIdSchema,
        season: seasonSchema,
        team_id: z.number().int().positive().optional().describe("Team id from espn_list_teams. Omit for all teams."),
        week: z.number().int().min(1).max(18).optional().describe("NFL week (scoringPeriodId). Defaults to the current week."),
        response_format: responseFormatSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ league_id, season, team_id, week, response_format }) => {
      try {
        const yr = season ?? defaultSeason();
        const lg = await getLeague(league_id, yr, ["mRoster", "mTeam"], { scoringPeriodId: week });
        const wk = week ?? lg.scoringPeriodId;
        let teams = lg.teams ?? [];
        if (team_id !== undefined) {
          teams = teams.filter((t) => t.id === team_id);
          if (!teams.length) {
            return toolError(new Error(`No team with id ${team_id} in league ${lg.id}. Valid ids: ${(lg.teams ?? []).map((t) => `${t.id} (${teamDisplayName(t)})`).join(", ")}`));
          }
        }
        const outTeams = teams.map((t) => ({
          team_id: t.id,
          name: teamDisplayName(t),
          owners: ownerNames(t, lg),
          roster: sortRoster((t.roster?.entries ?? []).map((r) => summarizeRosterEntry(r, yr, wk))),
        }));
        const out = { league_id: lg.id, season: yr, week: wk, teams: outTeams };
        return render(response_format, () => outTeams.map((t) =>
          `## ${t.name} (team ${t.team_id}${t.owners ? `, ${t.owners}` : ""}) — week ${wk}\n${rosterTable(t.roster, wk)}`).join("\n\n"), out);
      } catch (e) { return toolError(e); }
    },
  );

  server.registerTool(
    "espn_get_draft_results",
    {
      title: "Get ESPN league draft results",
      description: `Get the completed draft for a league: every pick with round, overall pick number, team, player, position, NFL team, and (auction) bid amount. Optionally filter to one team or round.

Args:
  - league_id, season: as above.
  - team_id (number, optional): only picks by this team.
  - round (number, optional): only this round.
  - response_format: 'markdown' | 'json'.

Returns (json): { league_id, season, drafted, in_progress, pick_count, picks: [{ overall, round, pick_in_round, team_id, team, player_id, player, position, pro_team, bid, keeper }] }`,
      inputSchema: {
        league_id: leagueIdSchema,
        season: seasonSchema,
        team_id: z.number().int().positive().optional(),
        round: z.number().int().min(1).max(30).optional(),
        response_format: responseFormatSchema,
      },
      annotations: READ_ONLY,
    },
    async ({ league_id, season, team_id, round: rnd, response_format }) => {
      try {
        const lg = await getLeague(league_id, season, ["mDraftDetail", "mTeam"]);
        const picks = lg.draftDetail?.picks ?? [];
        if (!picks.length) {
          return render(response_format, () => `Draft has not happened yet for league ${lg.id} (drafted=${lg.draftDetail?.drafted ?? false}).`, { league_id: lg.id, drafted: false, picks: [] });
        }
        // Resolve player names in one bulk call filtered to drafted ids.
        const ids = picks.map((p) => p.playerId);
        const pool = await getLeague(league_id, season, ["kona_player_info"], undefined, idsFilter(ids));
        const byId = new Map((pool.players ?? []).map((e) => [e.id, e.player]));
        const names = teamNameMap(lg);
        let rows = picks.map((p) => {
          const pl = byId.get(p.playerId);
          return {
            overall: p.overallPickNumber, round: p.roundId, pick_in_round: p.roundPickNumber,
            team_id: p.teamId, team: names.get(p.teamId) ?? `Team ${p.teamId}`,
            player_id: p.playerId, player: pl?.fullName ?? `Player ${p.playerId}`,
            position: pl ? positionOf(pl) : "?", pro_team: pl ? proTeamOf(pl) : "?",
            bid: p.bidAmount || undefined, keeper: p.keeper || undefined,
          };
        }).sort((a, b) => a.overall - b.overall);
        if (team_id !== undefined) rows = rows.filter((r) => r.team_id === team_id);
        if (rnd !== undefined) rows = rows.filter((r) => r.round === rnd);
        const out = { league_id: lg.id, season: lg.seasonId, drafted: lg.draftDetail?.drafted, in_progress: lg.draftDetail?.inProgress, pick_count: rows.length, picks: rows };
        return render(response_format, () => [
          `# Draft results — league ${lg.id} (${rows.length} picks)`,
          `| Overall | Rd.Pick | Team | Player | Pos | NFL |${rows.some((r) => r.bid) ? " Bid |" : ""}`,
          `|---|---|---|---|---|---|${rows.some((r) => r.bid) ? "---|" : ""}`,
          ...rows.map((r) => `| ${r.overall} | ${r.round}.${r.pick_in_round} | ${r.team} | ${r.player}${r.keeper ? " (K)" : ""} | ${r.position} | ${r.pro_team} |${rows.some((x) => x.bid) ? ` ${r.bid ?? ""} |` : ""}`),
        ].join("\n"), out);
      } catch (e) { return toolError(e); }
    },
  );
}
