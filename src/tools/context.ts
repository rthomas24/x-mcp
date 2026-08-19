import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { Config } from '../config.js';
import { Ledger, type Op, costOf, utcDayKey } from '../pricing.js';
import type { Person, QueuedAction, Store, WriteTool } from '../store.js';
import { authorBand, isMutual } from '../rules.js';
import { XClient, type User } from '../x/client.js';

export type ToolResult = {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export function ok(text: string, structured?: Record<string, unknown>): ToolResult {
  // Round-trip through JSON so Maps/undefined/class instances never reach the transport.
  return { content: [{ type: 'text', text }], structuredContent: structured ? JSON.parse(JSON.stringify(structured)) : undefined };
}
export function fail(err: unknown): ToolResult {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

export interface ToolDef<S extends z.ZodObject<z.ZodRawShape>> {
  title: string;
  description: string;
  inputSchema: S;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

/** registerTool with the try/catch → fail() wrapper every tool needs. */
export function tool<S extends z.ZodObject<z.ZodRawShape>>(server: McpServer, name: string, def: ToolDef<S>, handler: (args: z.infer<S>) => Promise<ToolResult>): void {
  server.registerTool(name, def as never, (async (args: z.infer<S>) => {
    try {
      return await handler(args);
    } catch (e) {
      return fail(e);
    }
  }) as never);
}

/** Everything a tool needs. One per server instance. */
export class Ctx {
  readonly ledger: Ledger;
  readonly client: XClient;
  /** Set by the CLI `approve` path: the human has approved this exact call, so do not queue it again. */
  bypassApproval = false;
  private meCache: { user: User; ts: number } | undefined;

  constructor(
    readonly cfg: Config,
    readonly store: Store,
  ) {
    this.ledger = new Ledger(store, cfg.monthlyBudgetUsd, cfg.budgetWarnAt);
    this.client = new XClient(cfg, store);
  }

  /**
   * Identity. Without `force`, uses the stored identity (no network, no cost) with
   * follower counts from the last snapshot — enough for ids/usernames/URL building.
   * `force` refreshes via users/me ($0.01) and records a follower snapshot.
   */
  async me(force = false): Promise<User> {
    if (!force) {
      if (this.meCache && Date.now() - this.meCache.ts < 6 * 3_600_000) return this.meCache.user;
      const cached = this.store.s.me;
      const snap = this.store.s.followerSnapshots.at(-1);
      if (cached) return { id: cached.id, username: cached.username, name: cached.name, metrics: { followers: snap?.followers ?? 0, following: snap?.following ?? 0, posts: 0 }, url: `https://x.com/${cached.username}` };
    }
    const u = await this.client.me();
    this.charge('me', 'read.user', 1, 'users/me');
    this.meCache = { user: u, ts: Date.now() };
    this.store.update((s) => {
      s.me = { id: u.id, username: u.username, name: u.name };
      s.followerSnapshots.push({ ts: Date.now(), followers: u.metrics.followers, following: u.metrics.following });
      if (s.followerSnapshots.length > 500) s.followerSnapshots = s.followerSnapshots.slice(-500);
    });
    return u;
  }

  /**
   * Relationship ledger: record that a person interacted with us (or we with them).
   * Called from inbox/account_pulse (mentions, replies), reply, and handoff reconcile.
   */
  touchPerson(u: { id: string; username: string; name?: string; metrics?: User['metrics']; connection?: string[] }, event: 'mention' | 'reply_to_me' | 'my_reply' | 'followed' | 'seen', postId?: string): Person {
    let out!: Person;
    this.store.update((s) => {
      const now = Date.now();
      const p: Person = s.people[u.id] ?? { id: u.id, username: u.username, first_seen: now, last_seen: now, mentions_of_me: 0, replies_to_me: 0, my_replies: 0, tags: [], notes: [] };
      p.username = u.username || p.username;
      if (u.name) p.name = u.name;
      if (u.metrics?.followers) {
        p.followers = u.metrics.followers;
        p.band = authorBand(u.metrics.followers).band;
      }
      if (u.connection) {
        p.follows_me = u.connection.includes('followed_by');
        p.followed_by_me = u.connection.includes('following');
        p.mutual = isMutual(u.connection);
      }
      if (event !== 'my_reply') p.last_seen = now;
      if (event === 'mention') p.mentions_of_me++;
      if (event === 'reply_to_me') p.replies_to_me++;
      if (event === 'my_reply') p.my_replies++;
      if (event === 'followed') {
        p.followed_by_me = true;
        p.mutual = Boolean(p.follows_me);
      }
      if (postId && event !== 'my_reply') p.last_post_id = postId;
      s.people[u.id] = p;
      out = p;
    });
    return out;
  }

  /** Engagement score for ranking people: inbound weighs more than outbound. */
  static personScore(p: Person): number {
    return p.replies_to_me * 3 + p.mentions_of_me * 2 + p.my_replies + (p.mutual ? 2 : 0);
  }

  /** Follower count without a network call (last snapshot). */
  get followers(): number | undefined {
    return this.store.s.followerSnapshots.at(-1)?.followers;
  }

  /** Record a priced operation (writes, or reads that are not per-resource deduplicated). Returns USD. */
  charge(toolName: string, op: Op, units = 1, note?: string): number {
    return this.ledger.record(toolName, op, units, note).usd;
  }

  /**
   * Record per-resource reads with X's 24h-UTC dedup mirrored locally: a resource
   * already paid for today is not charged again. Returns the number of new units.
   */
  chargeReads(toolName: string, op: Op, keys: string[], note?: string): { charged: number; usd: number } {
    const day = utcDayKey();
    let fresh = 0;
    this.store.update((s) => {
      for (const k of keys) {
        const ck = `${day}:${op}:${k}`;
        if (Object.hasOwn(s.readCache, ck)) continue;
        s.readCache[ck] = Date.now();
        fresh++;
      }
    });
    if (fresh) this.ledger.record(toolName, op, fresh, note);
    return { charged: fresh, usd: costOf(op, fresh) };
  }

  /** Budget gate for a planned spend. Throws when over budget; returns a warning near it. */
  affordable(usd: number, what: string): string | undefined {
    return this.ledger.assertAffordable(usd, what);
  }

  /** Throttle on ledger ops: returns a problem string when the rolling-window count is at the limit. */
  throttle(op: Op, max: number, windowMs: number, why: string): string | undefined {
    const n = this.ledger.countInWindow(op, windowMs);
    if (n < max) return undefined;
    const win = windowMs >= 86_400_000 ? `${windowMs / 86_400_000}d` : `${windowMs / 3_600_000}h`;
    return `Throttle: ${n} ${op} in the last ${win} (max ${max}). ${why}`;
  }

  /** Whether a write must go to the human queue: approval mode, or any `force` override (unless already approved). */
  needsApproval(force?: boolean): boolean {
    return !this.bypassApproval && (this.cfg.requireApproval || Boolean(force));
  }

  /** Approval mode: park the action for `x-mcp approve` and return the queue entry. */
  enqueue(toolName: WriteTool, args: Record<string, unknown>, preview: string): QueuedAction {
    const q: QueuedAction = { id: randomUUID().slice(0, 8), ts: Date.now(), tool: toolName, args, preview, status: 'pending' };
    this.store.update((s) => s.queue.push(q));
    return q;
  }

  /** Standard "queued for approval" result. */
  queued(toolName: WriteTool, args: Record<string, unknown>, preview: string, extra: Record<string, unknown> = {}): ToolResult {
    const q = this.enqueue(toolName, args, preview);
    return ok(`Queued for human approval as ${q.id} (approval mode). Run \`x-mcp approve ${q.id}\` to execute it.`, { executed: false, queued: q, ...extra });
  }
}
