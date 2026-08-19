/**
 * Meta tools: draft_check (free rules engine), spend (ledger), doctor (health),
 * approvals (list/reject queued API actions; approving is CLI-only on purpose).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { BOUNDARY } from '../playbook.js';
import { PRICE } from '../pricing.js';
import { ALGO, WEIGHTS, analyzeDraft, diversityMultiplier, type DraftAnalysis } from '../rules.js';
import { SCOPES } from '../x/auth.js';
import { Ctx, ok, tool } from './context.js';

function describeAnalysis(a: DraftAnalysis, label: string): string {
  const head = `${label}: score ${a.score}/100 · ${a.chars}/${a.limit} chars · ${a.mentions.length} mention(s) · ${a.has_url ? `URL ($${PRICE['post.create_with_url']})` : `no URL ($${PRICE['post.create']})`}${a.is_question ? ' · ends on a question' : ''}${a.has_numbers ? ' · has receipts' : ''}`;
  const targets = `  targets: ${a.targets.map((t) => `${t.head} (${t.weight}) — ${t.why}`).join('; ') || 'none detected'}`;
  return [head, targets, ...a.warnings.map((w) => `  ⚠ ${w}`), ...a.suggestions.map((s) => `  → ${s}`)].join('\n');
}

export function registerMetaTools(server: McpServer, ctx: Ctx): void {
  tool(
    server,
    'draft_check',
    {
      title: 'Score a draft against the For You rules (free, no API call)',
      description: `Run the algorithm rules engine on a draft: weighted length (URLs=23), @-mention count vs the ${ALGO.MENTION_SPAM_TRIGGER}-mention spam trigger, URL cost ($${PRICE['post.create_with_url']} vs $${PRICE['post.create']}), engagement-bait patterns (SPAM_HIGH_RECALL, no exemption), hashtag abuse, which ranking heads the text plausibly targets (copy-link ${WEIGHTS.share_via_copy_link} / reply ${WEIGHTS.reply}→${WEIGHTS.reply_from_mutual_follow} / quote ${WEIGHTS.quote} / follow ${WEIGHTS.follow_author} / like ${WEIGHTS.favorite}), and concrete suggestions. Iterate until score ≥ 80 with no warnings, then publish. Costs nothing.`,
      inputSchema: z.object({
        text: z.string(),
        kind: z.enum(['original', 'reply', 'quote']).optional(),
        limit: z.number().int().optional().describe('Character limit (default 280).'),
        variants: z.array(z.string()).max(8).optional().describe('Alternative drafts to score side by side.'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const opts = { kind: args.kind ?? 'original', limit: args.limit, myFollowers: ctx.followers } as const;
      const main = analyzeDraft(args.text, opts);
      const variants = (args.variants ?? []).map((v) => ({ text: v, ...analyzeDraft(v, opts) }));
      return ok([describeAnalysis(main, 'Draft'), ...variants.map((v, i) => describeAnalysis(v, `Variant ${i + 1}`))].join('\n\n'), { draft: main, variants });
    },
  );

  tool(
    server,
    'spend',
    {
      title: 'Cost ledger: month-to-date spend, by operation and by tool',
      description: 'What the account has spent on the X API this billing month according to the local ledger (mirrors X pay-per-use prices, with 24h-UTC read dedup), the remaining budget, the last 24h, and the price table. X does not expose a balance API; reconcile against console.x.com occasionally.',
      inputSchema: z.object({ recent: z.number().int().min(0).max(100).optional().describe('Also list the last N ledger entries.') }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const s = ctx.ledger.summary();
      const recent = args.recent ? ctx.store.s.ledger.slice(-args.recent).reverse() : [];
      const byOp = Object.entries(s.by_op)
        .sort((a, b) => b[1].usd - a[1].usd)
        .map(([op, v]) => `  ${op}: ${v.units} × → $${v.usd}`)
        .join('\n');
      const recentText = recent.length ? `\nRecent:\n${recent.map((e) => `  ${new Date(e.ts).toISOString().slice(5, 16)} ${e.tool}/${e.op} ×${e.units} $${e.usd.toFixed(3)}${e.note ? ` — ${e.note.slice(0, 50)}` : ''}`).join('\n')}` : '';
      return ok(`Month from ${s.month_start_iso.slice(0, 10)}: $${s.spent_usd} of $${s.budget_usd} (${s.pct_used}%), remaining $${s.remaining_usd}. Last 24h: $${s.last_24h_usd}. ${s.entries} entries.\nBy op:\n${byOp || '  (nothing yet)'}${recentText}`, { summary: s, recent, prices: PRICE });
    },
  );

  tool(
    server,
    'doctor',
    {
      title: 'Health check: auth, scopes, config, rate limits, API boundary',
      description: 'Shows the stored OAuth token state, identity, granted scopes, effective config (secrets redacted), the rate-limit snapshot from this process, and the pay-per-use API boundary the tools enforce (what is API-doable vs human-handoff). Run when something fails.',
      inputSchema: z.object({ verify_network: z.boolean().optional().describe('Call users/me to verify the token works (costs $0.01).') }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const t = ctx.store.loadTokens();
      const loggedIn = Boolean(t?.access_token);
      const granted = t?.scope?.split(' ') ?? [];
      const missing = loggedIn ? SCOPES.filter((s) => !granted.includes(s)) : [];
      const expiresInMin = t ? Math.round((t.expires_at - Date.now()) / 60_000) : undefined;
      const hasRefresh = Boolean(t?.refresh_token);
      const identity = args.verify_network && loggedIn ? await ctx.me(true) : ctx.store.s.me;
      const cfg = ctx.cfg;
      const config = {
        client_id: cfg.clientId ? `${cfg.clientId.slice(0, 6)}…` : '(unset)',
        client_secret: cfg.clientSecret ? 'set' : 'unset (public client / PKCE only)',
        redirect_uri: cfg.redirectUri,
        state_dir: cfg.stateDir,
        media_roots: cfg.mediaRoots,
        api_base: cfg.apiBase,
        monthly_budget_usd: cfg.monthlyBudgetUsd,
        require_approval: cfg.requireApproval,
        min_hours_between_originals: cfg.minHoursBetweenOriginals,
        max_replies_per_hour: cfg.maxRepliesPerHour,
        max_reposts_per_day: cfg.maxRepostsPerDay,
        max_dms_per_hour: cfg.maxDmsPerHour,
        copypasta_similarity: cfg.copypastaSimilarity,
        max_reads_per_call: cfg.maxReadsPerCall,
        ffprobe: cfg.ffprobePath ?? 'auto (falls back to MP4 header parse)',
      };
      const text = [
        `Auth: ${loggedIn ? `OK, expires in ${expiresInMin} min, refresh ${hasRefresh ? 'yes' : 'NO'}` : 'not logged in — run `x-mcp login`'}${missing.length ? `; missing scopes: ${missing.join(' ')}` : ''}`,
        `Identity: ${identity ? `@${identity.username}` : 'unknown (run account_pulse)'}`,
        `Budget: $${cfg.monthlyBudgetUsd}/mo, approval mode ${cfg.requireApproval ? 'ON' : 'off'}, media roots: ${cfg.mediaRoots.join(', ')}.`,
        `API boundary (pay-per-use): human handoff needed for ${BOUNDARY.human_handoff.length} action types — see structured output.`,
      ].join('\n');
      return ok(text, {
        auth: { logged_in: loggedIn, expires_in_min: expiresInMin, has_refresh: hasRefresh, scopes: granted, missing_scopes: missing },
        identity,
        config,
        rate_limits: ctx.client.rateSnapshot,
        boundary: BOUNDARY,
        algorithm: { weights: WEIGHTS, constants: ALGO, diversity_multipliers: [0, 1, 2, 3].map(diversityMultiplier) },
      });
    },
  );

  tool(
    server,
    'approvals',
    {
      title: 'Approval queue: list or reject queued API actions',
      description: 'Writes park here when approval mode is on (the default) or when `force` was used. The agent can list and reject; approving (executing) is deliberately CLI-only: `x-mcp approve <id>` or `x-mcp approve --all`, so a human confirms every outbound action.',
      inputSchema: z.object({ action: z.enum(['list', 'reject']), id: z.string().optional(), include_done: z.boolean().optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      if (args.action === 'reject') {
        if (!ctx.store.s.queue.some((x) => x.id === args.id)) throw new Error(`No queued action ${args.id}.`);
        ctx.store.update((s) => {
          const q = s.queue.find((x) => x.id === args.id);
          if (q) q.status = 'rejected';
        });
        return ok(`Rejected ${args.id}.`, { item: ctx.store.s.queue.find((x) => x.id === args.id) });
      }
      const items = ctx.store.s.queue.filter((q) => args.include_done || q.status === 'pending');
      return ok(items.length ? items.map((q) => `• [${q.id}] ${q.status} ${q.tool}: ${q.preview}`).join('\n') : 'Approval queue is empty.', { items });
    },
  );
}
