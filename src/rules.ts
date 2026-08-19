/**
 * The algorithm-aware rules engine. Pure functions, no I/O.
 *
 * Every rule here traces to the open-sourced For You code (xai-org/x-algorithm,
 * commit 11a71f8, defaults synced 2026-08-12). Citations are in the comments so
 * the agent (and you) can see *why* a rule exists, not just that it does.
 */
import { PRICE } from './pricing.js';
import type { Brand } from './store.js';

// ---------------------------------------------------------------------------
// Ranking weights the agent should optimise for. home-mixer/params/param.rs:308-474
// ---------------------------------------------------------------------------
export const WEIGHTS = {
  share_via_copy_link: 20.0,
  reply: 5.0,
  reply_from_mutual_follow: 20.0, // 5 + BidirectionalFollowReplyWeightBoost 15
  quote: 5.0,
  share_via_dm: 5.0,
  follow_author: 4.0,
  share: 2.0,
  repost: 1.0,
  favorite: 0.5,
  click: 0.4,
  open_link: 0.2,
  photo_expand: 0.05,
  video_open: 0.05,
  video_quality_view: 0.05, // only if video > 10s (MinVideoDurationMs=10_000, strict >)
  dwell_per_second: 0.004,
  not_dwelled: -0.02,
  block_author: -31.2,
  not_interested: -43.2,
  mute_author: -58.8,
  report: -234.0,
} as const;

export const ALGO = {
  MAX_POST_AGE_HOURS: 48, // home-mixer/params/config.rs MAX_POST_AGE
  COLD_START_FOLLOWER_CAP: 1000, // param.rs ColdStartFollowerCap
  COLD_START_VIEW_THRESHOLD: 1000, // param.rs ColdStartImpressionThreshold
  COLD_START_MAX_AGE_HOURS: 24, // param.rs ColdStartMaxPostAgeSecs
  COLD_START_TARGET_SLOT: 15, // param.rs ColdStartSlotMin/Max
  MIN_VIDEO_SECONDS_EXCLUSIVE: 10, // param.rs MinVideoDurationMs (strict >)
  OON_DISCOUNT: 0.75, // param.rs OonWeightFactor
  AUTHOR_DIVERSITY_DECAY: 0.5, // param.rs
  AUTHOR_DIVERSITY_FLOOR: 0.25,
  MENTION_SPAM_TRIGGER: 2, // grox/flows/ptos/task_filter.py MIN_MENTION_COUNT
  REPLY_LLM_SCORED_ABOVE_FOLLOWERS: 60_000, // grox/flows/reply_spam/task_filter.py
  SIMCLUSTERS_MIN_FOLLOWERS: 400, // simclusters UpdateKnownFor20M145K2020 minActiveFollowers
  OON_CORPUS: '1fav_1day', // phoenix/xrex/data/retrieval_dataset.py
  POST_UNEXPLORED_TARGET_FRACTION: 0.03, // phoenix recsys_batch.py
} as const;

// ---------------------------------------------------------------------------
// Text analysis
// ---------------------------------------------------------------------------
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|dev|co|app|xyz|me|so|to|gg|sh)\b(?:\/[^\s<>"')\]]*)?/gi;
const MENTION_RE = /(^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{1,15})\b/g;
const HASHTAG_RE = /(^|[^A-Za-z0-9_&])#([\p{L}\p{N}_]+)/gu;
const BAIT_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\b(like|rt|retweet|repost|share|follow|comment|reply)\s+(if|for|to|and|this)\b/i, label: 'engagement-bait phrasing' },
  { re: /\b(tag|mention)\s+(a|someone|your|3|three|5|five)\b/i, label: 'tag-someone bait' },
  { re: /\bfollow\s*(me|back|4|for)\s*(follow|back|f4f)?/i, label: 'follow-for-follow' },
  { re: /\b(giveaway|to enter|to win|drop your)\b/i, label: 'giveaway / drop-your bait' },
  { re: /\bwho('s| is) with me\b|\bagree\?\s*$/i, label: 'agree/who-is-with-me bait' },
  { re: /\bthread\s*🧵|\b1\/\d+\b|\(1\/\d+\)/i, label: 'thread marker (threads do not multiply reach — one post per conversation ships)' },
];

export interface DraftAnalysis {
  chars: number; // weighted like X counts (URLs=23, wide chars=2)
  raw_chars: number;
  limit: number;
  over_limit: boolean;
  mentions: string[];
  hashtags: string[];
  urls: string[];
  has_url: boolean;
  post_cost_usd: number;
  is_question: boolean;
  has_numbers: boolean;
  bait: string[];
  all_caps_ratio: number;
  /** Which ranking heads this draft plausibly targets, best-first. */
  targets: { head: keyof typeof WEIGHTS; weight: number; why: string }[];
  warnings: string[];
  suggestions: string[];
  /** 0–100 heuristic. Explainable, not predictive: it counts rule hits, it does not model the viewer. */
  score: number;
}

/** Weighted length: URLs count as 23, astral/CJK/emoji as 2, everything else 1. */
export function weightedLength(text: string): number {
  let t = text.replace(URL_RE, 'x'.repeat(23));
  let n = 0;
  for (const ch of t) {
    const cp = ch.codePointAt(0)!;
    // Ranges X counts double: CJK, Hangul, emoji/astral. Approximation of twitter-text.
    n += cp > 0x1100 && !(cp >= 0x2000 && cp <= 0x206f) ? 2 : 1;
  }
  return n;
}

export function extractMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) out.push(m[2]!);
  return out;
}
export function extractUrls(text: string): string[] {
  return [...text.matchAll(URL_RE)].map((m) => m[0]);
}
export function extractHashtags(text: string): string[] {
  return [...text.matchAll(HASHTAG_RE)].map((m) => m[2]!);
}

export interface AnalyzeOptions {
  /** Premium long-post limit if the account has it (25_000); default 280. */
  limit?: number;
  kind?: 'original' | 'reply' | 'quote';
  /** Author's follower count if known — for cold-start / SimClusters advice. */
  myFollowers?: number;
}

export function analyzeDraft(text: string, opts: AnalyzeOptions = {}): DraftAnalysis {
  const limit = opts.limit ?? 280;
  const kind = opts.kind ?? 'original';
  const mentions = extractMentions(text);
  const urls = extractUrls(text);
  const hashtags = extractHashtags(text);
  const chars = weightedLength(text);
  const has_url = urls.length > 0;
  const bait = BAIT_PATTERNS.filter((b) => b.re.test(text)).map((b) => b.label);
  const is_question = /\?\s*$/m.test(text.trim()) || /\?(\s|$)/.test(text.slice(-40));
  const has_numbers = /\d/.test(text) && /\d+(\.\d+)?\s*(tok\/s|%|x|ms|s|gb|k|m|\$|fps|tokens|hours?|days?|min)/i.test(text) || /\d{2,}/.test(text);
  const letters = text.replace(/[^A-Za-z]/g, '');
  const caps = text.replace(/[^A-Z]/g, '');
  const all_caps_ratio = letters.length ? caps.length / letters.length : 0;

  const warnings: string[] = [];
  const suggestions: string[] = [];
  const targets: DraftAnalysis['targets'] = [];

  if (chars > limit) warnings.push(`Over the ${limit}-character limit (${chars} weighted). URLs count as 23.`);
  if (mentions.length >= ALGO.MENTION_SPAM_TRIGGER)
    warnings.push(
      `${mentions.length} @-mentions: posts with ≥2 mentions are routed into real-time LLM spam classification (grox/flows/ptos/task_filter.py MIN_MENTION_COUNT=2). Keep to one; put extra credits in a reply.`,
    );
  if (has_url)
    warnings.push(
      `Contains a URL: post creation costs $${PRICE['post.create_with_url'].toFixed(2)} instead of $${PRICE['post.create']} (X pay-per-use). Ranking has no link penalty (OpenLinkWeight=0.2), only URL *reputation* verdicts hurt — avoid shorteners/redirect chains.`,
    );
  if (bait.length)
    warnings.push(
      `Engagement-bait signals: ${bait.join('; ')}. SpamEngagementBaiting/Farming → SPAM_HIGH_RECALL is applied to *everyone*, no high-PageRank exemption (task_write_safety_post_annotations_result_sink.py:235-247). This hides the post from non-followers.`,
    );
  if (hashtags.length > 2) warnings.push(`${hashtags.length} hashtags: hashtags are not a model input; hashtag abuse is a spam category. Drop them.`);
  if (all_caps_ratio > 0.5 && letters.length > 20) warnings.push('Mostly caps — reads as shouting; not a ranking input but drives mute/block predictions.');

  // Heads this draft plausibly targets.
  if (has_numbers) targets.push({ head: 'share_via_copy_link', weight: WEIGHTS.share_via_copy_link, why: 'concrete numbers/receipts are what people copy-link and DM' });
  if (is_question) targets.push({ head: 'reply', weight: WEIGHTS.reply, why: 'ends on a question — invites replies (5.0, 20.0 from mutuals)' });
  if (kind === 'quote') targets.push({ head: 'quote', weight: WEIGHTS.quote, why: 'quote tweets are originals to the algorithm and sit in the quoted thread\'s Quotes tab' });
  if (/\b(I|we)\s+(built|made|shipped|wrote|measured|tested|ran)\b/i.test(text)) targets.push({ head: 'follow_author', weight: WEIGHTS.follow_author, why: 'builder/receipt voice converts profile visits into follows' });
  if (has_url) targets.push({ head: 'open_link', weight: WEIGHTS.open_link, why: 'link present (small weight)' });
  targets.sort((a, b) => b.weight - a.weight);

  if (!is_question && kind === 'original') suggestions.push('End on a real question to invite replies — reply weight is 10× a like.');
  if (!has_numbers && kind === 'original') suggestions.push('Add one concrete number or before/after — receipts get copy-linked (weight 20).');
  if (kind === 'reply' && chars < 40) suggestions.push('Short replies under big accounts get LLM-scored 0–3; a 0 earns RiskyHighVizReply. Add substance (a number, a correction, a real question).');
  if (opts.myFollowers !== undefined && opts.myFollowers <= ALGO.COLD_START_FOLLOWER_CAP && kind !== 'reply')
    suggestions.push(`You are under ${ALGO.COLD_START_FOLLOWER_CAP} followers: this original is cold-start eligible (forced slot ~15) for 24h while it has <1000 views. Post when your audience is awake.`);

  let score = 60;
  score += is_question ? 10 : 0;
  score += has_numbers ? 10 : 0;
  score += kind === 'quote' ? 5 : 0;
  score -= bait.length * 25;
  score -= mentions.length >= 2 ? 15 : 0;
  score -= chars > limit ? 40 : 0;
  score -= hashtags.length > 2 ? 10 : 0;
  score = Math.max(0, Math.min(100, score));

  return {
    chars,
    raw_chars: text.length,
    limit,
    over_limit: chars > limit,
    mentions,
    hashtags,
    urls,
    has_url,
    post_cost_usd: has_url ? PRICE['post.create_with_url'] : PRICE['post.create'],
    is_question,
    has_numbers,
    bait,
    all_caps_ratio: Number(all_caps_ratio.toFixed(2)),
    targets,
    warnings,
    suggestions,
    score,
  };
}

// ---------------------------------------------------------------------------
// Behavioural guardrails
// ---------------------------------------------------------------------------
export function hoursSince(ts: number | undefined, now = Date.now()): number {
  return ts === undefined ? Infinity : (now - ts) / 3_600_000;
}

/** Author-diversity: 2nd post in a slate ×0.625, 3rd ×0.4375 … (ranking_scorer.rs:643-645). */
export function diversityMultiplier(k: number): number {
  return (1 - ALGO.AUTHOR_DIVERSITY_FLOOR) * Math.pow(ALGO.AUTHOR_DIVERSITY_DECAY, k) + ALGO.AUTHOR_DIVERSITY_FLOOR;
}

export function shingles(text: string, n = 2): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  if (words.length < n) {
    if (words.length) out.add(words.join(' '));
    return out;
  }
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Copypasta guard: refuse near-duplicate replies (BBQDuplicateTextRepliesProd → COPYPASTA_SPAM). */
export function findCopypasta(
  text: string,
  recent: { text: string; ts: number; post_id: string }[],
  threshold: number,
  lookbackMs: number,
  now = Date.now(),
): { text: string; post_id: string; similarity: number } | undefined {
  const mine = shingles(text);
  let best: { text: string; post_id: string; similarity: number } | undefined;
  // recent is append-ordered: walk from the end and stop at the lookback cutoff.
  for (let i = recent.length - 1; i >= 0; i--) {
    const r = recent[i]!;
    if (now - r.ts > lookbackMs) break;
    const sim = jaccard(mine, shingles(r.text));
    if (sim >= threshold && (!best || sim > best.similarity)) best = { text: r.text, post_id: r.post_id, similarity: Number(sim.toFixed(2)) };
  }
  return best;
}

// ---------------------------------------------------------------------------
// The API boundary rule the whole server is built around (X self-serve, 2026-02-23):
// a programmatic reply is accepted only if the target post's author "summoned" you.
// ---------------------------------------------------------------------------
export interface SummonablePost {
  text: string;
  author_id?: string;
  in_reply_to_user_id?: string;
  entities?: { mentions?: { username: string }[] };
}
export function summonedBy(post: SummonablePost, me: { id: string; username: string }): { summoned: boolean; via: 'mention' | 'reply_to_me' | 'own_post' | 'none' } {
  if (post.author_id === me.id) return { summoned: true, via: 'own_post' };
  if (post.in_reply_to_user_id === me.id) return { summoned: true, via: 'reply_to_me' };
  const handle = me.username.toLowerCase();
  const mentioned = (post.entities?.mentions ?? []).some((m) => m.username?.toLowerCase() === handle) || extractMentions(post.text).some((m) => m.toLowerCase() === handle);
  return mentioned ? { summoned: true, via: 'mention' } : { summoned: false, via: 'none' };
}

export function isMutual(connection: string[] | undefined): boolean {
  return Boolean(connection?.includes('following') && connection.includes('followed_by'));
}

/** Video-quality-view head only counts when duration is strictly > 10s. */
export function videoGate(seconds: number | undefined): { ok: boolean; reason: string } {
  if (seconds === undefined) return { ok: true, reason: 'duration unknown (ffprobe not available) — make sure it is longer than 10 seconds' };
  if (seconds > ALGO.MIN_VIDEO_SECONDS_EXCLUSIVE) return { ok: true, reason: `${seconds.toFixed(1)}s > 10s: counts for the video head and the video retrieval corpora` };
  return {
    ok: false,
    reason: `${seconds.toFixed(1)}s ≤ 10s: video-quality-view weight is 0 and the post is excluded from every video corpus (candidates_util.rs:19-40, MinVideoDurationMs=10000 strict >). Extend the clip past 10s.`,
  };
}

export type AuthorBand = 'peer_small' | 'mid' | 'large';
export function authorBand(followers: number | undefined): { band: AuthorBand; note: string } {
  if (followers === undefined) return { band: 'mid', note: 'follower count unknown' };
  if (followers <= ALGO.COLD_START_FOLLOWER_CAP) return { band: 'peer_small', note: '≤1k followers: cold-start peer; replies here are not LLM-scored; small accounts follow back most' };
  if (followers <= ALGO.REPLY_LLM_SCORED_ABOVE_FOLLOWERS) return { band: 'mid', note: '≤60k followers: replies here are NOT LLM-ranked (low blast radius); good conversion' };
  return { band: 'large', note: '>60k followers: replies here ARE LLM-scored 0–3 — bring a number, a correction or a real question; a 0 gets RiskyHighVizReply' };
}

// ---------------------------------------------------------------------------
// Post lifecycle in algorithm terms
// ---------------------------------------------------------------------------
export interface Milestones {
  age_hours: number;
  in_feed_window: boolean; // < 48h
  cold_start_window_open: boolean; // < 24h and views < 1000 (author ≤1k)
  entered_oon_corpus: boolean; // ≥ 1 like within 24h
  cold_start_ended_by_views: boolean;
  next_reindex_at_likes: number | undefined; // power-of-two milestone
  notes: string[];
}

export function milestones(
  createdAt: number,
  latest: { likes: number; impressions?: number } | undefined,
  myFollowers: number | undefined,
  now = Date.now(),
): Milestones {
  const age = hoursSince(createdAt, now);
  const likes = latest?.likes ?? 0;
  const views = latest?.impressions;
  const notes: string[] = [];
  const in_feed_window = age < ALGO.MAX_POST_AGE_HOURS;
  const smallAuthor = myFollowers === undefined || myFollowers <= ALGO.COLD_START_FOLLOWER_CAP;
  const cold_start_ended_by_views = views !== undefined && views >= ALGO.COLD_START_VIEW_THRESHOLD;
  const cold_start_window_open = smallAuthor && age < ALGO.COLD_START_MAX_AGE_HOURS && !cold_start_ended_by_views;
  const entered_oon_corpus = likes >= 1 && age < 24;
  let next = 1;
  while (next <= likes) next *= 2;
  if (!in_feed_window) notes.push('Older than 48h: out of the For You candidate pool entirely (AgeFilter).');
  else if (age >= 24) notes.push('Past 24h: out of the 1fav_1day OON corpus and the cold-start window; only followers (Thunder) can still surface it until 48h.');
  if (likes === 0 && age < 24) notes.push('No favorites yet: not in the out-of-network retrieval corpus. One like from one real viewer opens the door.');
  if (entered_oon_corpus) notes.push(`In the OON corpus. Next re-index fires at ${next} likes (power-of-two milestones, ≥1 min apart).`);
  if (cold_start_window_open) notes.push('Cold-start eligible: can be force-lifted to slot ~15 in feeds where it is scored in the top 85%.');
  if (cold_start_ended_by_views) notes.push('≥1000 views: cold-start lift no longer applies; it now competes on score alone.');
  return {
    age_hours: Number(age.toFixed(1)),
    in_feed_window,
    cold_start_window_open,
    entered_oon_corpus,
    cold_start_ended_by_views,
    next_reindex_at_likes: age < 48 ? next : undefined,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Brand book checks (the persistent voice/lane/banned-words config)
// ---------------------------------------------------------------------------
export function brandCheck(brand: Brand, text: string): { banned_hits: string[]; reminders: string[] } {
  const lower = text.toLowerCase();
  const banned_hits = brand.banned.filter((w) => w && lower.includes(w.toLowerCase()));
  const reminders: string[] = [];
  if (brand.lane) reminders.push(`Lane: ${brand.lane}`);
  for (const v of brand.voice.slice(0, 6)) reminders.push(`Voice: ${v}`);
  return { banned_hits, reminders };
}
