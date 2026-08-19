import { describe, expect, it } from 'vitest';
import {
  analyzeDraft,
  authorBand,
  summonedBy,
  diversityMultiplier,
  extractMentions,
  findCopypasta,
  milestones,
  videoGate,
  weightedLength,
} from '../src/rules.js';

describe('weightedLength', () => {
  it('counts URLs as 23', () => {
    expect(weightedLength('see https://huggingface.co/Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed now')).toBe(4 + 23 + 4);
  });
  it('counts emoji double', () => {
    expect(weightedLength('hi 🙏')).toBe(3 + 2);
  });
});

describe('analyzeDraft', () => {
  it('flags two mentions and a url', () => {
    const a = analyzeDraft('thanks @alice and @bob https://x.com/foo');
    expect(a.mentions).toEqual(['alice', 'bob']);
    expect(a.has_url).toBe(true);
    expect(a.post_cost_usd).toBe(0.2);
    expect(a.warnings.some((w) => w.includes('≥2 mentions'))).toBe(true);
  });
  it('detects engagement bait', () => {
    const a = analyzeDraft('Like if you agree, RT for a chance to win!');
    expect(a.bait.length).toBeGreaterThan(0);
    expect(a.score).toBeLessThan(40);
  });
  it('rewards receipts + question', () => {
    const a = analyzeDraft('13.7 tok/s plain vs 25–30 tok/s with the MTP head on an M4 Pro. what should I run next?');
    expect(a.has_numbers).toBe(true);
    expect(a.is_question).toBe(true);
    expect(a.targets[0]?.head).toBe('share_via_copy_link');
    expect(a.score).toBeGreaterThanOrEqual(80);
  });
  it('does not treat emails as mentions', () => {
    expect(extractMentions('mail me at ryan@example.com')).toEqual([]);
  });
});

describe('guards', () => {
  it('diversity multiplier matches the ranking formula', () => {
    expect(diversityMultiplier(0)).toBeCloseTo(1);
    expect(diversityMultiplier(1)).toBeCloseTo(0.625);
    expect(diversityMultiplier(2)).toBeCloseTo(0.4375);
  });
  it('video gate is strict >10s', () => {
    expect(videoGate(10).ok).toBe(false);
    expect(videoGate(10.5).ok).toBe(true);
    expect(videoGate(undefined).ok).toBe(true);
  });
  it('copypasta detection', () => {
    const now = Date.now();
    const recent = [{ text: 'great post, totally agree with this take on local models', ts: now - 1000, post_id: '1' }];
    expect(findCopypasta('great post, totally agree with this take on local models!', recent, 0.7, 86_400_000, now)).toBeDefined();
    expect(findCopypasta('your TTFT numbers on the 8K prompt are the real story here', recent, 0.7, 86_400_000, now)).toBeUndefined();
  });
  it('author bands', () => {
    expect(authorBand(500).band).toBe('peer_small');
    expect(authorBand(50_000).band).toBe('mid');
    expect(authorBand(100_000).band).toBe('large');
  });
});

describe('summonedBy', () => {
  const me = { id: '42', username: 'rtresearching' };
  it('mention in entities or text, reply to me, own post', () => {
    expect(summonedBy({ text: 'hey', entities: { mentions: [{ username: 'RTResearching' }] } }, me).via).toBe('mention');
    expect(summonedBy({ text: 'cc @rtresearching what do you think' }, me).via).toBe('mention');
    expect(summonedBy({ text: 'x', in_reply_to_user_id: '42' }, me).via).toBe('reply_to_me');
    expect(summonedBy({ text: 'x', author_id: '42' }, me).via).toBe('own_post');
    expect(summonedBy({ text: 'email rtresearching@example.com' }, me).summoned).toBe(false);
  });
});

describe('milestones', () => {
  it('reports OON entry and next reindex', () => {
    const now = Date.now();
    const m = milestones(now - 2 * 3_600_000, { likes: 5, impressions: 300 }, 40, now);
    expect(m.entered_oon_corpus).toBe(true);
    expect(m.cold_start_window_open).toBe(true);
    expect(m.next_reindex_at_likes).toBe(8);
  });
  it('closes cold start at 1000 views', () => {
    const now = Date.now();
    const m = milestones(now - 2 * 3_600_000, { likes: 50, impressions: 1200 }, 40, now);
    expect(m.cold_start_window_open).toBe(false);
    expect(m.cold_start_ended_by_views).toBe(true);
  });
});
