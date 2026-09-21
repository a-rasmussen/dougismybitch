/**
 * ESPN Fantasy v3 API client.
 *
 * Auth: private leagues need two cookies from a logged-in ESPN browser session:
 *   ESPN_S2 (long URL-encoded string) and ESPN_SWID ("{XXXXXXXX-XXXX-...}" with braces).
 * They are read from environment variables (set in claude_desktop_config.json or a .env file).
 * Public endpoints (player pool, pro schedules) work without them.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { API_BASE_URL, REQUEST_TIMEOUT_MS, defaultSeason } from "../constants.js";
import type { EspnErrorEnvelope, EspnLeague } from "../types.js";

export class EspnApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly espnType?: string,
  ) {
    super(message);
    this.name = "EspnApiError";
  }
}

export interface AuthConfig {
  espnS2?: string;
  swid?: string;
}

/** Credentials file written by scripts/save-espn-cookies.sh (kept outside Claude Desktop's config). */
export const CREDENTIALS_FILE =
  process.env.ESPN_CREDENTIALS_FILE?.trim() || join(homedir(), ".config", "espn-fantasy", "credentials.json");

/** Env vars win; otherwise fall back to the credentials file. Read on every call so refreshed cookies apply without a restart. */
export function loadAuthFromEnv(): AuthConfig {
  let espnS2 = process.env.ESPN_S2?.trim() || undefined;
  let swid = process.env.ESPN_SWID?.trim() || undefined;
  if (!espnS2 || !swid) {
    try {
      const f = JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8")) as { espn_s2?: string; swid?: string };
      espnS2 ||= f.espn_s2?.trim() || undefined;
      swid ||= f.swid?.trim() || undefined;
    } catch {
      /* no credentials file - public data only */
    }
  }
  return { espnS2, swid };
}

export function defaultLeagueId(): number | undefined {
  const v = process.env.ESPN_LEAGUE_ID?.trim();
  return v && /^\d+$/.test(v) ? parseInt(v, 10) : undefined;
}

function buildCookieHeader(auth: AuthConfig): string | undefined {
  const parts: string[] = [];
  if (auth.espnS2) parts.push(`espn_s2=${auth.espnS2}`);
  if (auth.swid) parts.push(`SWID=${auth.swid}`);
  return parts.length ? parts.join("; ") : undefined;
}

export interface EspnRequestOptions {
  /** One or more `view=` parameters (e.g. ["mTeam","mRoster"]). */
  views?: string[];
  /** Extra query params (e.g. { scoringPeriodId: 3 }). */
  params?: Record<string, string | number | undefined>;
  /** JSON object serialized into the X-Fantasy-Filter header. */
  fantasyFilter?: Record<string, unknown>;
}

/** Perform a GET against the ESPN fantasy API and parse JSON, mapping errors to EspnApiError. */
export async function espnGet<T>(path: string, opts: EspnRequestOptions = {}, auth: AuthConfig = loadAuthFromEnv()): Promise<T> {
  const url = new URL(`${API_BASE_URL}${path}`);
  for (const v of opts.views ?? []) url.searchParams.append("view", v);
  for (const [k, v] of Object.entries(opts.params ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "espn-fantasy-mcp-server/1.0",
  };
  const cookie = buildCookieHeader(auth);
  if (cookie) headers["Cookie"] = cookie;
  if (opts.fantasyFilter) headers["X-Fantasy-Filter"] = JSON.stringify(opts.fantasyFilter);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new EspnApiError("Request to ESPN timed out after 30s. Try again or narrow the request (fewer views, smaller limit).");
    }
    throw new EspnApiError(`Network error reaching ESPN: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new EspnApiError(`ESPN returned non-JSON (HTTP ${res.status}). The endpoint may have changed or the cookies may be invalid.`, res.status);
  }

  // ESPN sometimes returns 200 with an error envelope, sometimes 401/404.
  const env = body as EspnErrorEnvelope;
  if (!res.ok || (env && Array.isArray(env.messages) && env.messages.length && !("id" in (body as object)) && !("players" in (body as object)))) {
    const espnType = env?.details?.[0]?.type;
    const msg = env?.messages?.[0] ?? `HTTP ${res.status}`;
    if (espnType === "AUTH_LEAGUE_NOT_VISIBLE" || res.status === 401 || res.status === 403) {
      throw new EspnApiError(
        `ESPN says: "${msg}". This league is private. Set ESPN_S2 and ESPN_SWID environment variables from a logged-in ESPN browser session (see README), and confirm the cookies belong to an account that is a member of this league. If they were set, they may have expired — log in to ESPN again and copy fresh values.`,
        res.status,
        espnType,
      );
    }
    if (res.status === 404 || espnType === "LEAGUE_NOT_FOUND") {
      throw new EspnApiError(`ESPN says: "${msg}". Check that the league_id and season are correct (league IDs are the number in the ESPN URL: ...leagueId=XXXXXXXX).`, res.status, espnType);
    }
    if (res.status === 429) {
      throw new EspnApiError("ESPN rate-limited the request (HTTP 429). Wait a minute before retrying.", res.status);
    }
    throw new EspnApiError(`ESPN API error (HTTP ${res.status}): ${msg}`, res.status, espnType);
  }

  return body as T;
}

/** Resolve the effective league id (argument → ESPN_LEAGUE_ID env). */
export function resolveLeagueId(leagueId?: number): number {
  const id = leagueId ?? defaultLeagueId();
  if (!id) {
    throw new EspnApiError("No league_id given and ESPN_LEAGUE_ID is not set. Pass league_id explicitly or set ESPN_LEAGUE_ID in the server environment.");
  }
  return id;
}

/** Fetch a league with the given views. */
export async function getLeague(leagueId: number | undefined, season: number | undefined, views: string[], params?: Record<string, string | number | undefined>, fantasyFilter?: Record<string, unknown>): Promise<EspnLeague> {
  const id = resolveLeagueId(leagueId);
  const yr = season ?? defaultSeason();
  return espnGet<EspnLeague>(`/seasons/${yr}/segments/0/leagues/${id}`, { views, params, fantasyFilter });
}
