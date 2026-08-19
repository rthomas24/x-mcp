/**
 * Local state: tokens, cost ledger, what we've posted/replied/followed, read
 * dedup cache, metric snapshots, the approval queue and the human handoff queue.
 * Plain JSON files with atomic writes — volumes are tiny and this keeps the
 * server dependency-free.
 *
 * Two processes can touch the files (the MCP server and the `x-mcp approve` CLI),
 * so `update()` re-reads the file when its mtime moved under us, and tokens are
 * never overwritten by an older token set.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
  scope?: string;
  token_type?: string;
}

export interface LedgerEntry {
  ts: number;
  tool: string;
  op: string; // e.g. "post.create", "read.post", "read.owned"
  units: number;
  usd: number;
  note?: string;
}

export interface MyPost {
  id: string;
  text: string;
  created_at: number;
  kind: 'original' | 'reply' | 'quote' | 'thread_child';
  conversation_id?: string;
  in_reply_to?: string;
  quoted?: string;
  has_url: boolean;
  media_ids?: string[];
  video_seconds?: number;
  /** Free-form experiment tags (e.g. "video", "receipt", "question") for `insights`. */
  tags?: string[];
  idea_id?: string;
}

export interface MetricSnapshot {
  ts: number;
  impressions?: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  bookmarks?: number;
  url_clicks?: number;
  profile_clicks?: number;
}

export interface FollowEvent {
  user_id: string;
  username?: string;
  ts: number;
  action: 'follow' | 'unfollow';
}

export type WriteTool = 'publish' | 'reply' | 'repost' | 'dm' | 'delete_post';

export interface QueuedAction {
  id: string;
  ts: number;
  tool: WriteTool;
  args: Record<string, unknown>;
  preview: string;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
  result?: unknown;
}

export interface HandoffItem {
  id: string;
  ts: number;
  kind: 'quote' | 'cold_reply' | 'follow' | 'like' | 'manual_post';
  target_post_id?: string;
  target_username?: string;
  text?: string;
  why?: string;
  status: 'pending' | 'done' | 'dropped';
  resolved_ts?: number;
  resolved_post_id?: string;
}

/** A person the account has interacted with — the relationship ledger (CRM). */
export interface Person {
  id: string;
  username: string;
  name?: string;
  followers?: number;
  band?: 'peer_small' | 'mid' | 'large';
  mutual?: boolean;
  follows_me?: boolean;
  followed_by_me?: boolean;
  first_seen: number;
  last_seen: number;
  /** Counts of what they did to us / we did to them. */
  mentions_of_me: number;
  replies_to_me: number;
  my_replies: number;
  tags: string[];
  notes: string[];
  last_post_id?: string;
}

export interface ScheduledPost {
  id: string;
  created: number;
  not_before: number;
  args: Record<string, unknown>; // publish args
  status: 'pending' | 'posted' | 'queued' | 'failed' | 'cancelled';
  result?: unknown;
  posted_id?: string;
}

export interface Idea {
  id: string;
  ts: number;
  text: string;
  source_url?: string;
  format?: string;
  tags: string[];
  status: 'open' | 'used' | 'dropped';
  used_post_id?: string;
}

export interface Brand {
  lane?: string;
  voice: string[];
  banned: string[];
  goals: { followers?: { target: number; by: string }; originals_per_week?: number; reply_within_hours?: number };
  updated?: number;
}

export interface State {
  posts: Record<string, MyPost>;
  metrics: Record<string, MetricSnapshot[]>; // post id → snapshots (newest last)
  repliedConversations: Record<string, { post_id: string; ts: number }>; // target post id → our reply
  replyTexts: { text: string; ts: number; post_id: string }[];
  follows: FollowEvent[];
  readCache: Record<string, number>; // "<utcday>:<op>:<key>" → ts of paid read
  ledger: LedgerEntry[];
  queue: QueuedAction[];
  handoff: HandoffItem[];
  seenMentions: Record<string, number>; // mention post id → ts handled
  mentionAuthors: Record<string, string>; // mention post id → author user id (lets reply credit the person without a paid read)
  lastMentionId?: string;
  followerSnapshots: { ts: number; followers: number; following: number }[];
  me?: { id: string; username: string; name?: string };
  people: Record<string, Person>;
  scheduled: ScheduledPost[];
  ideas: Idea[];
  brand: Brand;
}

const EMPTY: State = {
  posts: {},
  metrics: {},
  repliedConversations: {},
  replyTexts: [],
  follows: [],
  readCache: {},
  ledger: [],
  queue: [],
  handoff: [],
  seenMentions: {},
  mentionAuthors: {},
  followerSnapshots: [],
  people: {},
  scheduled: [],
  ideas: [],
  brand: { voice: [], banned: [], goals: {} },
};

const DAY = 86_400_000;

function atomicWrite(path: string, data: string, mode = 0o600): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { encoding: 'utf8', mode });
  renameSync(tmp, path);
}

function mtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export class Store {
  private state: State;
  private readonly statePath: string;
  private readonly tokensPath: string;
  private loadedMtime = 0;
  private tokensCache: { tokens: Tokens | undefined; mtime: number } | undefined;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      if (statSync(dir).mode & 0o077) chmodSync(dir, 0o700);
    } catch {
      /* ignore */
    }
    this.statePath = join(dir, 'state.json');
    this.tokensPath = join(dir, 'tokens.json');
    this.state = this.load();
  }

  private load(): State {
    this.loadedMtime = mtimeOf(this.statePath);
    if (!existsSync(this.statePath)) return structuredClone(EMPTY);
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<State>;
      return { ...structuredClone(EMPTY), ...parsed };
    } catch {
      // Corrupt state should not brick the server; keep a copy and start fresh.
      try {
        renameSync(this.statePath, `${this.statePath}.corrupt.${Date.now()}`);
      } catch {
        /* ignore */
      }
      return structuredClone(EMPTY);
    }
  }

  /** Read access to state (mutate via `update`). */
  get s(): Readonly<State> {
    return this.state;
  }

  /**
   * Apply a mutation and write it out immediately (state is small; writes are rare).
   * If another process wrote the file since we last read it, reload first so we
   * never clobber its changes — this is what lets the server and `x-mcp approve`
   * share one state file safely.
   */
  update(fn: (s: State) => void): void {
    if (mtimeOf(this.statePath) !== this.loadedMtime) this.state = this.load();
    fn(this.state);
    this.flush();
  }

  /** Write state to disk now. */
  flush(): void {
    this.trim();
    atomicWrite(this.statePath, JSON.stringify(this.state));
    this.loadedMtime = mtimeOf(this.statePath);
  }

  /** Keep the hot file small: every flush serialises the whole state. */
  private trim(): void {
    const s = this.state;
    const now = Date.now();
    if (s.ledger.length > 20_000) s.ledger = s.ledger.slice(-20_000);
    if (s.replyTexts.length > 2_000) s.replyTexts = s.replyTexts.slice(-2_000);
    if (s.follows.length > 5_000) s.follows = s.follows.slice(-5_000);
    for (const [k, ts] of Object.entries(s.readCache)) if (ts < now - 3 * DAY) delete s.readCache[k];
    for (const [k, ts] of Object.entries(s.seenMentions)) {
      if (ts < now - 30 * DAY) {
        delete s.seenMentions[k];
        delete s.mentionAuthors[k];
      }
    }
    for (const [k, v] of Object.entries(s.repliedConversations)) if (v.ts < now - 90 * DAY) delete s.repliedConversations[k];
    for (const [k, p] of Object.entries(s.posts)) {
      if (p.created_at < now - 90 * DAY) {
        delete s.posts[k];
        delete s.metrics[k];
      }
    }
    for (const [k, snaps] of Object.entries(s.metrics)) {
      if (!s.posts[k] && (snaps.at(-1)?.ts ?? 0) < now - 30 * DAY) delete s.metrics[k];
      else if (snaps.length > 200) s.metrics[k] = snaps.slice(-200);
    }
    s.queue = s.queue.filter((q) => q.status === 'pending' || q.ts > now - 30 * DAY);
    for (const q of s.queue) if (q.status !== 'pending' && q.result && JSON.stringify(q.result).length > 2_000) q.result = { truncated: true };
    s.handoff = s.handoff.filter((h) => h.status === 'pending' || (h.resolved_ts ?? h.ts) > now - 90 * DAY);
    s.scheduled = s.scheduled.filter((x) => x.status === 'pending' || x.created > now - 60 * DAY);
    const people = Object.values(s.people);
    if (people.length > 5_000) {
      people.sort((a, b) => b.last_seen - a.last_seen);
      s.people = Object.fromEntries(people.slice(0, 5_000).map((p) => [p.id, p]));
    }
  }

  // ---- tokens -------------------------------------------------------------
  loadTokens(): Tokens | undefined {
    const mtime = mtimeOf(this.tokensPath);
    if (this.tokensCache && this.tokensCache.mtime === mtime) return this.tokensCache.tokens;
    let tokens: Tokens | undefined;
    if (existsSync(this.tokensPath)) {
      try {
        const t = JSON.parse(readFileSync(this.tokensPath, 'utf8')) as Tokens;
        tokens = t?.access_token ? t : undefined;
      } catch {
        tokens = undefined;
      }
    }
    this.tokensCache = { tokens, mtime };
    return tokens;
  }

  /** Never replace a newer token set (another process may have refreshed first). */
  saveTokens(t: Tokens): void {
    this.tokensCache = undefined;
    const onDisk = this.loadTokens();
    if (onDisk && onDisk.expires_at > t.expires_at && onDisk.access_token !== t.access_token) return;
    atomicWrite(this.tokensPath, JSON.stringify(t, null, 2));
    this.tokensCache = { tokens: t, mtime: mtimeOf(this.tokensPath) };
  }

  clearTokens(): void {
    this.tokensCache = undefined;
    if (existsSync(this.tokensPath)) atomicWrite(this.tokensPath, '{}');
  }
}
