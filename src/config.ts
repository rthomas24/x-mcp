/**
 * Runtime configuration for x-mcp. Everything comes from environment variables.
 *
 * Security: we deliberately do NOT read a `.env` from process.cwd() — MCP hosts
 * spawn servers with cwd = the current project, and a hostile repo could plant
 * `X_API_BASE=https://evil` to capture the bearer token. Only the state dir's
 * `.env` (or an explicit X_MCP_ENV_FILE) is loaded, and only X_* keys.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_API_BASE = 'https://api.x.com';

function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?(X_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let val = m[2]!;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = val;
  }
}

const stateDirFromEnv = (): string => process.env.X_MCP_STATE_DIR ?? join(homedir(), '.x-mcp');
loadEnvFile(process.env.X_MCP_ENV_FILE ?? join(stateDirFromEnv(), '.env'));

const num = (v: string | undefined, d: number): number => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v: string | undefined, d: boolean): boolean => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));

export interface Config {
  /** OAuth 2.0 client id from the X Developer Console (required). */
  clientId: string;
  /** OAuth 2.0 client secret — only for confidential clients. Public/native clients leave it unset. */
  clientSecret: string | undefined;
  /** Redirect URI registered in the Developer Console. Defaults to the local callback used by `x-mcp login`. */
  redirectUri: string;
  /** Local port for the OAuth callback server. */
  callbackPort: number;
  /** Where tokens, ledger and state live. */
  stateDir: string;
  /** Directories media may be uploaded from (realpath-checked). Default `<stateDir>/media`. */
  mediaRoots: string[];
  /** Hard monthly USD budget; write/read tools refuse once exceeded. */
  monthlyBudgetUsd: number;
  /** Soft warning threshold as a fraction of the budget (0.8 = warn at 80%). */
  budgetWarnAt: number;
  /** When true (default), publish/reply/repost/dm/delete queue for `x-mcp approve` instead of executing. */
  requireApproval: boolean;
  /** Minimum gap between two *original* posts, in hours (algorithm: author-diversity decay, cold-start picks one). */
  minHoursBetweenOriginals: number;
  /** Throttles — bursts look mechanical to X's behavioural model. */
  maxRepliesPerHour: number;
  maxRepostsPerDay: number;
  maxDmsPerHour: number;
  /** Refuse a reply whose text is this similar (0..1 Jaccard) to one sent in the last N days. */
  copypastaSimilarity: number;
  copypastaLookbackDays: number;
  /** Cap on public-post reads per single tool call (each is $0.005). */
  maxReadsPerCall: number;
  /** Optional path to ffprobe for video duration checks; auto-detected if unset. */
  ffprobePath: string | undefined;
  /** API base. Locked to https://api.x.com unless X_MCP_ALLOW_CUSTOM_API_BASE=1 (tests). */
  apiBase: string;
  /** Network timeout for API calls (ms). */
  requestTimeoutMs: number;
}

export function loadConfig(): Config {
  const stateDir = stateDirFromEnv();
  const callbackPort = num(process.env.X_MCP_CALLBACK_PORT, 8477);
  let apiBase = DEFAULT_API_BASE;
  if (process.env.X_API_BASE && process.env.X_API_BASE !== DEFAULT_API_BASE) {
    if (!bool(process.env.X_MCP_ALLOW_CUSTOM_API_BASE, false)) {
      console.error(`[x-mcp] ignoring X_API_BASE=${process.env.X_API_BASE} (set X_MCP_ALLOW_CUSTOM_API_BASE=1 to allow a non-default API host — your bearer token is sent there).`);
    } else apiBase = process.env.X_API_BASE;
  }
  const roots = (process.env.X_MCP_MEDIA_ROOT ?? join(stateDir, 'media'))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p));
  return {
    clientId: process.env.X_CLIENT_ID ?? '',
    clientSecret: process.env.X_CLIENT_SECRET || undefined,
    redirectUri: process.env.X_REDIRECT_URI ?? `http://127.0.0.1:${callbackPort}/callback`,
    callbackPort,
    stateDir,
    mediaRoots: roots,
    monthlyBudgetUsd: num(process.env.X_MCP_MONTHLY_BUDGET_USD, 25),
    budgetWarnAt: num(process.env.X_MCP_BUDGET_WARN_AT, 0.8),
    requireApproval: bool(process.env.X_MCP_REQUIRE_APPROVAL, true),
    minHoursBetweenOriginals: num(process.env.X_MCP_MIN_HOURS_BETWEEN_ORIGINALS, 4),
    maxRepliesPerHour: num(process.env.X_MCP_MAX_REPLIES_PER_HOUR, 12),
    maxRepostsPerDay: num(process.env.X_MCP_MAX_REPOSTS_PER_DAY, 10),
    maxDmsPerHour: num(process.env.X_MCP_MAX_DMS_PER_HOUR, 5),
    copypastaSimilarity: num(process.env.X_MCP_COPYPASTA_SIMILARITY, 0.7),
    copypastaLookbackDays: num(process.env.X_MCP_COPYPASTA_LOOKBACK_DAYS, 14),
    maxReadsPerCall: num(process.env.X_MCP_MAX_READS_PER_CALL, 100),
    ffprobePath: process.env.X_MCP_FFPROBE || undefined,
    apiBase,
    requestTimeoutMs: num(process.env.X_MCP_REQUEST_TIMEOUT_MS, 30_000),
  };
}
