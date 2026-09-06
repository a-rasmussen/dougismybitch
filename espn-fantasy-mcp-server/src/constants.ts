/** Shared constants and ESPN ID maps. */

export const API_BASE_URL = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl";
export const CHARACTER_LIMIT = 25000;
export const REQUEST_TIMEOUT_MS = 30000;

/** Default season: env override, else the current NFL season (Sep–Dec = this year, Jan–Aug = previous year is ambiguous, so we use the calendar year). */
export function defaultSeason(): number {
  const env = process.env.ESPN_SEASON;
  if (env && /^\d{4}$/.test(env)) return parseInt(env, 10);
  const now = new Date();
  // NFL fantasy seasons run Aug–Jan; before August, ESPN is still on last year's season.
  return now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
}

/** Player defaultPositionId → position label. */
export const POSITION_MAP: Record<number, string> = {
  1: "QB",
  2: "RB",
  3: "WR",
  4: "TE",
  5: "K",
  16: "D/ST",
};

/** Lineup slot id → label (roster slots). */
export const SLOT_MAP: Record<number, string> = {
  0: "QB",
  2: "RB",
  3: "RB/WR",
  4: "WR",
  5: "WR/TE",
  6: "TE",
  7: "OP",
  16: "D/ST",
  17: "K",
  20: "BE",
  21: "IR",
  23: "FLEX",
};

/** Filter position label → the slot id ESPN uses in X-Fantasy-Filter filterSlotIds. */
export const POSITION_TO_FILTER_SLOT: Record<string, number> = {
  QB: 0,
  RB: 2,
  WR: 4,
  TE: 6,
  K: 17,
  "D/ST": 16,
  DST: 16,
  FLEX: 23,
};

/** proTeamId → NFL abbreviation. */
export const PRO_TEAM_MAP: Record<number, string> = {
  0: "FA",
  1: "ATL",
  2: "BUF",
  3: "CHI",
  4: "CIN",
  5: "CLE",
  6: "DAL",
  7: "DEN",
  8: "DET",
  9: "GB",
  10: "TEN",
  11: "IND",
  12: "KC",
  13: "LV",
  14: "LAR",
  15: "MIA",
  16: "MIN",
  17: "NE",
  18: "NO",
  19: "NYG",
  20: "NYJ",
  21: "PHI",
  22: "ARI",
  23: "PIT",
  24: "LAC",
  25: "SF",
  26: "SEA",
  27: "TB",
  28: "WSH",
  29: "CAR",
  30: "JAX",
  33: "BAL",
  34: "HOU",
};

/** Transaction type codes used by mTransactions2. */
export const TRANSACTION_TYPE_MAP: Record<string, string> = {
  FREEAGENT: "Free agent add",
  WAIVER: "Waiver claim",
  TRADE_ACCEPT: "Trade",
  TRADE_PROPOSAL: "Trade proposal",
  DRAFT: "Draft",
  ROSTER: "Lineup change",
  WAIVER_ERROR: "Failed waiver",
};
