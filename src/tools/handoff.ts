/**
 * The human handoff queue — the part of running an account the API cannot do
 * on pay-per-use (quote posts, follows, likes, cold replies) turned into
 * one-tap X intent links, plus auto-reconciliation from cheap owned reads so
 * the agent learns what the human actually did without being told.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { ID, USERNAME, describeHandoff, intentFor } from '../format.js';
import { analyzeDraft, jaccard, shingles } from '../rules.js';
import type { HandoffItem } from '../store.js';
import { Ctx, ok, tool } from './context.js';

/** Create (or return the existing pending duplicate of) a handoff item. Shared with `reply`. */
export function addHandoff(ctx: Ctx, input: Omit<HandoffItem, 'id' | 'ts' | 'status'>): HandoffItem & { duplicate?: boolean } {
  const username = input.target_username?.replace(/^@/, '');
  const dup = ctx.store.s.handoff.find((h) => h.status === 'pending' && h.kind === input.kind && h.target_post_id === input.target_post_id && h.target_username === username);
  if (dup) return { ...dup, duplicate: true };
  const item: HandoffItem = { id: randomUUID().slice(0, 6), ts: Date.now(), status: 'pending', ...input, target_username: username };
  ctx.store.update((s) => s.handoff.push(item));
  return item;
}

export function registerHandoffTools(server: McpServer, ctx: Ctx): void {
  tool(
    server,
    'handoff',
    {
      title: 'Human handoff queue: quote / follow / like / cold reply as one-tap links',
      description: `Manage the queue of actions only a human can do on a pay-per-use account (X removed follows, likes and quote-posts from self-serve on 2026-04-20 and rejects un-summoned replies since 2026-02-23).
- add: create an item with drafted text (checked by the rules engine) → returns an x.com/intent link the human taps; the text is pre-filled.
- list: pending items with links, oldest first.
- done / drop: mark manually.
- reconcile: detect completion automatically from owned reads ($0.001/item): a quote/cold_reply/manual_post is done when a matching post appears in your timeline; a follow when the account appears in your following list; a like when the post appears in your liked posts.
Why this matters algorithmically: quote posts are *originals* to the ranker (cold-start eligible, OON-retrievable, sit in the Quotes tab of a viral thread) and follows create mutuals (+15 reply weight). The agent drafts; the human taps.`,
      inputSchema: z.object({
        action: z.enum(['add', 'list', 'done', 'drop', 'reconcile']),
        kind: z.enum(['quote', 'cold_reply', 'follow', 'like', 'manual_post']).optional(),
        target_post_id: ID.optional(),
        target_username: USERNAME.optional().describe('Author handle (improves quote/cold_reply links; required for follow).'),
        text: z.string().optional().describe('Drafted post/reply text for quote, cold_reply, manual_post.'),
        why: z.string().optional().describe('One line the human sees explaining the value.'),
        id: z.string().optional().describe('Item id for done/drop.'),
        include_done: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const s = ctx.store.s;
      if (args.action === 'add') {
        if (!args.kind) throw new Error('kind is required for add.');
        if ((args.kind === 'quote' || args.kind === 'cold_reply' || args.kind === 'like') && !args.target_post_id) throw new Error(`${args.kind} needs target_post_id.`);
        if (args.kind === 'follow' && !args.target_username) throw new Error('follow needs target_username.');
        if ((args.kind === 'quote' || args.kind === 'cold_reply' || args.kind === 'manual_post') && !args.text) throw new Error(`${args.kind} needs text.`);
        const analysis = args.text ? analyzeDraft(args.text, { kind: args.kind === 'cold_reply' ? 'reply' : args.kind === 'quote' ? 'quote' : 'original' }) : undefined;
        if (analysis?.over_limit) throw new Error(`Draft is over the character limit (${analysis.chars}).`);
        const item = addHandoff(ctx, { kind: args.kind, target_post_id: args.target_post_id, target_username: args.target_username, text: args.text, why: args.why });
        const link = intentFor(item);
        if (item.duplicate) return ok(`Already queued as ${item.id}: ${link}`, { item, link, duplicate: true });
        const warn = analysis?.warnings.length ? `\nDraft warnings: ${analysis.warnings.join(' | ')}` : '';
        return ok(`Queued ${item.kind} as ${item.id}. Human link: ${link}${warn}`, { item, link, analysis });
      }
      if (args.action === 'done' || args.action === 'drop') {
        if (!args.id) throw new Error('id is required.');
        if (!s.handoff.some((h) => h.id === args.id)) throw new Error(`No handoff item ${args.id}.`);
        let item: HandoffItem | undefined;
        ctx.store.update((st) => {
          item = st.handoff.find((h) => h.id === args.id);
          if (item) {
            item.status = args.action === 'done' ? 'done' : 'dropped';
            item.resolved_ts = Date.now();
          }
        });
        return ok(`${args.id} marked ${item?.status}.`, { item });
      }
      if (args.action === 'reconcile') {
        const me = await ctx.me();
        const pending = s.handoff.filter((h) => h.status === 'pending');
        if (!pending.length) return ok('Nothing pending.', { resolved: [], pending: 0 });
        const resolved: HandoffItem[] = [];
        const resolve = (id: string, postId?: string) =>
          ctx.store.update((st) => {
            const h = st.handoff.find((x) => x.id === id);
            if (!h) return;
            h.status = 'done';
            h.resolved_ts = Date.now();
            if (postId) h.resolved_post_id = postId;
            if (h.kind === 'cold_reply' && h.target_post_id && postId) st.repliedConversations[h.target_post_id] = { post_id: postId, ts: Date.now() };
            resolved.push(h);
          });
        const wantPosts = pending.some((h) => h.kind === 'quote' || h.kind === 'cold_reply' || h.kind === 'manual_post');
        const wantFollows = pending.some((h) => h.kind === 'follow');
        const wantLikes = pending.some((h) => h.kind === 'like');
        // The three owned reads are independent — run them together.
        const [posts, following, liked] = await Promise.all([
          wantPosts ? ctx.client.myPosts(me.id, { max: 50 }) : undefined,
          wantFollows ? ctx.client.following(me.id) : undefined,
          wantLikes ? ctx.client.likedPostIds(me.id) : undefined,
        ]);
        let cost = 0;
        if (posts) {
          cost += ctx.chargeReads('handoff', 'read.owned', posts.posts.map((p) => `p:${p.id}`), 'reconcile posts').usd;
          for (const h of pending) {
            if (!(h.kind === 'quote' || h.kind === 'cold_reply' || h.kind === 'manual_post')) continue;
            const mine = shingles(h.text ?? '');
            const hit = posts.posts.find((p) => {
              if (h.kind === 'quote' && p.referenced.some((x) => x.type === 'quoted' && x.id === h.target_post_id)) return true;
              if (h.kind === 'cold_reply' && p.referenced.some((x) => x.type === 'replied_to' && x.id === h.target_post_id)) return true;
              return h.text ? jaccard(mine, shingles(p.text)) >= 0.6 : false;
            });
            if (hit) resolve(h.id, hit.id);
          }
        }
        if (following) {
          cost += ctx.chargeReads('handoff', 'read.owned', following.map((u) => `f:${u.id}`), 'reconcile following').usd;
          const byName = new Map(following.map((u) => [u.username.toLowerCase(), u]));
          for (const h of pending) {
            if (h.kind !== 'follow' || !h.target_username) continue;
            const u = byName.get(h.target_username.toLowerCase());
            if (u) {
              ctx.store.update((st) => st.follows.push({ user_id: u.id, username: u.username, ts: Date.now(), action: 'follow' }));
              resolve(h.id);
            }
          }
        }
        if (liked) {
          cost += ctx.chargeReads('handoff', 'read.likes', liked.map((i) => `l:${i}`), 'reconcile likes').usd;
          const ids = new Set(liked);
          for (const h of pending) if (h.kind === 'like' && h.target_post_id && ids.has(h.target_post_id)) resolve(h.id);
        }
        const still = ctx.store.s.handoff.filter((h) => h.status === 'pending').length;
        return ok(`Reconciled: ${resolved.length} done, ${still} still pending. Cost ≈ $${cost.toFixed(3)}.`, { resolved, pending: still, cost_usd: cost });
      }
      // list
      const items = s.handoff.filter((h) => args.include_done || h.status === 'pending').sort((a, b) => a.ts - b.ts);
      return ok(items.length ? items.map((h) => describeHandoff(h)).join('\n') : 'Handoff queue is empty.', { items: items.map((h) => ({ ...h, link: intentFor(h) })) });
    },
  );
}
