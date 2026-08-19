import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { connectInMemory, Ctx, loadConfig, Store } from '../src/index.js';

// ---- mock X API -------------------------------------------------------------
let created: { id: string; body: any }[] = [];
let nextId = 9000;
const ME = { id: '42', username: 'rtresearching', name: 'Ryan', public_metrics: { followers_count: 12, following_count: 30, tweet_count: 3 } };
const OTHER = { id: '77', username: 'yume_arasaki', public_metrics: { followers_count: 120000, following_count: 500, tweet_count: 900 } };
const PEER = { id: '88', username: 'small_dev', public_metrics: { followers_count: 300, following_count: 200, tweet_count: 50 }, connection_status: ['following', 'followed_by'] };

function post(id: string, author: any, text: string, extra: any = {}) {
  return { id, text, author_id: author.id, created_at: new Date(Date.now() - 3_600_000).toISOString(), conversation_id: extra.conversation_id ?? id, public_metrics: { like_count: 5, reply_count: 2, retweet_count: 1, quote_count: 0, impression_count: 300 }, ...extra };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url!, 'http://x');
  const send = (code: number, body: any) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'x-rate-limit-limit': '100', 'x-rate-limit-remaining': '99', 'x-rate-limit-reset': String(Math.floor(Date.now() / 1000) + 900) });
    res.end(JSON.stringify(body));
  };
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    if (req.method === 'GET' && u.pathname === '/2/users/me') return send(200, { data: ME });
    if (req.method === 'GET' && u.pathname === '/2/users/42/tweets') return send(200, { data: [post('1001', ME, 'my first post 13.7 tok/s'), post('1002', ME, 'quote of yume', { referenced_tweets: [{ type: 'quoted', id: '555' }] })], includes: { users: [ME] } });
    if (req.method === 'GET' && u.pathname === '/2/users/42/mentions') return send(200, { data: [post('2001', PEER, '@rtresearching which config?', { in_reply_to_user_id: '42', conversation_id: '1001', referenced_tweets: [{ type: 'replied_to', id: '1001' }] })], includes: { users: [PEER] } });
    if (req.method === 'GET' && u.pathname === '/2/users/42/following') return send(200, { data: [OTHER] });
    if (req.method === 'GET' && u.pathname === '/2/tweets') {
      const ids = (u.searchParams.get('ids') ?? '').split(',');
      const all: Record<string, any> = { '2001': post('2001', PEER, '@rtresearching which config?', { in_reply_to_user_id: '42', entities: { mentions: [{ username: 'rtresearching', id: '42' }] } }), '3001': post('3001', OTHER, 'M4 Pro does 25-27 tok/s') };
      return send(200, { data: ids.map((i) => all[i]).filter(Boolean), includes: { users: [PEER, OTHER] } });
    }
    if (req.method === 'GET' && u.pathname === '/2/tweets/search/recent') return send(200, { data: [post('3001', OTHER, 'Anyone benchmarked Qwen 3.8 on M4 Pro?'), post('3002', PEER, 'local llm on mac mini, thoughts?')], includes: { users: [OTHER, PEER] }, meta: { result_count: 2 } });
    if (req.method === 'POST' && u.pathname === '/2/tweets') {
      if (body.reply?.in_reply_to_tweet_id === '3001') return send(403, { detail: 'You are not permitted to reply to this post (not summoned).' });
      const id = String(nextId++);
      created.push({ id, body });
      return send(201, { data: { id, text: body.text } });
    }
    if (req.method === 'GET' && u.pathname === '/2/users/by/username/small_dev') return send(200, { data: PEER });
    send(404, { detail: `no mock for ${req.method} ${u.pathname}` });
  });
});

let base = '';
let dir = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  dir = mkdtempSync(join(tmpdir(), 'x-mcp-test-'));
  process.env.X_CLIENT_ID = 'test-client';
  process.env.X_API_BASE = base;
  process.env.X_MCP_ALLOW_CUSTOM_API_BASE = '1';
  process.env.X_MCP_STATE_DIR = dir;
  process.env.X_MCP_MEDIA_ROOT = join(dir, 'media');
  process.env.X_MCP_MONTHLY_BUDGET_USD = '5';
  process.env.X_MCP_MIN_HOURS_BETWEEN_ORIGINALS = '0';
  process.env.X_MCP_REQUIRE_APPROVAL = 'false';
  mkdirSync(join(dir, 'media'), { recursive: true });
  writeFileSync(join(dir, 'media', 'ok.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dir, 'outside.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const store = new Store(dir);
  store.saveTokens({ access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3_600_000, scope: 'tweet.read tweet.write users.read offline.access media.write' });
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const text = (r: any) => r.content.map((c: any) => c.text).join('\n');

describe('x-mcp end to end (mock X API)', () => {
  it('lists the tool surface, resources and prompt', async () => {
    const { client, close } = await connectInMemory();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(['account_pulse', 'approvals', 'conversation', 'delete_post', 'dm', 'doctor', 'draft_check', 'handoff', 'inbox', 'post_performance', 'publish', 'reply', 'repost', 'scout', 'spend', 'who']);
    const res = await client.listResources();
    expect(res.resources.map((r) => r.uri).sort()).toEqual(['x://boundary', 'x://handoff', 'x://playbook']);
    const pb = await client.readResource({ uri: 'x://playbook' });
    expect((pb.contents[0] as any).text).toContain('Ten rules');
    const prompts = await client.listPrompts();
    expect(prompts.prompts[0]?.name).toBe('operate');
    await close();
  });

  it('draft_check is free and catches bait + mentions + URL cost', async () => {
    const { client, close } = await connectInMemory();
    const r = await client.callTool({ name: 'draft_check', arguments: { text: 'RT if you agree @a @b https://example.com' } });
    const s = r.structuredContent as any;
    expect(s.draft.bait.length).toBeGreaterThan(0);
    expect(s.draft.mentions).toEqual(['a', 'b']);
    expect(s.draft.post_cost_usd).toBe(0.2);
    const spend = await client.callTool({ name: 'spend', arguments: {} });
    expect((spend.structuredContent as any).summary.spent_usd).toBe(0);
    await close();
  });

  it('account_pulse reads owned data, records $0.001 reads, and surfaces the inbox', async () => {
    const { client, close } = await connectInMemory();
    const r = await client.callTool({ name: 'account_pulse', arguments: {} });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as any;
    expect(s.me.username).toBe('rtresearching');
    expect(s.posts.length).toBe(2);
    expect(s.inbox.length).toBe(1);
    expect(s.inbox[0].author.band).toBe('peer_small');
    expect(text(r)).toContain('Inbox');
    await close();
  });

  it('publish: dry run, then real post with cost + milestones; second original blocked by spacing when configured', async () => {
    const { client, close } = await connectInMemory();
    const dry = await client.callTool({ name: 'publish', arguments: { text: 'Built my own local LLM runner. 13.7 → 25-30 tok/s on an M4 Pro. what should I run next?', dry_run: true } });
    expect((dry.structuredContent as any).posted).toBe(false);
    expect((dry.structuredContent as any).analysis.score).toBeGreaterThanOrEqual(80);
    const real = await client.callTool({ name: 'publish', arguments: { text: 'Built my own local LLM runner. 13.7 → 25-30 tok/s on an M4 Pro. what should I run next?', thread: ['stack: Swift, no deps, mtplx + llama.cpp'] } });
    const s = real.structuredContent as any;
    expect(s.posted).toBe(true);
    expect(s.thread.length).toBe(1);
    expect(s.cost_usd).toBe(0.03);
    expect(created.at(-1)!.body.reply.in_reply_to_tweet_id).toBe(s.id);
    // bait is a hard stop
    const bait = await client.callTool({ name: 'publish', arguments: { text: 'like if you agree, RT for a chance to win' } });
    expect((bait.structuredContent as any).posted).toBe(false);
    expect(text(bait)).toContain('Engagement-bait');
    await close();
  });

  it('reply: allowed when summoned, refused (with intent link) when not, copypasta guarded', async () => {
    const { client, close } = await connectInMemory();
    const okr = await client.callTool({ name: 'reply', arguments: { post_id: '2001', text: 'the Optimized-Speed build; TTFT was 0.39s on a short prompt. what chip are you on?' } });
    expect((okr.structuredContent as any).sent).toBe(true);
    const again = await client.callTool({ name: 'reply', arguments: { post_id: '2001', text: 'the Optimized-Speed build; TTFT was 0.39s on a short prompt. what chip are you on?' } });
    expect((again.structuredContent as any).sent).toBe(false);
    expect(text(again)).toContain('Already replied');
    const cold = await client.callTool({ name: 'reply', arguments: { post_id: '3001', text: 'M4 Pro 48GB here, hit 30.5 with the MTP head' } });
    expect((cold.structuredContent as any).sent).toBe(false);
    expect(text(cold)).toContain('x.com/intent/post?in_reply_to=3001');
    await close();
  });

  it('scout ranks opportunities and marks them non-API-replyable; handoff creates intent links and reconciles', async () => {
    const { client, close } = await connectInMemory();
    const sc = await client.callTool({ name: 'scout', arguments: { query: 'M4 Pro qwen', max: 10 } });
    const opps = (sc.structuredContent as any).opportunities;
    expect(opps.length).toBe(2);
    expect(opps.every((o: any) => o.api_replyable === false)).toBe(true);
    expect(opps[0].intent_reply_url).toContain('x.com/intent/post');
    const add = await client.callTool({ name: 'handoff', arguments: { action: 'add', kind: 'quote', target_post_id: '555', target_username: 'yume_arasaki', text: 'M4 Pro 48GB here: 13.7 → 25–30 tok/s. your ladder holds.', why: 'rides the viral thread as an original' } });
    expect(text(add)).toContain('x.com/intent/post?text=');
    const follow = await client.callTool({ name: 'handoff', arguments: { action: 'add', kind: 'follow', target_username: 'yume_arasaki' } });
    expect(text(follow)).toContain('intent/follow?screen_name=yume_arasaki');
    const rec = await client.callTool({ name: 'handoff', arguments: { action: 'reconcile' } });
    const rs = rec.structuredContent as any;
    // mock timeline contains a quote of 555 and following contains yume → both resolved;
    // the cold_reply filed by the reply test (post 3001) stays pending.
    expect(rs.resolved.length).toBe(2);
    expect(rs.pending).toBe(1);
    const spend = await client.callTool({ name: 'spend', arguments: {} });
    expect((spend.structuredContent as any).summary.spent_usd).toBeGreaterThan(0);
    await close();
  });

  it('approval mode parks writes; force always parks; the CLI path (bypassApproval) executes them', async () => {
    const cfg = { ...loadConfig(), requireApproval: true };
    const store = new Store(dir);
    const a = await connectInMemory({ config: cfg, store });
    const q = await a.client.callTool({ name: 'publish', arguments: { text: 'queued post with a real number: 30.5 tok/s. thoughts?' } });
    expect(text(q)).toContain('Queued for human approval');
    const id = (q.structuredContent as any).queued.id as string;
    await a.close();
    // approval off, but force → still queued
    const b = await connectInMemory({ config: { ...cfg, requireApproval: false }, store });
    const f = await b.client.callTool({ name: 'publish', arguments: { text: 'forced post 30.5 tok/s?', force: true } });
    expect(text(f)).toContain('Queued for human approval');
    await b.close();
    // CLI path: human approved → executes even with force in args
    const ctx = new Ctx({ ...cfg, requireApproval: false }, store);
    ctx.bypassApproval = true;
    const c = await connectInMemory({ ctx });
    const item = store.s.queue.find((x) => x.id === id)!;
    const r = await c.client.callTool({ name: item.tool, arguments: item.args });
    expect((r.structuredContent as any).posted).toBe(true);
    await c.close();
  });

  it('security: numeric-id validation blocks path smuggling; media roots block arbitrary file reads; delete needs a known post', async () => {
    const { client, close } = await connectInMemory();
    const smuggle = await client.callTool({ name: 'delete_post', arguments: { post_id: '../lists/123', confirm: true } });
    expect(smuggle.isError).toBe(true);
    const outside = await client.callTool({ name: 'publish', arguments: { text: 'pic 30.5 tok/s?', media_paths: [join(dir, 'outside.png')], dry_run: true } });
    expect(text(outside)).toContain('outside the allowed media roots');
    const url = await client.callTool({ name: 'publish', arguments: { text: 'pic 30.5 tok/s?', media_paths: ['http://attacker.example/a.mp4'], dry_run: true } });
    expect(text(url)).toContain('absolute local file path');
    const inside = await client.callTool({ name: 'publish', arguments: { text: 'pic 30.5 tok/s?', media_paths: [join(dir, 'media', 'ok.png')], dry_run: true } });
    expect((inside.structuredContent as any).media[0].kind).toBe('image');
    expect((inside.structuredContent as any).problems).toEqual([]);
    const unknownDelete = await client.callTool({ name: 'delete_post', arguments: { post_id: '123456', confirm: true } });
    expect(unknownDelete.isError).toBe(true);
    expect(text(unknownDelete)).toContain('not one this server posted');
    await close();
  });

  it('cold reply files a handoff item the human can tap', async () => {
    const { client, close } = await connectInMemory();
    const list = await client.callTool({ name: 'handoff', arguments: { action: 'list' } });
    const items = (list.structuredContent as any).items as any[];
    expect(items.some((h) => h.kind === 'cold_reply' && h.target_post_id === '3001')).toBe(true);
    await close();
  });
});
