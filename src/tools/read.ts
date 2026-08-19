/**
 * Read tools. Owned reads ($0.001) wherever possible; public reads ($0.005) are
 * capped per call and deduplicated per UTC day like X bills them.
 * Post text / bios come from third parties: every output says so.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { ID, UNTRUSTED_NOTE, USERNAME, intentReply, oneLine, postUrl } from '../format.js';
import { PRICE, costOf } from '../pricing.js';
import { ALGO, authorBand, hoursSince, isMutual, milestones, summonedBy, type AuthorBand, type Milestones } from '../rules.js';
import type { MetricSnapshot } from '../store.js';
import type { Post, User } from '../x/client.js';
import { Ctx, ok, tool } from './context.js';

const createdMs = (p: Post): number => Date.parse(p.created_at ?? '') || Date.now();

function snapshotFrom(p: Post): MetricSnapshot {
  return {
    ts: Date.now(),
    impressions: p.non_public?.impression_count ?? p.metrics.impressions,
    likes: p.metrics.likes,
    replies: p.metrics.replies,
    reposts: p.metrics.reposts,
    quotes: p.metrics.quotes,
    bookmarks: p.metrics.bookmarks,
    url_clicks: p.non_public?.url_link_clicks,
    profile_clicks: p.non_public?.user_profile_clicks,
  };
}

function velocity(snaps: MetricSnapshot[]): { likes_per_hour: number; impressions_per_hour?: number; window_hours: number } | undefined {
  if (snaps.length < 2) return undefined;
  const a = snaps[0]!;
  const b = snaps[snaps.length - 1]!;
  const h = (b.ts - a.ts) / 3_600_000;
  if (h < 0.05) return undefined;
  return {
    likes_per_hour: Number(((b.likes - a.likes) / h).toFixed(2)),
    impressions_per_hour: a.impressions !== undefined && b.impressions !== undefined ? Number(((b.impressions - a.impressions) / h).toFixed(1)) : undefined,
    window_hours: Number(h.toFixed(2)),
  };
}

export interface PostView {
  id: string;
  url: string;
  author?: { username: string; followers: number; band: AuthorBand; connection?: string[] };
  age_hours: number;
  text: string;
  metrics: Post['metrics'];
  is_reply: boolean;
  is_quote: boolean;
  conversation_id?: string;
}

function describePost(p: Post, users: Map<string, User>): PostView {
  const u = p.author_id ? users.get(p.author_id) : undefined;
  return {
    id: p.id,
    url: u ? postUrl(u.username, p.id) : p.url,
    author: u ? { username: u.username, followers: u.metrics.followers, band: authorBand(u.metrics.followers).band, connection: u.connection } : undefined,
    age_hours: Number(hoursSince(createdMs(p)).toFixed(1)),
    text: p.text,
    metrics: p.metrics,
    is_reply: p.referenced.some((r) => r.type === 'replied_to'),
    is_quote: p.referenced.some((r) => r.type === 'quoted'),
    conversation_id: p.conversation_id,
  };
}

const who = (v: PostView): string => v.author?.username ?? '?';

export interface MyPostRow {
  id: string;
  url: string;
  text: string;
  kind?: string;
  metrics: MetricSnapshot;
  velocity: ReturnType<typeof velocity>;
  milestones: Milestones;
}

/** Record a fresh snapshot for one of my posts (upserting the MyPost record) and describe it in algorithm terms. */
function refreshMyPost(ctx: Ctx, p: Post, me: User): MyPostRow {
  const snap = snapshotFrom(p);
  const created = createdMs(p);
  ctx.store.update((s) => {
    (s.metrics[p.id] ??= []).push(snap);
    if (!s.posts[p.id]) {
      const v = describePost(p, new Map());
      s.posts[p.id] = {
        id: p.id,
        text: p.text,
        created_at: created,
        kind: v.is_reply ? (p.in_reply_to_user_id === me.id ? 'thread_child' : 'reply') : v.is_quote ? 'quote' : 'original',
        conversation_id: p.conversation_id,
        has_url: Boolean(p.entities?.urls?.length),
      };
    }
  });
  return {
    id: p.id,
    url: postUrl(me.username, p.id),
    text: p.text.slice(0, 140),
    kind: ctx.store.s.posts[p.id]?.kind,
    metrics: snap,
    velocity: velocity(ctx.store.s.metrics[p.id] ?? []),
    milestones: milestones(created, { likes: p.metrics.likes, impressions: snap.impressions }, me.metrics.followers),
  };
}

const rowLine = (r: MyPostRow): string => `  • ${oneLine(r.text, 60)} — ${r.metrics.likes}♥ ${r.metrics.replies}↩ ${r.metrics.impressions ?? '?'}👁 (${r.milestones.age_hours}h)${r.velocity ? ` ${r.velocity.likes_per_hour}♥/h` : ''} ${r.milestones.notes[0] ?? ''}`;

export function registerReadTools(server: McpServer, ctx: Ctx): void {
  // ---------------------------------------------------------- account_pulse
  tool(
    server,
    'account_pulse',
    {
      title: 'Account pulse — one call: what moved, who to answer, what it cost',
      description: `The morning-briefing tool. Refreshes your identity + follower delta, pulls your recent posts with metrics (owned reads, $${PRICE['read.owned']} each) and computes per-post velocity and algorithm milestones (first favorite → out-of-network corpus, <1000 views → cold-start still live, 24h/48h windows), lists new mentions/replies you have not answered (API-replyable because they summoned you), shows the human handoff queue and pending approvals, and the month-to-date spend. Call this first in every session. ${UNTRUSTED_NOTE}`,
      inputSchema: z.object({
        posts: z.number().int().min(5).max(50).optional().describe('How many of your recent posts to refresh (default 15).'),
        mentions: z.number().int().min(5).max(50).optional().describe('How many recent mentions to scan (default 20).'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const me = await ctx.me(true);
      const snaps = ctx.store.s.followerSnapshots;
      const prev = snaps.length >= 2 ? snaps[snaps.length - 2] : undefined;
      const followerDelta = prev ? me.metrics.followers - prev.followers : 0;

      const [mine, men] = await Promise.all([ctx.client.myPosts(me.id, { max: args.posts ?? 15 }), ctx.client.mentions(me.id, { max: args.mentions ?? 20, since_id: ctx.store.s.lastMentionId })]);
      const c1 = ctx.chargeReads('account_pulse', 'read.owned', mine.posts.map((p) => `p:${p.id}`), 'my posts');
      const c2 = ctx.chargeReads('account_pulse', 'read.owned', men.posts.map((p) => `m:${p.id}`), 'mentions');
      const rows = mine.posts.map((p) => refreshMyPost(ctx, p, me));
      const inbox = men.posts.filter((p) => !Object.hasOwn(ctx.store.s.repliedConversations, p.id) && p.author_id !== me.id).map((p) => describePost(p, men.users));
      const pendingHandoff = ctx.store.s.handoff.filter((q) => q.status === 'pending').length;
      const pendingApprovals = ctx.store.s.queue.filter((q) => q.status === 'pending').length;
      const spend = ctx.ledger.summary();
      const text = [
        `@${me.username}: ${me.metrics.followers} followers (${followerDelta >= 0 ? '+' : ''}${followerDelta} since last pulse), following ${me.metrics.following}.`,
        `${rows.length} recent posts refreshed; ${inbox.length} unanswered mention(s)/reply(ies).`,
        ...rows.slice(0, 8).map(rowLine),
        inbox.length ? `Inbox (answer with the reply tool):\n${inbox.slice(0, 8).map((i) => `  • @${who(i)}: ${oneLine(i.text, 90)} [${i.id}]`).join('\n')}` : 'Inbox: nothing new.',
        pendingHandoff ? `Human queue: ${pendingHandoff} pending (handoff list).` : '',
        pendingApprovals ? `Approval queue: ${pendingApprovals} pending (x-mcp approve).` : '',
        `Spend: $${spend.spent_usd} of $${spend.budget_usd} this month (${spend.pct_used}%); this call ≈ $${(c1.usd + c2.usd + costOf('read.user')).toFixed(3)}.`,
        UNTRUSTED_NOTE,
      ]
        .filter(Boolean)
        .join('\n');
      return ok(text, { me: { id: me.id, username: me.username, followers: me.metrics.followers, following: me.metrics.following, follower_delta: followerDelta }, posts: rows, inbox, human_queue_pending: pendingHandoff, approvals_pending: pendingApprovals, spend, rate_limits: ctx.client.rateSnapshot });
    },
  );

  // ------------------------------------------------------- post_performance
  tool(
    server,
    'post_performance',
    {
      title: 'Refresh metrics for your posts and read them in algorithm terms',
      description: `Pull current metrics for your posts (owned reads $${PRICE['read.owned']}; set include_private_metrics for impressions/url clicks/profile clicks via the posts endpoint at $${PRICE['read.post']}/post, own posts ≤30 days only), append to the local snapshot history, and return velocity + milestones: whether the post has entered the out-of-network corpus (≥1 like within 24h), whether the cold-start lift is still possible (<1000 views, <24h, you ≤1k followers), the next power-of-two like milestone that triggers a re-index, and when it ages out (48h).`,
      inputSchema: z.object({
        post_ids: z.array(ID).max(50).optional().describe('Specific posts; default = your most recent.'),
        max: z.number().int().min(5).max(50).optional(),
        include_private_metrics: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const me = await ctx.me();
      let posts: Post[];
      let charged = 0;
      if (args.post_ids?.length || args.include_private_metrics) {
        let ids = args.post_ids ?? [];
        if (!ids.length) {
          const r = await ctx.client.myPosts(me.id, { max: args.max ?? 15 });
          charged += ctx.chargeReads('post_performance', 'read.owned', r.posts.map((p) => `p:${p.id}`)).usd;
          ids = r.posts.map((p) => p.id);
        }
        const r = await ctx.client.postsByIds(ids, Boolean(args.include_private_metrics));
        charged += ctx.chargeReads('post_performance', 'read.post', ids.map((i) => `p:${i}`), 'private metrics').usd;
        posts = r.posts;
      } else {
        const r = await ctx.client.myPosts(me.id, { max: args.max ?? 15 });
        charged += ctx.chargeReads('post_performance', 'read.owned', r.posts.map((p) => `p:${p.id}`)).usd;
        posts = r.posts;
      }
      const rows = posts.map((p) => refreshMyPost(ctx, p, me));
      const text = rows.map((r) => `• [${r.id}]${rowLine(r)}\n   ${r.milestones.notes.join(' ')}`).join('\n');
      return ok(`${text || 'No posts found.'}\n\nCost ≈ $${charged.toFixed(3)}.`, { posts: rows, cost_usd: Number(charged.toFixed(3)) });
    },
  );

  // ------------------------------------------------------------------ inbox
  tool(
    server,
    'inbox',
    {
      title: 'Mentions and replies to you, prioritised and marked replyable',
      description: `Owned read ($${PRICE['read.owned']}/item). Lists posts that @mention you or reply to you, newest first, with the author's follower band and connection status. Every item here summoned you, so the reply tool is allowed to answer it via the API. Prioritises: replies on your originals (each answered reply keeps the conversation alive — reply weight is the biggest realistic head), then mutuals, then large accounts. Marks items as seen; pass include_seen=true to list again. ${UNTRUSTED_NOTE}`,
      inputSchema: z.object({ max: z.number().int().min(5).max(100).optional(), include_seen: z.boolean().optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const me = await ctx.me();
      const r = await ctx.client.mentions(me.id, { max: args.max ?? 30 });
      const c = ctx.chargeReads('inbox', 'read.owned', r.posts.map((p) => `m:${p.id}`));
      const items = r.posts
        .filter((p) => p.author_id !== me.id && (args.include_seen || !Object.hasOwn(ctx.store.s.seenMentions, p.id)))
        .map((p) => {
          const d = describePost(p, r.users);
          const via = summonedBy(p, me).via;
          const onMyPost = p.conversation_id ? Object.hasOwn(ctx.store.s.posts, p.conversation_id) : false;
          const mutual = isMutual(d.author?.connection);
          const priority = (onMyPost ? 3 : 0) + (mutual ? 2 : 0) + ((d.author?.followers ?? 0) > ALGO.REPLY_LLM_SCORED_ABOVE_FOLLOWERS ? 1 : 0) + (via === 'reply_to_me' ? 1 : 0);
          return { ...d, kind: via === 'reply_to_me' ? 'reply_to_me' : d.is_quote ? 'quote_or_mention' : 'mention', on_my_post: onMyPost, mutual, already_replied: Object.hasOwn(ctx.store.s.repliedConversations, p.id), priority, api_replyable: true };
        })
        .sort((a, b) => b.priority - a.priority);
      ctx.store.update((s) => {
        for (const p of r.posts) {
          s.seenMentions[p.id] ??= Date.now();
          if (!s.lastMentionId || BigInt(p.id) > BigInt(s.lastMentionId)) s.lastMentionId = p.id;
        }
      });
      const text = items.length
        ? items.map((i) => `• [${i.id}] @${who(i)} (${i.author?.band ?? '?'}${i.mutual ? ', mutual' : ''}${i.on_my_post ? ', on your post' : ''}) ${i.already_replied ? '✓answered ' : ''}— ${oneLine(i.text, 110)}`).join('\n')
        : 'No new mentions.';
      return ok(`${text}\n\nCost ≈ $${c.usd.toFixed(3)}. Reply with the reply tool (all of these summoned you). ${UNTRUSTED_NOTE}`, { items, cost_usd: c.usd });
    },
  );

  // ----------------------------------------------------------- conversation
  tool(
    server,
    'conversation',
    {
      title: 'Read a thread before you answer it',
      description: `Fetch a post and the replies in its conversation (recent search \`conversation_id:\`; last 7 days), ordered chronologically with authors. Public reads at $${PRICE['read.post']}/post, capped by max (default 20). Use before replying so the answer is specific. ${UNTRUSTED_NOTE}`,
      inputSchema: z.object({ post_id: ID, max: z.number().int().min(5).max(100).optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const max = Math.min(args.max ?? 20, ctx.cfg.maxReadsPerCall);
      const root = await ctx.client.postsByIds([args.post_id]);
      let charged = ctx.chargeReads('conversation', 'read.post', [`p:${args.post_id}`]).usd;
      const rootPost = root.posts[0];
      if (!rootPost) throw new Error(`Post ${args.post_id} not found.`);
      const convId = rootPost.conversation_id ?? rootPost.id;
      const replies = await ctx.client.searchRecent(`conversation_id:${convId}`, { max: Math.max(10, max), sort: 'recency' });
      charged += ctx.chargeReads('conversation', 'read.post', replies.posts.map((p) => `p:${p.id}`)).usd;
      const users = new Map([...root.users, ...replies.users]);
      const all = [rootPost, ...replies.posts.filter((p) => p.id !== rootPost.id)].sort((a, b) => createdMs(a) - createdMs(b));
      const rows = all.map((p) => describePost(p, users));
      const text = rows.map((r) => `${r.id === rootPost.id ? '■' : '↳'} @${who(r)} (${r.age_hours}h, ${r.metrics.likes}♥): ${oneLine(r.text, 200)}`).join('\n');
      return ok(`${text}\n\n${rows.length} posts, cost ≈ $${charged.toFixed(3)}. Search covers the last 7 days only. ${UNTRUSTED_NOTE}`, { conversation_id: convId, posts: rows, cost_usd: Number(charged.toFixed(3)) });
    },
  );

  // ------------------------------------------------------------------ scout
  tool(
    server,
    'scout',
    {
      title: 'Scout the niche: find conversations worth joining, priced and ranked',
      description: `Search recent posts (7-day window) with X operators, then rank the results as *opportunities*: author follower band (≤1k peers follow back; ≤60k replies are not LLM-scored; >60k they are), freshness, whether it ends in a question, engagement so far, and whether you already replied. Cold replies to these are NOT possible via the API on pay-per-use (X rejects un-summoned replies) — each result carries a one-tap intent link and you can push the best ones to the human with handoff(kind="cold_reply"). Public reads $${PRICE['read.post']}/post; hard-capped at ${ctx.cfg.maxReadsPerCall} per call and deduplicated per UTC day. Default filters add \`-is:retweet -is:reply\` and lang:en unless you pass raw=true. ${UNTRUSTED_NOTE}`,
      inputSchema: z.object({
        query: z.string().describe('Search terms/operators, e.g. `(MLX OR mtplx OR "local llm") mac`'),
        max: z.number().int().min(10).max(100).optional().describe('Results to fetch (default 20).'),
        raw: z.boolean().optional().describe('Do not append the default filters.'),
        lang: z.string().regex(/^[a-z]{2}$/).optional().describe('Language filter (default en).'),
        min_followers: z.number().int().optional().describe('Drop authors below this follower count.'),
        max_followers: z.number().int().optional().describe('Drop authors above this follower count (e.g. 60000 to avoid LLM-scored threads).'),
        sort: z.enum(['recency', 'relevancy']).optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const me = await ctx.me();
      const max = Math.min(args.max ?? 20, ctx.cfg.maxReadsPerCall);
      const q = args.raw ? args.query : `${args.query} -is:retweet -is:reply lang:${args.lang ?? 'en'}`;
      const warn = ctx.affordable(costOf('read.post', max), `scout (${max} reads)`);
      const r = await ctx.client.searchRecent(q, { max, sort: args.sort ?? 'recency' });
      const c = ctx.chargeReads('scout', 'read.post', r.posts.map((p) => `p:${p.id}`), q.slice(0, 60));
      const opps = r.posts
        .flatMap((p) => {
          const d = describePost(p, r.users);
          const f = d.author?.followers;
          if (p.author_id === me.id) return [];
          if (args.min_followers !== undefined && (f ?? 0) < args.min_followers) return [];
          if (args.max_followers !== undefined && (f ?? Infinity) > args.max_followers) return [];
          const band = authorBand(f);
          const asksQuestion = /\?/.test(p.text);
          const replied = Object.hasOwn(ctx.store.s.repliedConversations, p.id);
          const score = 50 + (asksQuestion ? 15 : 0) + (d.age_hours < 3 ? 15 : d.age_hours < 12 ? 8 : 0) + (band.band === 'peer_small' ? 10 : band.band === 'mid' ? 8 : 0) + Math.min(10, p.metrics.replies) - (replied ? 50 : 0);
          const why: string[] = [];
          if (asksQuestion) why.push('asks a question');
          if (d.age_hours < 3) why.push('fresh (<3h)');
          why.push(band.note.split(':')[0]!);
          if (p.metrics.replies > 5) why.push(`${p.metrics.replies} replies already — active thread`);
          return [{ ...d, mutual: isMutual(d.author?.connection), score, why, api_replyable: summonedBy(p, me).summoned, intent_reply_url: intentReply(p.id), already_replied: replied }];
        })
        .sort((a, b) => b.score - a.score);
      const text = opps.length
        ? opps.slice(0, 15).map((o) => `• ${o.score} @${who(o)} (${o.author?.followers ?? '?'} f, ${o.age_hours}h) ${o.why.join(', ')}\n   ${oneLine(o.text, 140)}\n   ${o.url}`).join('\n')
        : 'No results.';
      return ok(`${text}\n\n${opps.length} opportunities, ${c.charged} new reads charged ≈ $${c.usd.toFixed(3)}.${warn ? ` ${warn}` : ''}\nCold replies here need the human: push the best with handoff(kind="cold_reply", ...). ${UNTRUSTED_NOTE}`, { query: q, opportunities: opps, cost_usd: c.usd, next: r.next });
    },
  );

  // -------------------------------------------------------------------- who
  tool(
    server,
    'who',
    {
      title: 'Look up an account: band, relationship, pinned post',
      description: `User lookup ($${PRICE['read.user']}). Returns follower band (peer ≤1k / mid ≤60k / large), connection status (following + followed_by = mutual → +15 reply weight on your originals for them), verified type, bio, and optionally their last few original posts ($${PRICE['read.post']} each, capped at 10). ${UNTRUSTED_NOTE}`,
      inputSchema: z.object({ username: USERNAME.optional(), user_id: ID.optional(), recent_posts: z.number().int().min(0).max(10).optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      if (!args.username && !args.user_id) throw new Error('Provide username or user_id.');
      const u = args.username ? await ctx.client.userByUsername(args.username) : (await ctx.client.usersByIds([args.user_id!]))[0];
      if (!u) throw new Error('User not found.');
      let cost = ctx.chargeReads('who', 'read.user', [`u:${u.id}`]).usd;
      const band = authorBand(u.metrics.followers);
      const mutual = isMutual(u.connection);
      let recent: PostView[] = [];
      if (args.recent_posts) {
        const r = await ctx.client.myPosts(u.id, { max: Math.max(5, args.recent_posts), exclude: 'replies,retweets' });
        cost += ctx.chargeReads('who', 'read.post', r.posts.map((p) => `p:${p.id}`)).usd;
        recent = r.posts.slice(0, args.recent_posts).map((p) => describePost(p, r.users));
      }
      return ok(
        `@${u.username} — ${u.metrics.followers} followers / ${u.metrics.following} following (${band.band}). ${band.note}\nRelationship: ${u.connection?.length ? u.connection.join(', ') : 'none'}${mutual ? ' → MUTUAL (+15 reply weight on your originals in their feed)' : ''}. Verified: ${u.verified_type ?? 'no'}.\nBio: ${oneLine(u.description ?? '', 200)}\nCost ≈ $${cost.toFixed(3)}. ${UNTRUSTED_NOTE}`,
        { user: u, band, mutual, recent, cost_usd: cost },
      );
    },
  );
}
