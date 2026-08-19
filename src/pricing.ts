/**
 * X API pay-per-use price table (USD) and the cost ledger.
 * Source: https://docs.x.com/x-api/getting-started/pricing (read 2026-08-19).
 * Every tool records what it spent; the ledger enforces the monthly budget.
 * This is the ONLY place prices live — tools use `PRICE`, `costOf` and `postOp`.
 */
import type { LedgerEntry, Store } from './store.js';

export const PRICE = {
  // writes (per request)
  'post.create': 0.015,
  'post.create_with_url': 0.2,
  'post.create_summoned': 0.01, // reply to a post whose author mentioned/replied to you
  'post.delete': 0.01,
  'repost': 0.015,
  'dm.send': 0.015,
  // reads (per resource)
  'read.post': 0.005,
  'read.owned': 0.001, // your own posts / metrics / mentions / following in user context
  'read.user': 0.01,
  'read.likes': 0.001,
  'read.dm_event': 0.01,
} as const;

export type Op = keyof typeof PRICE;

export function costOf(op: Op, units = 1): number {
  return Number((PRICE[op] * units).toFixed(6));
}

/** Which post-creation price applies to a text. */
export function postOp(hasUrl: boolean, summoned = false): Op {
  if (hasUrl) return 'post.create_with_url';
  return summoned ? 'post.create_summoned' : 'post.create';
}

export function monthStart(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Reads of the same resource inside a 24h UTC window are deduplicated by X. Mirror that locally. */
export function utcDayKey(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export interface SpendSummary {
  month_start_iso: string;
  spent_usd: number;
  budget_usd: number;
  remaining_usd: number;
  pct_used: number;
  by_op: Record<string, { units: number; usd: number }>;
  by_tool: Record<string, number>;
  last_24h_usd: number;
  entries: number;
}

export class Ledger {
  constructor(
    private readonly store: Store,
    readonly budgetUsd: number,
    private readonly warnAt: number,
  ) {}

  /** Walk the append-ordered ledger from the end; stop at the first entry before `since`. */
  private *since(since: number): Generator<LedgerEntry> {
    const l = this.store.s.ledger;
    for (let i = l.length - 1; i >= 0; i--) {
      const e = l[i]!;
      if (e.ts < since) break;
      yield e;
    }
  }

  spentThisMonth(): number {
    let sum = 0;
    for (const e of this.since(monthStart())) sum += e.usd;
    return sum;
  }

  /** Count ledger entries for an op inside a rolling window (used by throttles). */
  countInWindow(op: Op, windowMs: number): number {
    let n = 0;
    for (const e of this.since(Date.now() - windowMs)) if (e.op === op) n += e.units || 1;
    return n;
  }

  /** Throws if this spend would exceed the monthly budget. Returns a warning string near the limit. */
  assertAffordable(usd: number, what: string): string | undefined {
    const spent = this.spentThisMonth();
    if (spent + usd > this.budgetUsd) {
      throw new Error(
        `Budget stop: ${what} would cost $${usd.toFixed(3)} but only $${(this.budgetUsd - spent).toFixed(3)} of the $${this.budgetUsd} monthly budget remains. Raise X_MCP_MONTHLY_BUDGET_USD or wait for the next month.`,
      );
    }
    if (spent + usd > this.budgetUsd * this.warnAt) return `Budget warning: $${(spent + usd).toFixed(2)} of $${this.budgetUsd} used this month.`;
    return undefined;
  }

  record(tool: string, op: Op, units = 1, note?: string): LedgerEntry {
    const entry: LedgerEntry = { ts: Date.now(), tool, op, units, usd: costOf(op, units), note };
    this.store.update((s) => s.ledger.push(entry));
    return entry;
  }

  summary(): SpendSummary {
    const start = monthStart();
    const dayAgo = Date.now() - 86_400_000;
    const by_op: Record<string, { units: number; usd: number }> = {};
    const by_tool: Record<string, number> = {};
    let spent = 0;
    let last24 = 0;
    let n = 0;
    for (const e of this.since(start)) {
      n++;
      spent += e.usd;
      if (e.ts >= dayAgo) last24 += e.usd;
      const o = (by_op[e.op] ??= { units: 0, usd: 0 });
      o.units += e.units;
      o.usd += e.usd;
      by_tool[e.tool] = (by_tool[e.tool] ?? 0) + e.usd;
    }
    const round = (v: number) => Number(v.toFixed(4));
    for (const k of Object.keys(by_op)) by_op[k]!.usd = round(by_op[k]!.usd);
    for (const k of Object.keys(by_tool)) by_tool[k] = round(by_tool[k]!);
    return {
      month_start_iso: new Date(start).toISOString(),
      spent_usd: round(spent),
      budget_usd: this.budgetUsd,
      remaining_usd: round(Math.max(0, this.budgetUsd - spent)),
      pct_used: Number(((spent / this.budgetUsd) * 100).toFixed(1)),
      by_op,
      by_tool,
      last_24h_usd: round(last24),
      entries: n,
    };
  }
}
