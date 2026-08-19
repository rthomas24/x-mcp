/**
 * The business layer — what an operator keeps that the API doesn't:
 *   people    relationship ledger (CRM) auto-built from every interaction
 *   schedule  content calendar with data-driven best posting times + run_due (cron)
 *   insights  what actually works: by hour, kind, tag; OON-entry rate; goals
 *   brand     lane / voice / banned words — persistent across sessions, enforced in draft_check
 *   ideas     content pipeline (idea bank → publish marks used)
 *   report    owner digest in markdown
 * All local state; the only network calls are the ones `schedule run_due` makes to publish.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { USERNAME, intentFor, oneLine, postUrl } from '../format.js';
import { brandCheck, extractUrls, hoursSince } from '../rules.js';
import type { Idea, MetricSnapshot, MyPost, Person, ScheduledPost } from '../store.js';
import { Ctx, ok, tool } from './context.js';
import { addHandoff } from './handoff.js';
import { publishPost, PublishSchema } from './write.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------------------------------------------------------------------------
// Engagement math shared by schedule/insights/report
// ---------------------------------------------------------------------------
/** Weighted engagement of a post at its latest snapshot, loosely mirroring the ranking heads. */
function engagement(snaps: MetricSnapshot[] | undefined): number {
  const s = snaps?.at(-1);
  if (!s) return 0;
  return s.likes + 3 * s.replies + 2 * s.reposts + 3 * s.quotes + (s.bookmarks ?? 0);
}

/** Snapshot closest to `hoursAfter` post creation (for "at 24h" comparisons). */
function snapshotAt(snaps: MetricSnapshot[] | undefined, created: number, hoursAfter: number): MetricSnapshot | undefined {
  if (!snaps?.length) return undefined;
  const target = created + hoursAfter * HOUR;
  let best: MetricSnapshot | undefined;
  for (const s of snaps) if (!best || Math.abs(s.ts - target) < Math.abs(best.ts - target)) best = s;
  return best;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

export interface BestTimes {
  enough_data: boolean;
  posts_considered: number;
  by_hour: { hour: number; posts: number; avg_engagement: number }[]; // sorted best first
  by_weekday: { weekday: string; posts: number; avg_engagement: number }[];
  suggestion: string;
  next_best_iso: string;
}

/** Best posting hours from the account's own history (local time of this machine). */
export function bestTimes(posts: MyPost[], metrics: Record<string, MetricSnapshot[]>, now = Date.now()): BestTimes {
  const originals = posts.filter((p) => p.kind === 'original' && metrics[p.id]?.length);
  const hours = new Map<number, { n: number; sum: number }>();
  const days = new Map<number, { n: number; sum: number }>();
  for (const p of originals) {
    const d = new Date(p.created_at);
    const e = engagement(metrics[p.id]);
    const h = hours.get(d.getHours()) ?? { n: 0, sum: 0 };
    h.n++;
    h.sum += e;
    hours.set(d.getHours(), h);
    const w = days.get(d.getDay()) ?? { n: 0, sum: 0 };
    w.n++;
    w.sum += e;
    days.set(d.getDay(), w);
  }
  const by_hour = [...hours.entries()].map(([hour, v]) => ({ hour, posts: v.n, avg_engagement: Number((v.sum / v.n).toFixed(2)) })).sort((a, b) => b.avg_engagement - a.avg_engagement || b.posts - a.posts);
  const by_weekday = [...days.entries()].map(([d, v]) => ({ weekday: DOW[d]!, posts: v.n, avg_engagement: Number((v.sum / v.n).toFixed(2)) })).sort((a, b) => b.avg_engagement - a.avg_engagement);
  const enough = originals.length >= 6 && by_hour.length >= 3;
  const topHours = enough ? by_hour.slice(0, 3).map((h) => h.hour) : [9, 12, 18];
  // next occurrence of the best hour, at least 30 minutes from now
  const nowD = new Date(now);
  let next: Date | undefined;
  for (let dayOffset = 0; dayOffset < 2 && !next; dayOffset++) {
    for (const h of [...topHours].sort((a, b) => a - b)) {
      const cand = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate() + dayOffset, h, 0, 0, 0);
      if (cand.getTime() > now + 30 * 60_000) {
        next = cand;
        break;
      }
    }
  }
  const suggestion = enough
    ? `Your best hours so far (local): ${by_hour.slice(0, 3).map((h) => `${h.hour}:00 (avg ${h.avg_engagement}, n=${h.posts})`).join(', ')}; best days: ${by_weekday.slice(0, 2).map((d) => d.weekday).join(', ')}.`
    : `Not enough history yet (${originals.length} scored originals; need ~6 across ≥3 hours). Using defaults 9:00 / 12:00 / 18:00 local until then — post, snapshot with post_performance, and this sharpens.`;
  return { enough_data: enough, posts_considered: originals.length, by_hour, by_weekday, suggestion, next_best_iso: (next ?? new Date(now + HOUR)).toISOString() };
}

function parseWhen(when: string | undefined, bt: BestTimes, now = Date.now()): number {
  if (!when || when === 'next_best') return Date.parse(bt.next_best_iso);
  const rel = /^\+(\d+(?:\.\d+)?)\s*(m|min|h|hr|d)$/i.exec(when.trim());
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    return now + n * (unit.startsWith('m') ? 60_000 : unit.startsWith('h') ? HOUR : DAY);
  }
  const t = Date.parse(when);
  if (!Number.isFinite(t)) throw new Error(`Cannot parse when="${when}". Use an ISO timestamp, "+2h", "+30m", "+1d", or "next_best".`);
  return t;
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------
export interface Insights {
  window_days: number;
  originals: number;
  replies: number;
  threads: number;
  oon_entry_rate: number | null; // share of originals ≥24h old that got ≥1 like by 24h
  median_engagement_24h: number;
  median_replies_24h: number;
  reply_rate_on_inbox: number | null; // our replies / inbound replies+mentions
  by_kind: Record<string, { posts: number; avg_engagement: number }>;
  by_tag: { tag: string; posts: number; avg_engagement: number }[];
  best_times: BestTimes;
  top_posts: { id: string; text: string; engagement: number; tags?: string[] }[];
  followers: { now?: number; delta_7d?: number; delta_30d?: number };
  handoff: { pending: number; done_30d: number; completion_rate: number | null };
  spend_usd: number;
  usd_per_engagement: number | null;
  goals: { followers?: { target: number; by: string; now?: number; remaining?: number; days_left?: number; needed_per_day?: number }; originals_per_week?: { target: number; actual: number } };
  advice: string[];
}

export function computeInsights(ctx: Ctx, days: number, now = Date.now()): Insights {
  const s = ctx.store.s;
  const since = now - days * DAY;
  const posts = Object.values(s.posts).filter((p) => p.created_at >= since);
  const originals = posts.filter((p) => p.kind === 'original');
  const replies = posts.filter((p) => p.kind === 'reply');
  const threads = posts.filter((p) => p.kind === 'thread_child');
  const aged = originals.filter((p) => now - p.created_at >= 24 * HOUR);
  const entered = aged.filter((p) => (snapshotAt(s.metrics[p.id], p.created_at, 24)?.likes ?? 0) >= 1);
  const eng24 = originals.map((p) => engagement([snapshotAt(s.metrics[p.id], p.created_at, 24)].filter(Boolean) as MetricSnapshot[]));
  const rep24 = originals.map((p) => snapshotAt(s.metrics[p.id], p.created_at, 24)?.replies ?? 0);
  const by_kind: Insights['by_kind'] = {};
  for (const p of posts) {
    const k = (by_kind[p.kind] ??= { posts: 0, avg_engagement: 0 });
    k.posts++;
    k.avg_engagement += engagement(s.metrics[p.id]);
  }
  for (const k of Object.values(by_kind)) k.avg_engagement = Number((k.avg_engagement / k.posts).toFixed(2));
  const tagAgg = new Map<string, { n: number; sum: number }>();
  for (const p of originals) for (const t of p.tags ?? []) {
    const a = tagAgg.get(t) ?? { n: 0, sum: 0 };
    a.n++;
    a.sum += engagement(s.metrics[p.id]);
    tagAgg.set(t, a);
  }
  const by_tag = [...tagAgg.entries()].map(([tag, a]) => ({ tag, posts: a.n, avg_engagement: Number((a.sum / a.n).toFixed(2)) })).sort((a, b) => b.avg_engagement - a.avg_engagement);
  const top_posts = [...originals].map((p) => ({ id: p.id, text: oneLine(p.text, 80), engagement: engagement(s.metrics[p.id]), tags: p.tags })).sort((a, b) => b.engagement - a.engagement).slice(0, 5);
  const inbound = Object.values(s.people).reduce((n, p) => n + p.replies_to_me + p.mentions_of_me, 0);
  const outbound = Object.values(s.people).reduce((n, p) => n + p.my_replies, 0);
  const snaps = s.followerSnapshots;
  const latest = snaps.at(-1);
  const at = (ms: number) => [...snaps].reverse().find((x) => x.ts <= now - ms);
  const followers = { now: latest?.followers, delta_7d: latest && at(7 * DAY) ? latest.followers - at(7 * DAY)!.followers : undefined, delta_30d: latest && at(30 * DAY) ? latest.followers - at(30 * DAY)!.followers : undefined };
  const hPending = s.handoff.filter((h) => h.status === 'pending').length;
  const hDone = s.handoff.filter((h) => h.status === 'done' && (h.resolved_ts ?? 0) >= now - 30 * DAY).length;
  const hDropped = s.handoff.filter((h) => h.status === 'dropped' && (h.resolved_ts ?? 0) >= now - 30 * DAY).length;
  const spend = s.ledger.filter((e) => e.ts >= since).reduce((n, e) => n + e.usd, 0);
  const totalEng = originals.reduce((n, p) => n + engagement(s.metrics[p.id]), 0);
  const goals: Insights['goals'] = {};
  const g = s.brand.goals;
  if (g.followers) {
    const by = Date.parse(g.followers.by);
    const daysLeft = Number.isFinite(by) ? Math.max(0, (by - now) / DAY) : undefined;
    const remaining = latest ? Math.max(0, g.followers.target - latest.followers) : undefined;
    goals.followers = { ...g.followers, now: latest?.followers, remaining, days_left: daysLeft !== undefined ? Number(daysLeft.toFixed(1)) : undefined, needed_per_day: remaining !== undefined && daysLeft ? Number((remaining / daysLeft).toFixed(2)) : undefined };
  }
  if (g.originals_per_week) goals.originals_per_week = { target: g.originals_per_week, actual: Number(((originals.length / days) * 7).toFixed(1)) };

  const advice: string[] = [];
  if (aged.length >= 3 && entered.length / aged.length < 0.5) advice.push(`Only ${entered.length}/${aged.length} originals got a first like within 24h — that like is the door to out-of-network reach. Seed it faster (reply to your own replies, ask one person).`);
  if (inbound > 0 && outbound / inbound < 0.6) advice.push(`You answered ${outbound} of ${inbound} inbound mentions/replies — reply weight is the biggest head you can realistically move; answer them all.`);
  if (by_tag.length >= 2 && by_tag[0]!.avg_engagement > 1.5 * (by_tag.at(-1)!.avg_engagement || 0.5)) advice.push(`Tag "${by_tag[0]!.tag}" outperforms "${by_tag.at(-1)!.tag}" ${(by_tag[0]!.avg_engagement / Math.max(0.5, by_tag.at(-1)!.avg_engagement)).toFixed(1)}× — do more of the former.`);
  if (goals.followers?.needed_per_day !== undefined && followers.delta_7d !== undefined && followers.delta_7d / 7 < goals.followers.needed_per_day) advice.push(`Follower goal needs ${goals.followers.needed_per_day}/day; last 7d ran at ${(followers.delta_7d / 7).toFixed(2)}/day. More originals at the best hours + more handoff follows of people who replied.`);
  if (hPending > 5) advice.push(`${hPending} human handoff items pending — the quote/follow actions only pay off when they get tapped.`);
  if (goals.originals_per_week && goals.originals_per_week.actual < goals.originals_per_week.target * 0.8) advice.push(`Posting ${goals.originals_per_week.actual}/week vs a target of ${goals.originals_per_week.target}. Use ideas + schedule to keep the cadence.`);
  const bt = bestTimes(Object.values(s.posts), s.metrics, now);
  if (bt.enough_data) advice.push(bt.suggestion);
  return {
    window_days: days,
    originals: originals.length,
    replies: replies.length,
    threads: threads.length,
    oon_entry_rate: aged.length ? Number((entered.length / aged.length).toFixed(2)) : null,
    median_engagement_24h: median(eng24),
    median_replies_24h: median(rep24),
    reply_rate_on_inbox: inbound ? Number((outbound / inbound).toFixed(2)) : null,
    by_kind,
    by_tag,
    best_times: bt,
    top_posts,
    followers,
    handoff: { pending: hPending, done_30d: hDone, completion_rate: hDone + hDropped ? Number((hDone / (hDone + hDropped)).toFixed(2)) : null },
    spend_usd: Number(spend.toFixed(3)),
    usd_per_engagement: totalEng ? Number((spend / totalEng).toFixed(4)) : null,
    goals,
    advice,
  };
}

export function renderReport(ctx: Ctx, days: number, me: { username: string }): string {
  const i = computeInsights(ctx, days);
  const s = ctx.store.s;
  const people = Object.values(s.people).sort((a, b) => Ctx.personScore(b) - Ctx.personScore(a)).slice(0, 8);
  const pending = s.handoff.filter((h) => h.status === 'pending');
  const lines = [
    `# @${me.username} — last ${days} days`,
    '',
    `**Followers:** ${i.followers.now ?? '?'}${i.followers.delta_7d !== undefined ? ` (${i.followers.delta_7d >= 0 ? '+' : ''}${i.followers.delta_7d} in 7d)` : ''}${i.followers.delta_30d !== undefined ? `, ${i.followers.delta_30d >= 0 ? '+' : ''}${i.followers.delta_30d} in 30d` : ''}`,
    `**Output:** ${i.originals} originals · ${i.threads} thread posts · ${i.replies} replies · spend $${i.spend_usd}${i.usd_per_engagement !== null ? ` ($${i.usd_per_engagement}/engagement)` : ''}`,
    `**Reach mechanics:** ${i.oon_entry_rate === null ? 'n/a' : `${Math.round(i.oon_entry_rate * 100)}% of originals got a first like within 24h (OON door)`} · median engagement@24h ${i.median_engagement_24h} · median replies@24h ${i.median_replies_24h}${i.reply_rate_on_inbox !== null ? ` · you answered ${Math.round(i.reply_rate_on_inbox * 100)}% of inbound` : ''}`,
    '',
    '## Best posts',
    ...(i.top_posts.length ? i.top_posts.map((p) => `- ${p.engagement} — ${p.text}${p.tags?.length ? ` _[${p.tags.join(', ')}]_` : ''} (${postUrl(me.username, p.id)})`) : ['_none yet_']),
    '',
    '## What works',
    ...(i.by_tag.length ? i.by_tag.map((t) => `- ${t.tag}: ${t.posts} posts, avg ${t.avg_engagement}`) : ['_tag your posts (publish tags=[...]) to learn by format_']),
    `- ${i.best_times.suggestion}`,
    '',
    '## People',
    ...(people.length ? people.map((p) => `- @${p.username}${p.mutual ? ' (mutual)' : p.follows_me ? ' (follows you)' : ''} — ${p.replies_to_me} replies, ${p.mentions_of_me} mentions, ${p.my_replies} answered${p.tags.length ? ` · ${p.tags.join(', ')}` : ''}`) : ['_no interactions recorded yet_']),
    '',
    `## Human queue (${pending.length} pending)`,
    ...(pending.length ? pending.slice(0, 10).map((h) => `- ${h.kind}${h.target_username ? ` @${h.target_username}` : ''}${h.why ? ` — ${h.why}` : ''}: ${intentFor(h)}`) : ['_empty_']),
    '',
    '## Goals',
    ...(i.goals.followers ? [`- Followers: ${i.goals.followers.now ?? '?'} → ${i.goals.followers.target} by ${i.goals.followers.by}${i.goals.followers.needed_per_day !== undefined ? ` (need ${i.goals.followers.needed_per_day}/day)` : ''}`] : []),
    ...(i.goals.originals_per_week ? [`- Originals/week: ${i.goals.originals_per_week.actual} vs ${i.goals.originals_per_week.target}`] : []),
    ...(!i.goals.followers && !i.goals.originals_per_week ? ['_set goals with brand(set, goals=...)_'] : []),
    '',
    '## Advice',
    ...(i.advice.length ? i.advice.map((a) => `- ${a}`) : ['- Keep posting originals at the best hours, answer every reply, tap the handoff links.']),
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
export function registerBusinessTools(server: McpServer, ctx: Ctx): void {
  // ------------------------------------------------------------------ people
  tool(
    server,
    'people',
    {
      title: 'Relationship ledger (CRM): who engages with you, and who to follow back',
      description: `Local, free. Every mention/reply you receive and every reply you send updates a per-person record (counts, follower band, mutual status, first/last seen, tags, notes). Actions:
- top: highest-value people (inbound replies ×3 + mentions ×2 + your replies + mutual bonus), with filters.
- get: one person by username.
- note / tag: attach memory the next session will see ("asked about MLX quantization", tag "mutual-candidate").
- suggest_follows: people who engaged ≥2 times whom you don't follow back — the cheapest way to mint mutuals (+15 reply weight on your originals in their feed). With queue=true each becomes a handoff(follow) link.
Pair with scout(circle=true) to find their fresh posts to engage with.`,
      inputSchema: z.object({
        action: z.enum(['top', 'get', 'note', 'tag', 'suggest_follows']),
        username: USERNAME.optional(),
        text: z.string().optional().describe('note text or comma-separated tags'),
        limit: z.number().int().min(1).max(100).optional(),
        filter: z.enum(['all', 'mutual', 'follows_me', 'not_followed_back', 'peer_small', 'mid', 'large']).optional(),
        queue: z.boolean().optional().describe('suggest_follows: also create handoff(follow) items.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const all = Object.values(ctx.store.s.people);
      const byName = (u: string) => all.find((p) => p.username.toLowerCase() === u.replace(/^@/, '').toLowerCase());
      const describe = (p: Person) => `@${p.username}${p.mutual ? ' ·mutual' : p.follows_me ? ' ·follows you' : p.followed_by_me ? ' ·you follow' : ''} (${p.band ?? '?'}${p.followers ? `, ${p.followers}f` : ''}) score ${Ctx.personScore(p)} — ${p.replies_to_me}↩ ${p.mentions_of_me}@ ${p.my_replies} answered · last ${hoursSince(p.last_seen).toFixed(0)}h ago${p.tags.length ? ` · ${p.tags.join(', ')}` : ''}${p.notes.length ? `\n    note: ${oneLine(p.notes.at(-1)!, 120)}` : ''}`;
      if (args.action === 'get') {
        if (!args.username) throw new Error('username required');
        const p = byName(args.username);
        if (!p) return ok(`No record for @${args.username} yet.`, { person: null });
        return ok(describe(p), { person: p });
      }
      if (args.action === 'note' || args.action === 'tag') {
        if (!args.username || !args.text) throw new Error('username and text required');
        const p = byName(args.username);
        if (!p) throw new Error(`No record for @${args.username} — they appear after an interaction (or run who first).`);
        ctx.store.update((s) => {
          const q = s.people[p.id]!;
          if (args.action === 'note') q.notes = [...q.notes.slice(-19), args.text!];
          else q.tags = [...new Set([...q.tags, ...args.text!.split(',').map((t) => t.trim()).filter(Boolean)])];
        });
        return ok(`Updated @${p.username}.`, { person: ctx.store.s.people[p.id] });
      }
      if (args.action === 'suggest_follows') {
        const cands = all.filter((p) => !p.followed_by_me && p.replies_to_me + p.mentions_of_me >= 2).sort((a, b) => Ctx.personScore(b) - Ctx.personScore(a)).slice(0, args.limit ?? 10);
        const items = cands.map((p) => ({ person: p, handoff: args.queue ? addHandoff(ctx, { kind: 'follow', target_username: p.username, why: `engaged ${p.replies_to_me + p.mentions_of_me}× — follow back to mint a mutual (+15 reply weight)` }) : undefined }));
        const text = items.length ? items.map((i) => `• ${describe(i.person)}${i.handoff ? `\n    ${intentFor(i.handoff)}` : ''}`).join('\n') : 'Nobody qualifies yet (needs ≥2 inbound interactions and not followed back).';
        return ok(`${text}${!args.queue && items.length ? '\nRe-run with queue=true to create one-tap follow links for the human.' : ''}`, { suggestions: items.map((i) => ({ ...i.person, handoff_id: i.handoff?.id, link: i.handoff ? intentFor(i.handoff) : intentFor({ kind: 'follow', target_username: i.person.username }) })) });
      }
      // top
      const f = args.filter ?? 'all';
      const list = all
        .filter((p) => (f === 'all' ? true : f === 'mutual' ? p.mutual : f === 'follows_me' ? p.follows_me : f === 'not_followed_back' ? p.follows_me && !p.followed_by_me : p.band === f))
        .sort((a, b) => Ctx.personScore(b) - Ctx.personScore(a))
        .slice(0, args.limit ?? 20);
      return ok(list.length ? list.map((p) => `• ${describe(p)}`).join('\n') : 'No people recorded yet — they appear as mentions/replies arrive (inbox, account_pulse).', { people: list, total: all.length });
    },
  );

  // ---------------------------------------------------------------- schedule
  tool(
    server,
    'schedule',
    {
      title: 'Content calendar: queue posts for the best time, run what is due',
      description: `Queue publish calls for later. \`when\` accepts an ISO timestamp, "+2h"/"+30m"/"+1d", or "next_best" (computed from your own history: the hours your originals earned the most engagement; defaults to 9/12/18 local until ~6 scored posts exist). Nothing posts until \`run_due\` is called — call it from your agent's cron, or run \`x-mcp tick\` on a schedule. Due posts go through the normal publish pipeline (rules, spacing ≥${ctx.cfg.minHoursBetweenOriginals}h, budget, approval queue). Actions: add · list · cancel · run_due · best_times.`,
      inputSchema: z.object({
        action: z.enum(['add', 'list', 'cancel', 'run_due', 'best_times']),
        when: z.string().optional().describe('ISO | "+2h" | "+30m" | "+1d" | "next_best" (default).'),
        post: PublishSchema.omit({ dry_run: true }).optional().describe('The publish arguments (text, media_paths, thread, tags, …).'),
        id: z.string().optional(),
        include_done: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const s = ctx.store.s;
      const bt = bestTimes(Object.values(s.posts), s.metrics);
      if (args.action === 'best_times') return ok(bt.suggestion + `\nNext best slot: ${bt.next_best_iso}`, bt as unknown as Record<string, unknown>);
      if (args.action === 'add') {
        if (!args.post) throw new Error('post (publish arguments) required');
        const dry = await publishPost(ctx, { ...args.post, dry_run: true, force: true });
        if (dry.isError || (dry.structuredContent as { problems?: string[] })?.problems?.length) return ok(`Not scheduled — fix the draft first:\n${dry.content[0]!.text}`, { scheduled: false, check: dry.structuredContent });
        const not_before = parseWhen(args.when, bt);
        const item: ScheduledPost = { id: randomUUID().slice(0, 6), created: Date.now(), not_before, args: args.post as Record<string, unknown>, status: 'pending' };
        ctx.store.update((st) => st.scheduled.push(item));
        return ok(`Scheduled ${item.id} for ${new Date(not_before).toISOString()} (${((not_before - Date.now()) / HOUR).toFixed(1)}h from now). It posts when run_due is called after that time.`, { scheduled: true, item, check: dry.structuredContent });
      }
      if (args.action === 'cancel') {
        if (!args.id) throw new Error('id required');
        if (!s.scheduled.some((x) => x.id === args.id)) throw new Error(`No scheduled item ${args.id}`);
        ctx.store.update((st) => {
          const x = st.scheduled.find((y) => y.id === args.id);
          if (x && x.status === 'pending') x.status = 'cancelled';
        });
        return ok(`Cancelled ${args.id}.`, { id: args.id });
      }
      if (args.action === 'run_due') {
        const due = s.scheduled.filter((x) => x.status === 'pending' && x.not_before <= Date.now()).sort((a, b) => a.not_before - b.not_before);
        const results: { id: string; status: string; detail: string }[] = [];
        for (const item of due) {
          const r = await publishPost(ctx, item.args as import('./write.js').PublishArgs);
          const sc = r.structuredContent as { posted?: boolean; queued?: { id: string }; problems?: string[]; id?: string } | undefined;
          const status: ScheduledPost['status'] = sc?.posted ? 'posted' : sc?.queued ? 'queued' : 'failed';
          ctx.store.update((st) => {
            const x = st.scheduled.find((y) => y.id === item.id);
            if (!x) return;
            x.status = status;
            x.result = r.structuredContent ?? r.content[0]?.text;
            if (sc?.id) x.posted_id = sc.id;
          });
          results.push({ id: item.id, status, detail: r.content[0]?.text.split('\n')[0] ?? '' });
          if (status === 'posted') break; // spacing rule: one original per run; the rest wait for the next tick
        }
        return ok(results.length ? results.map((r) => `• ${r.id}: ${r.status} — ${r.detail}`).join('\n') : 'Nothing due.', { ran: results, pending: s.scheduled.filter((x) => x.status === 'pending').length });
      }
      const items = s.scheduled.filter((x) => args.include_done || x.status === 'pending').sort((a, b) => a.not_before - b.not_before);
      return ok(items.length ? items.map((x) => `• [${x.id}] ${x.status} @ ${new Date(x.not_before).toISOString()} — ${oneLine(String((x.args as { text?: string }).text ?? ''), 80)}`).join('\n') : 'Calendar is empty.', { items, best_times: bt });
    },
  );

  // ---------------------------------------------------------------- insights
  tool(
    server,
    'insights',
    {
      title: 'What actually works: by hour, kind, tag; OON-entry rate; goals; advice',
      description: `Free, local. Aggregates your own posts + metric snapshots (refresh them with post_performance) into the numbers a business would watch: originals/replies/threads, the share of originals that got a first like within 24h (the out-of-network door), median engagement and replies at 24h, reply rate on inbound, engagement by post kind and by experiment tag, best posting hours, top posts, follower deltas, handoff completion, spend per engagement, goal progress, and concrete advice. The more you tag posts (publish tags=[...]) and snapshot, the sharper it gets.`,
      inputSchema: z.object({ days: z.number().int().min(1).max(365).optional().describe('Window (default 30).') }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const i = computeInsights(ctx, args.days ?? 30);
      const text = [
        `Last ${i.window_days}d: ${i.originals} originals, ${i.threads} thread posts, ${i.replies} replies. Spend $${i.spend_usd}${i.usd_per_engagement !== null ? ` ($${i.usd_per_engagement}/engagement)` : ''}.`,
        `OON door: ${i.oon_entry_rate === null ? 'n/a' : `${Math.round(i.oon_entry_rate * 100)}% of aged originals had ≥1 like by 24h`}. Median engagement@24h ${i.median_engagement_24h}, replies@24h ${i.median_replies_24h}. Inbound answered: ${i.reply_rate_on_inbox === null ? 'n/a' : `${Math.round(i.reply_rate_on_inbox * 100)}%`}.`,
        `Followers: ${i.followers.now ?? '?'} (${i.followers.delta_7d ?? '?'} / 7d, ${i.followers.delta_30d ?? '?'} / 30d).`,
        i.by_tag.length ? `By tag: ${i.by_tag.map((t) => `${t.tag} ${t.avg_engagement} (n=${t.posts})`).join(' · ')}` : 'By tag: none (tag your posts).',
        `By kind: ${Object.entries(i.by_kind).map(([k, v]) => `${k} ${v.avg_engagement} (n=${v.posts})`).join(' · ') || 'none'}`,
        i.best_times.suggestion,
        i.top_posts.length ? `Top: ${i.top_posts.slice(0, 3).map((p) => `"${oneLine(p.text, 50)}" ${p.engagement}`).join(' · ')}` : '',
        i.advice.length ? `Advice:\n${i.advice.map((a) => `- ${a}`).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      return ok(text, i as unknown as Record<string, unknown>);
    },
  );

  // ------------------------------------------------------------------- brand
  tool(
    server,
    'brand',
    {
      title: 'Brand book: lane, voice rules, banned words, goals — persistent across sessions',
      description: 'Free, local. The account\'s operating constraints that every session/agent should share: topical lane (the ranker keys on a consistent author identity + content neighbourhood), voice rules, banned words/phrases (draft_check and publish flag them), and goals (followers by date, originals per week) that insights/report track. Actions: get · set (merge) · check (a draft against the book).',
      inputSchema: z.object({
        action: z.enum(['get', 'set', 'check']),
        lane: z.string().optional(),
        voice: z.array(z.string()).max(20).optional().describe('Replace the voice rules.'),
        add_voice: z.array(z.string()).optional(),
        banned: z.array(z.string()).max(100).optional().describe('Replace the banned list.'),
        add_banned: z.array(z.string()).optional(),
        goals: z.object({ followers: z.object({ target: z.number().int().positive(), by: z.string() }).optional(), originals_per_week: z.number().positive().optional(), reply_within_hours: z.number().positive().optional() }).optional(),
        text: z.string().optional().describe('check: the draft'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      if (args.action === 'set') {
        ctx.store.update((s) => {
          const b = s.brand;
          if (args.lane !== undefined) b.lane = args.lane;
          if (args.voice) b.voice = args.voice;
          if (args.add_voice) b.voice = [...new Set([...b.voice, ...args.add_voice])];
          if (args.banned) b.banned = args.banned;
          if (args.add_banned) b.banned = [...new Set([...b.banned, ...args.add_banned])];
          if (args.goals) b.goals = { ...b.goals, ...args.goals };
          b.updated = Date.now();
        });
      }
      const b = ctx.store.s.brand;
      if (args.action === 'check') {
        if (!args.text) throw new Error('text required');
        const c = brandCheck(b, args.text);
        return ok(c.banned_hits.length ? `Banned words present: ${c.banned_hits.join(', ')}` : `No banned words. ${c.reminders.join(' · ')}`, c);
      }
      return ok(`Lane: ${b.lane ?? '(unset)'}\nVoice: ${b.voice.length ? b.voice.map((v) => `\n  - ${v}`).join('') : '(none)'}\nBanned: ${b.banned.join(', ') || '(none)'}\nGoals: ${JSON.stringify(b.goals)}`, b as unknown as Record<string, unknown>);
    },
  );

  // ------------------------------------------------------------------- ideas
  tool(
    server,
    'ideas',
    {
      title: 'Idea bank: the content pipeline between scouting and publishing',
      description: 'Free, local. Park post ideas with a source link, intended format and tags; list what is open; publish(idea_id=…) marks one used so the next session does not repeat it. Actions: add · list · drop.',
      inputSchema: z.object({
        action: z.enum(['add', 'list', 'drop']),
        text: z.string().optional(),
        source_url: z.string().url().optional(),
        format: z.string().optional().describe('e.g. video, receipt-image, thread, question'),
        tags: z.array(z.string()).max(8).optional(),
        id: z.string().optional(),
        include_used: z.boolean().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      if (args.action === 'add') {
        if (!args.text) throw new Error('text required');
        if (args.source_url && extractUrls(args.source_url).length === 0) throw new Error('source_url must be a URL');
        const idea: Idea = { id: randomUUID().slice(0, 6), ts: Date.now(), text: args.text, source_url: args.source_url, format: args.format, tags: args.tags ?? [], status: 'open' };
        ctx.store.update((s) => s.ideas.push(idea));
        return ok(`Idea ${idea.id} saved.`, { idea });
      }
      if (args.action === 'drop') {
        if (!args.id) throw new Error('id required');
        ctx.store.update((s) => {
          const i = s.ideas.find((x) => x.id === args.id);
          if (i) i.status = 'dropped';
        });
        return ok(`Dropped ${args.id}.`, { id: args.id });
      }
      const list = ctx.store.s.ideas.filter((i) => args.include_used || i.status === 'open').sort((a, b) => b.ts - a.ts);
      return ok(list.length ? list.map((i) => `• [${i.id}] ${i.status} ${i.format ? `(${i.format}) ` : ''}${oneLine(i.text, 100)}${i.tags.length ? ` · ${i.tags.join(', ')}` : ''}${i.source_url ? `\n    ${i.source_url}` : ''}`).join('\n') : 'Idea bank is empty.', { ideas: list });
    },
  );

  // ------------------------------------------------------------------ report
  tool(
    server,
    'report',
    {
      title: 'Owner digest (markdown): followers, output, what worked, people, queue, goals, advice',
      description: 'Free, local. A markdown report for the human who owns the account — paste it into a DM/email/Notion or return it as the agent\'s weekly summary. Built from insights + people + handoff + goals.',
      inputSchema: z.object({ days: z.number().int().min(1).max(90).optional().describe('Window (default 7).') }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const me = await ctx.me();
      const md = renderReport(ctx, args.days ?? 7, me);
      return ok(md, { markdown: md });
    },
  );
}
