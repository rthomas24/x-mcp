/**
 * Thin, dependency-free X API v2 client with:
 *  - OAuth 2.0 user-context bearer (auto-refresh)
 *  - rate-limit header tracking + one polite retry on 429 when the reset is near
 *  - tolerant parsing of both naming generations (tweet.fields/post.fields,
 *    retweet_count/repost_count, referenced_tweets/referenced_posts, note_tweet/note_post)
 *  - normalized Post / User shapes the tools consume
 */
import type { Config } from '../config.js';
import type { Store } from '../store.js';
import { postUrl } from '../format.js';
import { getAccessToken } from './auth.js';

export class XApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly path: string,
  ) {
    super(message);
  }
}

export interface RateInfo {
  limit?: number;
  remaining?: number;
  reset?: number; // epoch seconds
}

export interface Post {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  lang?: string;
  referenced: { type: 'retweeted' | 'quoted' | 'replied_to'; id: string }[];
  metrics: { likes: number; replies: number; reposts: number; quotes: number; impressions?: number; bookmarks?: number };
  non_public?: { impression_count?: number; url_link_clicks?: number; user_profile_clicks?: number; engagements?: number };
  entities?: { urls?: { expanded_url?: string; url?: string; display_url?: string }[]; mentions?: { username: string; id?: string }[] };
  media_keys?: string[];
  possibly_sensitive?: boolean;
  url: string;
}

export interface User {
  id: string;
  username: string;
  name?: string;
  description?: string;
  created_at?: string;
  verified?: boolean;
  verified_type?: string;
  protected?: boolean;
  metrics: { followers: number; following: number; posts: number; listed?: number };
  connection?: string[]; // following, followed_by, blocking, muting, follow_request_sent...
  pinned_post_id?: string;
  url: string;
}

const POST_FIELDS = [
  'id',
  'text',
  'author_id',
  'created_at',
  'conversation_id',
  'in_reply_to_user_id',
  'lang',
  'public_metrics',
  'entities',
  'attachments',
  'possibly_sensitive',
  'referenced_tweets',
  'note_tweet',
];
const USER_FIELDS = ['id', 'name', 'username', 'description', 'created_at', 'public_metrics', 'verified', 'verified_type', 'protected', 'connection_status', 'pinned_tweet_id'];

type Json = Record<string, any>;

/** Build an API path from segments, encoding each one (ids come from the agent — never let `../` reach the URL). */
export const path = (...segs: (string | number)[]): string => `/2/${segs.map((x) => encodeURIComponent(String(x))).join('/')}`;

export class XClient {
  private rate = new Map<string, RateInfo>();
  /** 'tweet' (legacy prose docs) or 'post' (OpenAPI 2.167 / XDK). Flips automatically on a 400 that complains about fields. */
  private fieldStyle: 'tweet' | 'post' = 'tweet';

  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
  ) {}

  get rateSnapshot(): Record<string, RateInfo> {
    return Object.fromEntries(this.rate);
  }

  /** Every style-dependent query parameter lives here; callers only say what they want. */
  private fieldParams(opts: { nonPublic?: boolean } = {}): Record<string, string> {
    const style = this.fieldStyle;
    const pf = [...POST_FIELDS, ...(opts.nonPublic ? ['non_public_metrics'] : [])]
      .map((f) => (style === 'post' ? f.replace('referenced_tweets', 'referenced_posts').replace('note_tweet', 'note_post') : f))
      .join(',');
    const uf = USER_FIELDS.map((f) => (style === 'post' ? f.replace('pinned_tweet_id', 'pinned_post_id') : f)).join(',');
    return {
      [`${style}.fields`]: pf,
      'user.fields': uf,
      expansions: style === 'post' ? 'author_id,referenced_posts,attachments.media_keys,in_reply_to_user_id' : 'author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys,in_reply_to_user_id',
      'media.fields': 'media_key,type,duration_ms,url,preview_image_url,alt_text',
    };
  }

  private rateKey(method: string, path: string): string {
    return `${method} ${path.replace(/\/\d{5,}/g, '/:id')}`;
  }

  async request<T = Json>(
    method: 'GET' | 'POST' | 'DELETE' | 'PUT',
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; form?: FormData; withFields?: boolean | { nonPublic?: boolean }; retry?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const tokens = await getAccessToken(this.cfg, this.store);
    const url = new URL(`${this.cfg.apiBase}${path}`);
    const q = { ...(opts.withFields ? this.fieldParams(typeof opts.withFields === 'object' ? opts.withFields : {}) : {}), ...(opts.query ?? {}) };
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Authorization: `Bearer ${tokens.access_token}`, 'User-Agent': 'x-mcp/0.1' };
    let body: BodyInit | undefined;
    if (opts.form) body = opts.form;
    else if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? this.cfg.requestTimeoutMs) });
    const key = this.rateKey(method, url.pathname);
    const lim = res.headers.get('x-rate-limit-limit');
    const rem = res.headers.get('x-rate-limit-remaining');
    const rst = res.headers.get('x-rate-limit-reset');
    if (lim || rem || rst) this.rate.set(key, { limit: lim ? Number(lim) : undefined, remaining: rem ? Number(rem) : undefined, reset: rst ? Number(rst) : undefined });

    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      json = { raw: text };
    }

    if (res.status === 429 && opts.retry !== false) {
      const resetIn = rst ? Number(rst) * 1000 - Date.now() : NaN;
      if (Number.isFinite(resetIn) && resetIn > 0 && resetIn < 20_000) {
        await new Promise((r) => setTimeout(r, resetIn + 500));
        return this.request<T>(method, path, { ...opts, retry: false });
      }
      throw new XApiError(`Rate limited on ${key}${rst ? `; resets at ${new Date(Number(rst) * 1000).toISOString()}` : ''}`, 429, json, path);
    }
    if (res.status === 400 && opts.withFields && /fields|expansions/i.test(text) && opts.retry !== false) {
      // Naming-generation mismatch — flip and retry once.
      this.fieldStyle = this.fieldStyle === 'tweet' ? 'post' : 'tweet';
      return this.request<T>(method, path, { ...opts, retry: false });
    }
    if (!res.ok) {
      const detail = json.detail ?? json.title ?? json.errors?.[0]?.message ?? json.error_description ?? text.slice(0, 300);
      throw new XApiError(`X API ${res.status} on ${method} ${url.pathname}: ${detail}`, res.status, json, path);
    }
    return json as T;
  }

  // ---- normalization ------------------------------------------------------
  static normalizePost(raw: Json, includes?: Json): Post {
    const pm = raw.public_metrics ?? {};
    const refs = (raw.referenced_tweets ?? raw.referenced_posts ?? []) as { type: string; id: string }[];
    const note = raw.note_tweet?.text ?? raw.note_post?.text;
    const author = includes?.users?.find((u: Json) => u.id === raw.author_id);
    const handle = author?.username ?? 'i';
    return {
      id: String(raw.id),
      text: note ?? raw.text ?? '',
      author_id: raw.author_id,
      created_at: raw.created_at,
      conversation_id: raw.conversation_id,
      in_reply_to_user_id: raw.in_reply_to_user_id,
      lang: raw.lang,
      referenced: refs.map((r) => ({ type: r.type as Post['referenced'][number]['type'], id: String(r.id) })),
      metrics: {
        likes: pm.like_count ?? 0,
        replies: pm.reply_count ?? 0,
        reposts: pm.retweet_count ?? pm.repost_count ?? 0,
        quotes: pm.quote_count ?? 0,
        impressions: pm.impression_count,
        bookmarks: pm.bookmark_count,
      },
      non_public: raw.non_public_metrics,
      entities: raw.entities,
      media_keys: raw.attachments?.media_keys,
      possibly_sensitive: raw.possibly_sensitive,
      url: postUrl(handle, String(raw.id)),
    };
  }

  static normalizeUser(raw: Json): User {
    const pm = raw.public_metrics ?? {};
    return {
      id: String(raw.id),
      username: raw.username,
      name: raw.name,
      description: raw.description,
      created_at: raw.created_at,
      verified: raw.verified,
      verified_type: raw.verified_type,
      protected: raw.protected,
      metrics: { followers: pm.followers_count ?? 0, following: pm.following_count ?? 0, posts: pm.tweet_count ?? pm.post_count ?? 0, listed: pm.listed_count },
      connection: raw.connection_status,
      pinned_post_id: raw.pinned_tweet_id ?? raw.pinned_post_id,
      url: `https://x.com/${raw.username}`,
    };
  }

  static usersFrom(includes: Json | undefined): Map<string, User> {
    const m = new Map<string, User>();
    for (const u of includes?.users ?? []) m.set(String(u.id), XClient.normalizeUser(u));
    return m;
  }

  // ---- typed helpers ------------------------------------------------------
  async me(): Promise<User> {
    const j = await this.request('GET', '/2/users/me', { query: { 'user.fields': USER_FIELDS.filter((f) => f !== 'connection_status').join(',') } });
    return XClient.normalizeUser(j.data);
  }

  async userByUsername(username: string): Promise<User> {
    const j = await this.request('GET', path('users', 'by', 'username', username.replace(/^@/, '')), { query: { 'user.fields': USER_FIELDS.join(',') } });
    return XClient.normalizeUser(j.data);
  }

  async usersByIds(ids: string[]): Promise<User[]> {
    if (!ids.length) return [];
    const j = await this.request('GET', '/2/users', { query: { ids: ids.slice(0, 100).join(','), 'user.fields': USER_FIELDS.join(',') } });
    return (j.data ?? []).map(XClient.normalizeUser);
  }

  /** Owned read ($0.001/post). */
  async myPosts(userId: string, opts: { max?: number; since_id?: string; exclude?: string } = {}): Promise<{ posts: Post[]; users: Map<string, User>; next?: string }> {
    const j = await this.request('GET', path('users', userId, 'tweets'), {
      withFields: true,
      query: { max_results: Math.min(100, Math.max(5, opts.max ?? 20)), since_id: opts.since_id, exclude: opts.exclude },
    });
    return { posts: (j.data ?? []).map((p: Json) => XClient.normalizePost(p, j.includes)), users: XClient.usersFrom(j.includes), next: j.meta?.next_token };
  }

  /** Owned read ($0.001/post). */
  async mentions(userId: string, opts: { max?: number; since_id?: string } = {}): Promise<{ posts: Post[]; users: Map<string, User>; next?: string }> {
    const j = await this.request('GET', path('users', userId, 'mentions'), { withFields: true, query: { max_results: Math.min(100, Math.max(5, opts.max ?? 20)), since_id: opts.since_id } });
    return { posts: (j.data ?? []).map((p: Json) => XClient.normalizePost(p, j.includes)), users: XClient.usersFrom(j.includes), next: j.meta?.next_token };
  }

  /** Public read ($0.005/post). Own posts with non_public_metrics need user context. */
  async postsByIds(ids: string[], nonPublic = false): Promise<{ posts: Post[]; users: Map<string, User> }> {
    if (!ids.length) return { posts: [], users: new Map() };
    const j = await this.request('GET', '/2/tweets', { withFields: { nonPublic }, query: { ids: ids.slice(0, 100).join(',') } });
    return { posts: (j.data ?? []).map((p: Json) => XClient.normalizePost(p, j.includes)), users: XClient.usersFrom(j.includes) };
  }

  /** Public read ($0.005/post). */
  async searchRecent(query: string, opts: { max?: number; sort?: 'recency' | 'relevancy' } = {}): Promise<{ posts: Post[]; users: Map<string, User>; next?: string }> {
    const j = await this.request('GET', '/2/tweets/search/recent', {
      withFields: true,
      query: { query, max_results: Math.min(100, Math.max(10, opts.max ?? 20)), sort_order: opts.sort },
    });
    return { posts: (j.data ?? []).map((p: Json) => XClient.normalizePost(p, j.includes)), users: XClient.usersFrom(j.includes), next: j.meta?.next_token };
  }

  async createPost(body: Json): Promise<{ id: string; text: string }> {
    const j = await this.request('POST', '/2/tweets', { body });
    return { id: String(j.data.id), text: j.data.text };
  }

  async deletePost(id: string): Promise<boolean> {
    const j = await this.request('DELETE', path('tweets', id));
    return Boolean(j.data?.deleted);
  }

  async repost(userId: string, postId: string): Promise<boolean> {
    const j = await this.request('POST', path('users', userId, 'retweets'), { body: { tweet_id: postId } });
    return Boolean(j.data?.retweeted);
  }

  /** Owned read ($0.001/entry) when userId is me. */
  async following(userId: string, max = 1000): Promise<User[]> {
    const j = await this.request('GET', path('users', userId, 'following'), { query: { max_results: Math.min(1000, max), 'user.fields': 'id,username,name,public_metrics' } });
    return (j.data ?? []).map(XClient.normalizeUser);
  }

  /** Owned read ($0.001/entry). */
  async likedPostIds(userId: string, max = 100): Promise<string[]> {
    const j = await this.request('GET', path('users', userId, 'liked_tweets'), { query: { max_results: Math.min(100, max) } });
    return ((j.data ?? []) as { id: string }[]).map((p) => String(p.id));
  }

  async sendDm(participantId: string, text: string): Promise<{ dm_conversation_id: string; dm_event_id: string }> {
    const j = await this.request('POST', path('dm_conversations', 'with', participantId, 'messages'), { body: { text } });
    return j.data;
  }

  async dmEventsWith(participantId: string, max = 20): Promise<Json[]> {
    const j = await this.request('GET', path('dm_conversations', 'with', participantId, 'dm_events'), { query: { max_results: Math.min(100, max), 'dm_event.fields': 'id,text,created_at,sender_id,event_type', event_types: 'MessageCreate' } });
    return j.data ?? [];
  }
}
