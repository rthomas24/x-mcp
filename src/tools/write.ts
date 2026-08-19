/**
 * Write tools: publish (originals / self-threads / community / polls, with media),
 * reply (summoned-only, per X's self-serve rule), repost, delete_post, dm.
 * Every write passes the rules engine, the throttles, the budget, and — in
 * approval mode — the human queue, before a single request is sent.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { ID, USERNAME, intentReply, postUrl } from '../format.js';
import { PRICE, costOf, postOp } from '../pricing.js';
import { ALGO, analyzeDraft, findCopypasta, hoursSince, milestones, summonedBy } from '../rules.js';
import type { MyPost } from '../store.js';
import { XApiError } from '../x/client.js';
import { planMedia, uploadMedia, type MediaItem } from '../x/media.js';
import { Ctx, ok, tool } from './context.js';
import { addHandoff } from './handoff.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

function lastOriginalTs(ctx: Ctx): number | undefined {
  let last: number | undefined;
  for (const p of Object.values(ctx.store.s.posts)) if (p.kind === 'original' && (last === undefined || p.created_at > last)) last = p.created_at;
  return last;
}

async function uploadAll(ctx: Ctx, items: MediaItem[], altText: string | undefined, log: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const item of items) ids.push((await uploadMedia(ctx.client, item, { altText, onProgress: (m) => log.push(m) })).media_id);
  return ids;
}

export function registerWriteTools(server: McpServer, ctx: Ctx): void {
  // ---------------------------------------------------------------- publish
  tool(
    server,
    'publish',
    {
      title: 'Publish an original post (optionally a self-thread), with media',
      description: `Create an original post on the authenticated account. Runs the algorithm rules first (mentions ≤1, no engagement bait, spacing ≥${ctx.cfg.minHoursBetweenOriginals}h between originals, video strictly >${ALGO.MIN_VIDEO_SECONDS_EXCLUSIVE}s and video-only), uploads media via the v2 chunked endpoints (files must live under the allowed media roots: ${ctx.cfg.mediaRoots.join(', ')}), enforces the monthly budget ($${PRICE['post.create']}/post, $${PRICE['post.create_with_url']} if the text contains a URL), and records the post so post_performance/account_pulse can track it in algorithm terms (cold-start window, first-favorite → OON corpus, 48h shelf life).
Set dry_run=true to see the full plan without posting. Use \`thread\` for follow-up posts chained as replies to your own post (they do NOT get their own For You reach — one post per conversation ships — they are for readers who tap in). Quote posts are Enterprise-only on pay-per-use: use handoff(kind="quote") instead.`,
      inputSchema: z.object({
        text: z.string().describe('Post text. ≤280 weighted chars unless the account has long-post access. URLs count as 23.'),
        media_paths: z.array(z.string()).max(4).optional().describe('Absolute local paths under an allowed media root: up to 4 images, or exactly 1 video (mp4/mov/webm) or 1 gif. Do not mix video with images.'),
        alt_text: z.string().max(1000).optional().describe('Alt text applied to each uploaded image/video.'),
        thread: z.array(z.string()).max(24).optional().describe('Follow-up posts, each posted as a reply to the previous one (self-thread).'),
        community_id: ID.optional().describe('Post into an X Community you are a member of.'),
        share_with_followers: z.boolean().optional().describe('With community_id: also show to followers.'),
        poll: z.object({ options: z.array(z.string().min(1).max(25)).min(2).max(4), duration_minutes: z.number().int().min(5).max(10080) }).optional(),
        reply_settings: z.enum(['following', 'mentionedUsers', 'subscribers', 'verified']).optional().describe('Who can reply. Omit for everyone.'),
        made_with_ai: z.boolean().optional().describe('Disclose AI-generated media.'),
        long_post_limit: z.number().int().optional().describe('Character limit to validate against if the account has long posts (e.g. 25000). Default 280.'),
        force: z.boolean().optional().describe('Override soft rules (spacing, bait/mention warnings, ≤10s video). Never overrides media roots, the budget or hard API limits.'),
        dry_run: z.boolean().optional().describe('Analyse and price only; do not upload or post.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const me = await ctx.me();
      const analysis = analyzeDraft(args.text, { kind: 'original', myFollowers: ctx.followers, limit: args.long_post_limit });
      const threadAnalyses = (args.thread ?? []).map((t) => analyzeDraft(t, { kind: 'reply', limit: args.long_post_limit }));
      const problems: string[] = [];
      if (analysis.over_limit) problems.push(analysis.warnings.find((w) => w.includes('limit'))!);
      for (const [i, ta] of threadAnalyses.entries()) if (ta.over_limit) problems.push(`thread[${i}] is over the character limit (${ta.chars}).`);
      if (!args.force) {
        if (analysis.bait.length) problems.push(...analysis.warnings.filter((w) => w.startsWith('Engagement-bait')));
        if (analysis.mentions.length >= ALGO.MENTION_SPAM_TRIGGER) problems.push(...analysis.warnings.filter((w) => w.includes('mentions')));
      }
      const gapH = hoursSince(lastOriginalTs(ctx));
      if (!args.force && gapH < ctx.cfg.minHoursBetweenOriginals)
        problems.push(`Last original was ${gapH.toFixed(1)}h ago; minimum spacing is ${ctx.cfg.minHoursBetweenOriginals}h (author-diversity decay ×0.625 on the 2nd post in a slate; cold-start lifts only ONE post per request). Wait ${(ctx.cfg.minHoursBetweenOriginals - gapH).toFixed(1)}h or pass force=true.`);

      const media = await planMedia(args.media_paths ?? [], { roots: ctx.cfg.mediaRoots, ffprobePath: ctx.cfg.ffprobePath });
      problems.push(...media.problems);
      if (media.gate && !media.gate.ok && !args.force) problems.push(media.gate.reason);

      const ops = [analysis, ...threadAnalyses].map((a) => postOp(a.has_url));
      const cost = ops.reduce((s, op) => s + costOf(op), 0);
      const budgetWarn = ctx.affordable(cost, `publish (${ops.length} post${ops.length > 1 ? 's' : ''})`);
      const plan = {
        analysis,
        thread: threadAnalyses.map((a) => ({ chars: a.chars, has_url: a.has_url, mentions: a.mentions })),
        media: media.items.map((m) => ({ path: m.path, real: m.real, kind: m.kind, mb: Number((m.bytes / 1e6).toFixed(1)) })),
        video_seconds: media.video_seconds,
        video_gate: media.gate,
        hours_since_last_original: Number.isFinite(gapH) ? Number(gapH.toFixed(1)) : null,
        estimated_cost_usd: Number(cost.toFixed(3)),
        budget_warning: budgetWarn,
        problems,
      };
      if (problems.length) return ok(`Not posted — ${problems.length} problem(s):\n- ${problems.join('\n- ')}\n\nDraft score ${analysis.score}/100. ${analysis.suggestions.join(' ')}`, { posted: false, ...plan });
      if (args.dry_run) return ok(`Dry run OK. Score ${analysis.score}/100, cost $${cost.toFixed(3)}. Targets: ${analysis.targets.map((t) => `${t.head} (${t.weight})`).join(', ') || 'none detected'}. ${analysis.suggestions.join(' ')}`, { posted: false, ...plan });
      if (ctx.needsApproval(args.force)) {
        const preview = `POST: ${args.text.slice(0, 140)}${args.thread?.length ? ` (+${args.thread.length} thread)` : ''}${media.items.length ? ` [media: ${media.items.map((m) => m.real).join(', ')}]` : ''}${args.force ? ' [force]' : ''} ≈ $${cost.toFixed(3)}`;
        return ctx.queued('publish', args as Record<string, unknown>, preview, { posted: false, ...plan });
      }

      const log: string[] = [];
      const mediaIds = await uploadAll(ctx, media.items, args.alt_text, log);
      const body: Record<string, unknown> = { text: args.text };
      if (mediaIds.length) body.media = { media_ids: mediaIds };
      if (args.community_id) body.community_id = args.community_id;
      if (args.share_with_followers !== undefined) body.share_with_followers = args.share_with_followers;
      if (args.poll) body.poll = args.poll;
      if (args.reply_settings) body.reply_settings = args.reply_settings;
      if (args.made_with_ai) body.made_with_ai = true;
      const root = await ctx.client.createPost(body);
      ctx.charge('publish', ops[0]!, 1, root.id);
      const now = Date.now();
      const rootRec: MyPost = { id: root.id, text: args.text, created_at: now, kind: 'original', conversation_id: root.id, has_url: analysis.has_url, media_ids: mediaIds, video_seconds: media.video_seconds };
      ctx.store.update((s) => (s.posts[root.id] = rootRec));

      const children: { id: string; url: string }[] = [];
      let prev = root.id;
      for (const [i, t] of (args.thread ?? []).entries()) {
        try {
          const c = await ctx.client.createPost({ text: t, reply: { in_reply_to_tweet_id: prev } });
          ctx.charge('publish', ops[i + 1]!, 1, c.id);
          ctx.store.update((s) => (s.posts[c.id] = { id: c.id, text: t, created_at: Date.now(), kind: 'thread_child', conversation_id: root.id, in_reply_to: prev, has_url: threadAnalyses[i]!.has_url }));
          children.push({ id: c.id, url: postUrl(me.username, c.id) });
          prev = c.id;
        } catch (e) {
          children.push({ id: '', url: `FAILED: ${e instanceof XApiError ? e.message : String(e)}` });
          break;
        }
      }
      const url = postUrl(me.username, root.id);
      const ms = milestones(now, { likes: 0 }, ctx.followers);
      return ok(
        `Posted ${url}${children.length ? ` + ${children.filter((c) => c.id).length} thread posts` : ''}. Cost $${cost.toFixed(3)}.${budgetWarn ? ` ${budgetWarn}` : ''}\nAlgorithm: ${ms.notes.join(' ')}\nNext: get the first favorite quickly (opens the OON corpus), reply to every reply, no new original for ${ctx.cfg.minHoursBetweenOriginals}h.`,
        { posted: true, id: root.id, url, thread: children, media_ids: mediaIds, video_seconds: media.video_seconds, cost_usd: Number(cost.toFixed(3)), analysis, milestones: ms, upload_log: log },
      );
    },
  );

  // ------------------------------------------------------------------ reply
  tool(
    server,
    'reply',
    {
      title: 'Reply to a post that summoned you (mention / reply to you)',
      description: `Reply via the API. X's self-serve rule (since 2026-02-23): a programmatic reply is only accepted when the target post's author @mentioned you or replied to you — i.e. replies to your mentions and to replies on your own posts. Cold replies into strangers' threads are rejected by X; when that happens this tool files a handoff(kind="cold_reply") with a one-tap intent link instead. Enforces: one reply per interaction, copypasta similarity guard (COPYPASTA_SPAM), ≤${ctx.cfg.maxRepliesPerHour} replies/hour, budget ($${PRICE['post.create_summoned']} summoned reply; $${PRICE['post.create_with_url']} if it contains a URL). force=true skips the local checks but always routes through human approval (X_MCP_REQUIRE_APPROVAL or not). X's automation rules require prior approval for AI reply bots — keep X_MCP_REQUIRE_APPROVAL=true unless you have it.`,
      inputSchema: z.object({
        post_id: ID.describe('The post to reply to (must mention you or be a reply to you).'),
        text: z.string().describe('Reply text. Substance beats praise: a number, a correction, a real question.'),
        media_paths: z.array(z.string()).max(4).optional(),
        force: z.boolean().optional().describe('Skip the local summoned/duplicate/copypasta checks. Always requires human approval; the API may still reject.'),
        dry_run: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const me = await ctx.me();
      const problems: string[] = [];
      const analysis = analyzeDraft(args.text, { kind: 'reply' });
      if (analysis.over_limit) problems.push('Over the character limit.');
      if (analysis.bait.length && !args.force) problems.push(...analysis.warnings.filter((w) => w.startsWith('Engagement-bait')));
      const prior = Object.hasOwn(ctx.store.s.repliedConversations, args.post_id) ? ctx.store.s.repliedConversations[args.post_id] : undefined;
      if (prior && !args.force) problems.push(`Already replied to post ${args.post_id} (our reply ${prior.post_id}). X automation rules: one automated reply per user interaction.`);
      const th = ctx.throttle('post.create_summoned', ctx.cfg.maxRepliesPerHour, HOUR, 'Bursts look mechanical to the behavioural model.');
      if (th) problems.push(th);
      const cp = findCopypasta(args.text, ctx.store.s.replyTexts, ctx.cfg.copypastaSimilarity, ctx.cfg.copypastaLookbackDays * DAY);
      if (cp && !args.force) problems.push(`Too similar (${cp.similarity}) to a reply you already sent (post ${cp.post_id}): "${cp.text.slice(0, 80)}…". Duplicate replies get clustered as COPYPASTA_SPAM. Rewrite it.`);

      // Summoned check: the inbox already proved it, else one paid read.
      let conversationId: string | undefined;
      let summoned = Object.hasOwn(ctx.store.s.seenMentions, args.post_id);
      if (!summoned && !args.force) {
        const r = await ctx.client.postsByIds([args.post_id]);
        ctx.chargeReads('reply', 'read.post', [`p:${args.post_id}`], 'summon check');
        const target = r.posts[0];
        if (!target) problems.push(`Post ${args.post_id} not found (deleted, protected, or wrong id).`);
        else {
          conversationId = target.conversation_id;
          summoned = summonedBy(target, me).summoned;
          if (!summoned) {
            const h = addHandoff(ctx, { kind: 'cold_reply', target_post_id: args.post_id, target_username: r.users.get(target.author_id ?? '')?.username, text: args.text, why: 'cold reply — X rejects un-summoned API replies' });
            problems.push(`Post ${args.post_id} did not summon you (no @${me.username} mention, not a reply to you). X rejects programmatic cold replies on pay-per-use. Filed handoff ${h.id}; one-tap link for the human: ${intentReply(args.post_id, args.text)}`);
          }
        }
      }
      const media = await planMedia(args.media_paths ?? [], { roots: ctx.cfg.mediaRoots, ffprobePath: ctx.cfg.ffprobePath });
      problems.push(...media.problems);
      const op = postOp(analysis.has_url, true);
      const cost = costOf(op);
      const budgetWarn = ctx.affordable(cost, 'reply');
      if (problems.length) return ok(`Not sent — ${problems.length} problem(s):\n- ${problems.join('\n- ')}`, { sent: false, analysis, problems });
      if (args.dry_run) return ok(`Dry run OK. Reply score ${analysis.score}/100, cost $${cost.toFixed(3)}. ${analysis.suggestions.join(' ')}`, { sent: false, analysis, cost_usd: cost });
      if (ctx.needsApproval(args.force)) return ctx.queued('reply', args as Record<string, unknown>, `REPLY to ${args.post_id}: ${args.text.slice(0, 140)}${media.items.length ? ` [media: ${media.items.map((m) => m.real).join(', ')}]` : ''}${args.force ? ' [force]' : ''}`, { sent: false });

      const log: string[] = [];
      const mediaIds = await uploadAll(ctx, media.items, undefined, log);
      const body: Record<string, unknown> = { text: args.text, reply: { in_reply_to_tweet_id: args.post_id } };
      if (mediaIds.length) body.media = { media_ids: mediaIds };
      let created: { id: string };
      try {
        created = await ctx.client.createPost(body);
      } catch (e) {
        if (e instanceof XApiError && (e.status === 403 || e.status === 400)) {
          const h = addHandoff(ctx, { kind: 'cold_reply', target_post_id: args.post_id, text: args.text, why: `API rejected: ${e.message.slice(0, 80)}` });
          throw new Error(`${e.message}\nFiled handoff ${h.id} for the human: ${intentReply(args.post_id, args.text)}`);
        }
        throw e;
      }
      ctx.charge('reply', op, 1, `reply→${args.post_id}`);
      ctx.store.update((s) => {
        s.posts[created.id] = { id: created.id, text: args.text, created_at: Date.now(), kind: 'reply', in_reply_to: args.post_id, conversation_id: conversationId, has_url: analysis.has_url, media_ids: mediaIds };
        s.repliedConversations[args.post_id] = { post_id: created.id, ts: Date.now() };
        s.replyTexts.push({ text: args.text, ts: Date.now(), post_id: created.id });
        s.seenMentions[args.post_id] = Date.now();
      });
      const url = postUrl(me.username, created.id);
      return ok(`Replied: ${url} (cost $${cost.toFixed(3)}).${budgetWarn ? ` ${budgetWarn}` : ''}`, { sent: true, id: created.id, url, cost_usd: cost, upload_log: log });
    },
  );

  // ----------------------------------------------------------------- repost
  tool(
    server,
    'repost',
    {
      title: 'Repost (retweet) a post',
      description: `Repost another post to your followers. Allowed on pay-per-use for informational sharing (no bulk). Reposts never travel out-of-network in For You and are ×0.75 in-network — use sparingly, mainly to amplify people who engaged with you. Throttled to ${ctx.cfg.maxRepostsPerDay}/day. Cost $${PRICE.repost}.`,
      inputSchema: z.object({ post_id: ID, why: z.string().optional().describe('One line on why (kept in the ledger note).') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const me = await ctx.me();
      const th = ctx.throttle('repost', ctx.cfg.maxRepostsPerDay, DAY, 'Bulk reposting is against the automation rules and looks mechanical.');
      if (th) throw new Error(th);
      const warn = ctx.affordable(costOf('repost'), 'repost');
      if (ctx.needsApproval()) return ctx.queued('repost', args as Record<string, unknown>, `REPOST ${args.post_id}${args.why ? ` — ${args.why}` : ''}`);
      const done = await ctx.client.repost(me.id, args.post_id);
      ctx.charge('repost', 'repost', 1, args.why ?? args.post_id);
      return ok(`${done ? 'Reposted' : 'Repost returned false for'} ${args.post_id}.${warn ? ` ${warn}` : ''}`, { done });
    },
  );

  // ------------------------------------------------------------ delete_post
  tool(
    server,
    'delete_post',
    {
      title: 'Delete one of your posts',
      description: `Delete a post you authored (only posts this server knows as yours, unless force=true). Irreversible; in approval mode it is queued for the human. Cost $${PRICE['post.delete']}. Deleting any version of an edited post deletes the whole edit chain.`,
      inputSchema: z.object({ post_id: ID, confirm: z.literal(true).describe('Must be true — deletion is irreversible.'), force: z.boolean().optional().describe('Allow deleting a post id not recorded by this server. Always requires human approval.') }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const known = Object.hasOwn(ctx.store.s.posts, args.post_id);
      if (!known && !args.force) throw new Error(`Post ${args.post_id} is not one this server posted or observed as yours. Pass force=true (requires human approval) if it really is yours.`);
      if (ctx.needsApproval(args.force)) return ctx.queued('delete_post', args as Record<string, unknown>, `DELETE ${args.post_id}${known ? `: ${ctx.store.s.posts[args.post_id]!.text.slice(0, 100)}` : ' (unknown to this server)'}`);
      const deleted = await ctx.client.deletePost(args.post_id);
      ctx.charge('delete_post', 'post.delete', 1, args.post_id);
      ctx.store.update((s) => {
        delete s.posts[args.post_id];
      });
      return ok(deleted ? `Deleted ${args.post_id}.` : `X returned deleted=false for ${args.post_id}.`, { deleted });
    },
  );

  // --------------------------------------------------------------------- dm
  tool(
    server,
    'dm',
    {
      title: 'Send a direct message (opt-in only)',
      description: `Send a DM. X automation rules forbid unsolicited/bulk automated DMs: this tool only sends when the recipient has DM'd you first (checked via your DM events, $${PRICE['read.dm_event']}/event read). force=true bypasses that check but always routes through human approval. Cost $${PRICE['dm.send']}. Throttled to ${ctx.cfg.maxDmsPerHour}/hour.`,
      inputSchema: z.object({
        user_id: ID.optional(),
        username: USERNAME.optional(),
        text: z.string().min(1),
        force: z.boolean().optional().describe('Bypass the inbound-DM check (only when the person explicitly asked you to DM them elsewhere). Requires human approval.'),
        reason: z.string().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      if (!args.user_id && !args.username) throw new Error('Provide user_id or username.');
      let uid = args.user_id;
      if (!uid) {
        const u = await ctx.client.userByUsername(args.username!);
        ctx.chargeReads('dm', 'read.user', [`u:${u.id}`]);
        uid = u.id;
      }
      const th = ctx.throttle('dm.send', ctx.cfg.maxDmsPerHour, HOUR, 'Bulk DMs are against the automation rules.');
      if (th) throw new Error(th);
      if (!args.force) {
        const events = await ctx.client.dmEventsWith(uid, 20);
        ctx.charge('dm', 'read.dm_event', events.length, 'inbound check');
        if (!events.some((e) => String(e.sender_id) === uid)) throw new Error(`No inbound DM from ${uid} found — X's automation rules only allow automated DMs after the recipient messaged you or explicitly asked. Pass force=true (requires human approval) if they asked elsewhere.`);
      }
      const warn = ctx.affordable(costOf('dm.send'), 'dm');
      if (ctx.needsApproval(args.force)) return ctx.queued('dm', { ...args, user_id: uid } as Record<string, unknown>, `DM ${uid}: ${args.text.slice(0, 100)}${args.force ? ' [force]' : ''}`);
      const r = await ctx.client.sendDm(uid, args.text);
      ctx.charge('dm', 'dm.send', 1, args.reason ?? uid);
      return ok(`DM sent (event ${r.dm_event_id}).${warn ? ` ${warn}` : ''}`, { sent: true, ...r });
    },
  );
}
