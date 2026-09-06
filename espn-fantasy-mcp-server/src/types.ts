/** Minimal TypeScript interfaces for the parts of ESPN's v3 fantasy JSON we consume. */

export interface EspnStat {
  id: string;
  seasonId: number;
  scoringPeriodId: number;
  statSourceId: number; // 0 = actual, 1 = projected
  statSplitTypeId: number; // 0 = season total, 1 = single week
  appliedTotal?: number;
  appliedAverage?: number;
  stats?: Record<string, number>;
}

export interface EspnPlayer {
  id: number;
  fullName: string;
  firstName?: string;
  lastName?: string;
  defaultPositionId: number;
  proTeamId: number;
  eligibleSlots?: number[];
  injured?: boolean;
  injuryStatus?: string;
  active?: boolean;
  droppable?: boolean;
  ownership?: {
    percentOwned?: number;
    percentStarted?: number;
    percentChange?: number;
    averageDraftPosition?: number;
  };
  stats?: EspnStat[];
  draftRanksByRankType?: Record<string, { rank: number; auctionValue?: number }>;
}

export interface EspnPlayerPoolEntry {
  id: number;
  onTeamId: number;
  status?: string; // FREEAGENT / WAIVERS / ONTEAM
  lineupLocked?: boolean;
  player: EspnPlayer;
  ratings?: Record<string, { positionalRanking?: number; totalRanking?: number; totalRating?: number }>;
}

export interface EspnRosterEntry {
  playerId: number;
  lineupSlotId: number;
  acquisitionType?: string;
  acquisitionDate?: number;
  injuryStatus?: string;
  playerPoolEntry: EspnPlayerPoolEntry;
}

export interface EspnTeamRecord {
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
  streakType?: string;
  streakLength?: number;
}

export interface EspnTeam {
  id: number;
  abbrev: string;
  name?: string;
  location?: string;
  nickname?: string;
  owners?: string[];
  primaryOwner?: string;
  playoffSeed?: number;
  waiverRank?: number;
  logo?: string;
  record?: { overall: EspnTeamRecord; home?: EspnTeamRecord; away?: EspnTeamRecord };
  points?: number;
  pointsAdjusted?: number;
  currentProjectedRank?: number;
  draftDayProjectedRank?: number;
  roster?: { entries: EspnRosterEntry[] };
  transactionCounter?: {
    acquisitionBudgetSpent?: number;
    acquisitions?: number;
    drops?: number;
    trades?: number;
    moveToActive?: number;
    moveToIR?: number;
  };
}

export interface EspnMember {
  id: string;
  displayName: string;
  firstName?: string;
  lastName?: string;
}

export interface EspnMatchupSide {
  teamId: number;
  totalPoints?: number;
  totalProjectedPointsLive?: number;
  totalPointsLive?: number;
  cumulativeScore?: { wins: number; losses: number; ties: number };
  rosterForCurrentScoringPeriod?: { appliedStatTotal?: number; entries: EspnRosterEntry[] };
  rosterForMatchupPeriod?: { appliedStatTotal?: number; entries: EspnRosterEntry[] };
  pointsByScoringPeriod?: Record<string, number>;
}

export interface EspnMatchup {
  id: number;
  matchupPeriodId: number;
  playoffTierType?: string;
  winner?: string; // HOME / AWAY / UNDECIDED / TIE
  home: EspnMatchupSide;
  away?: EspnMatchupSide;
}

export interface EspnScheduleSettings {
  matchupPeriodCount?: number;
  playoffTeamCount?: number;
  playoffMatchupPeriodLength?: number;
  matchupPeriods?: Record<string, number[]>;
}

export interface EspnLeagueSettings {
  name: string;
  size?: number;
  isPublic?: boolean;
  scheduleSettings?: EspnScheduleSettings;
  rosterSettings?: { lineupSlotCounts?: Record<string, number>; rosterLocktimeType?: number };
  scoringSettings?: {
    scoringType?: string;
    playoffMatchupTieRule?: string;
    scoringItems?: { statId: number; points: number; pointsOverrides?: Record<string, number> }[];
  };
  acquisitionSettings?: {
    acquisitionBudget?: number;
    acquisitionType?: string;
    waiverHours?: number;
    minimumBid?: number;
  };
  tradeSettings?: { deadlineDate?: number; vetoVotesRequired?: number; allowOutOfUniverse?: boolean };
  draftSettings?: { date?: number; type?: string; auctionBudget?: number; keeperCount?: number };
}

export interface EspnLeague {
  id: number;
  seasonId: number;
  scoringPeriodId: number; // current NFL week
  segmentId?: number;
  gameId?: number;
  status?: {
    currentMatchupPeriod?: number;
    finalScoringPeriod?: number;
    firstScoringPeriod?: number;
    latestScoringPeriod?: number;
    isActive?: boolean;
    waiverLastExecutionDate?: number;
    teamsJoined?: number;
  };
  settings?: EspnLeagueSettings;
  teams?: EspnTeam[];
  members?: EspnMember[];
  schedule?: EspnMatchup[];
  players?: EspnPlayerPoolEntry[];
  transactions?: EspnTransaction[];
  draftDetail?: { drafted?: boolean; inProgress?: boolean; picks?: EspnDraftPick[] };
}

export interface EspnDraftPick {
  id: number;
  overallPickNumber: number;
  roundId: number;
  roundPickNumber: number;
  playerId: number;
  teamId: number;
  bidAmount?: number;
  keeper?: boolean;
}

export interface EspnTransactionItem {
  playerId: number;
  type: string; // ADD / DROP / LINEUP
  fromTeamId: number;
  toTeamId: number;
  fromLineupSlotId?: number;
  toLineupSlotId?: number;
}

export interface EspnTransaction {
  id: string;
  type: string;
  status: string; // EXECUTED / PENDING / CANCELED / FAILED_INVALIDPLAYERSOURCE ...
  teamId: number;
  memberId?: string;
  bidAmount?: number;
  proposedDate?: number;
  processDate?: number;
  executionType?: string;
  scoringPeriodId?: number;
  isPending?: boolean;
  rating?: number;
  items?: EspnTransactionItem[];
  relatedTransactionId?: string;
}

/** ESPN's error envelope. */
export interface EspnErrorEnvelope {
  messages?: string[];
  details?: { message: string; type?: string }[];
}
