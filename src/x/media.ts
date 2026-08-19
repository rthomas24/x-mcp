/**
 * Media: plan (validate) → upload via the v2 chunked endpoints
 * (https://docs.x.com/x-api/media/quickstart/media-upload-chunked):
 *   POST /2/media/upload/initialize → POST /2/media/upload/{id}/append (segments) →
 *   POST /2/media/upload/{id}/finalize → GET /2/media/upload?command=STATUS until succeeded.
 *
 * Security: the agent chooses the paths, so every path is realpath-resolved and must
 * live under one of cfg.mediaRoots; dotfiles, URLs/pseudo-protocols and symlink escapes
 * are rejected BEFORE any probe, read or upload. Files are streamed in 4 MiB segments —
 * a 500 MB video never sits in memory.
 */
import { execFile } from 'node:child_process';
import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { ALGO, videoGate } from '../rules.js';
import type { XClient } from './client.js';

const execFileP = promisify(execFile);
const SEGMENT = 4 * 1024 * 1024; // 4 MiB chunks (limit is 5 MiB per APPEND)
const MAX_BYTES = { image: 5 * 1024 * 1024, gif: 15 * 1024 * 1024, video: 512 * 1024 * 1024 } as const;

export type MediaKind = 'image' | 'gif' | 'video';
export type MediaCategory = 'tweet_image' | 'tweet_gif' | 'tweet_video';

export function mimeFor(p: string): { mime: string; category: MediaCategory; kind: MediaKind } {
  switch (extname(p).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return { mime: 'image/jpeg', category: 'tweet_image', kind: 'image' };
    case '.png':
      return { mime: 'image/png', category: 'tweet_image', kind: 'image' };
    case '.webp':
      return { mime: 'image/webp', category: 'tweet_image', kind: 'image' };
    case '.gif':
      return { mime: 'image/gif', category: 'tweet_gif', kind: 'gif' };
    case '.mp4':
    case '.m4v':
      return { mime: 'video/mp4', category: 'tweet_video', kind: 'video' };
    case '.mov':
      return { mime: 'video/quicktime', category: 'tweet_video', kind: 'video' };
    case '.webm':
      return { mime: 'video/webm', category: 'tweet_video', kind: 'video' };
    default:
      throw new Error(`Unsupported media extension in "${basename(p)}". Use jpg/png/webp/gif/mp4/mov/webm.`);
  }
}

export interface MediaItem {
  /** As given by the agent. */
  path: string;
  /** realpath — the file that will actually be read. */
  real: string;
  mime: string;
  category: MediaCategory;
  kind: MediaKind;
  bytes: number;
  duration_seconds?: number;
}

export interface MediaPlan {
  items: MediaItem[];
  /** Hard errors (wrong root, bad mix, too large) — the post must not go ahead. */
  problems: string[];
  /** Soft algorithm gate (≤10s video) — overridable with force. */
  gate?: ReturnType<typeof videoGate>;
  video_seconds?: number;
}

/** Resolve a path inside the allowed roots or explain why not. */
export function resolveMediaPath(p: string, roots: string[]): { real: string } | { error: string } {
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || !isAbsolute(p)) return { error: `"${p}" must be an absolute local file path (URLs and relative paths are rejected).` };
  if (basename(p).startsWith('.')) return { error: `"${basename(p)}" is a dotfile — refused.` };
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    return { error: `"${p}" does not exist or is not readable.` };
  }
  const inside = roots.some((r) => {
    try {
      const rr = realpathSync(resolve(r));
      return real === rr || real.startsWith(rr + sep);
    } catch {
      return false;
    }
  });
  if (!inside) return { error: `"${p}" is outside the allowed media roots (${roots.join(', ')}). Move the file there or set X_MCP_MEDIA_ROOT.` };
  if (!statSync(real).isFile()) return { error: `"${p}" is not a regular file.` };
  return { real };
}

/** Validate a set of paths against X's media rules and the allowed roots. Probes video duration only after the root check. */
export async function planMedia(paths: string[], opts: { roots: string[]; ffprobePath?: string }): Promise<MediaPlan> {
  const items: MediaItem[] = [];
  const problems: string[] = [];
  for (const p of paths) {
    const r = resolveMediaPath(p, opts.roots);
    if ('error' in r) {
      problems.push(r.error);
      continue;
    }
    let meta: ReturnType<typeof mimeFor>;
    try {
      meta = mimeFor(r.real);
    } catch (e) {
      problems.push((e as Error).message);
      continue;
    }
    const bytes = statSync(r.real).size;
    if (bytes > MAX_BYTES[meta.kind]) problems.push(`${basename(p)} is ${(bytes / 1e6).toFixed(1)} MB; the limit for ${meta.kind} is ${(MAX_BYTES[meta.kind] / 1e6).toFixed(0)} MB.`);
    items.push({ path: p, real: r.real, ...meta, bytes });
  }
  const videos = items.filter((m) => m.kind === 'video');
  const gifs = items.filter((m) => m.kind === 'gif');
  const images = items.filter((m) => m.kind === 'image');
  if (videos.length > 1 || gifs.length > 1 || (videos.length + gifs.length > 0 && images.length > 0) || (videos.length && gifs.length))
    problems.push('Media mix invalid: X allows up to 4 images OR 1 video OR 1 gif. Mixing a video with images also disqualifies the post from every video retrieval corpus.');
  let gate: MediaPlan['gate'];
  let video_seconds: number | undefined;
  if (videos.length === 1 && !problems.length) {
    const v = videos[0]!;
    video_seconds = await videoDurationSeconds(v.real, opts.ffprobePath);
    v.duration_seconds = video_seconds;
    if (video_seconds !== undefined && (video_seconds < 0.5 || video_seconds > 140)) problems.push(`Video is ${video_seconds.toFixed(1)}s; X accepts 0.5–140s.`);
    gate = videoGate(video_seconds);
  }
  return { items, problems, gate, video_seconds };
}

/** Duration in seconds via ffprobe, else MP4 mvhd atom, else undefined. */
export async function videoDurationSeconds(real: string, ffprobePath?: string): Promise<number | undefined> {
  try {
    const { stdout } = await execFileP(ffprobePath ?? 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', '--', real], { timeout: 15_000 });
    const n = Number(stdout.trim());
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* no ffprobe */
  }
  return mp4Duration(real);
}

/** Minimal MP4/MOV parser: find `moov` → `mvhd` and read timescale/duration. Reads only the atoms it needs. */
export function mp4Duration(real: string): number | undefined {
  let fd: number | undefined;
  try {
    const size = statSync(real).size;
    fd = openSync(real, 'r');
    const readAt = (pos: number, len: number): Buffer => {
      const b = Buffer.alloc(len);
      const n = readSync(fd!, b, 0, len, pos);
      return b.subarray(0, n);
    };
    const findAtom = (start: number, end: number, name: string): { pos: number; size: number; hdr: number } | undefined => {
      let pos = start;
      while (pos + 8 <= end) {
        const h = readAt(pos, 16);
        if (h.length < 8) return undefined;
        let asize = h.readUInt32BE(0);
        const type = h.toString('latin1', 4, 8);
        let hdr = 8;
        if (asize === 1) {
          asize = Number(h.readBigUInt64BE(8));
          hdr = 16;
        } else if (asize === 0) asize = end - pos;
        if (asize < hdr) return undefined;
        if (type === name) return { pos, size: asize, hdr };
        pos += asize;
      }
      return undefined;
    };
    const moov = findAtom(0, size, 'moov');
    if (!moov) return undefined;
    const mvhd = findAtom(moov.pos + moov.hdr, moov.pos + moov.size, 'mvhd');
    if (!mvhd) return undefined;
    const body = readAt(mvhd.pos + mvhd.hdr, 32);
    if (body.readUInt8(0) === 1) {
      const timescale = body.readUInt32BE(20);
      return timescale ? Number(body.readBigUInt64BE(24)) / timescale : undefined;
    }
    const timescale = body.readUInt32BE(12);
    return timescale ? body.readUInt32BE(16) / timescale : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface UploadResult {
  media_id: string;
  kind: MediaKind;
  bytes: number;
  duration_seconds?: number;
  processing_seconds: number;
}

/** Upload one planned item. Streams the file in segments; polls processing; applies alt text. */
export async function uploadMedia(client: XClient, item: MediaItem, opts: { altText?: string; onProgress?: (msg: string) => void } = {}): Promise<UploadResult> {
  const t0 = Date.now();
  const init = await client.request('POST', '/2/media/upload/initialize', { body: { media_type: item.mime, total_bytes: item.bytes, media_category: item.category } });
  const mediaId = String(init.data?.id ?? init.data?.media_id ?? init.media_id_string ?? init.media_id ?? '');
  if (!mediaId) throw new Error(`Media INIT returned no id: ${JSON.stringify(init).slice(0, 300)}`);
  opts.onProgress?.(`initialized media ${mediaId} (${(item.bytes / 1e6).toFixed(1)} MB)`);

  const fd = openSync(item.real, 'r');
  try {
    const segments = Math.ceil(item.bytes / SEGMENT);
    const buf = Buffer.alloc(SEGMENT);
    for (let seg = 0; seg < segments; seg++) {
      const n = readSync(fd, buf, 0, SEGMENT, seg * SEGMENT);
      const form = new FormData();
      form.set('segment_index', String(seg));
      form.set('media', new Blob([buf.subarray(0, n)], { type: item.mime }), `seg${seg}`);
      await client.request('POST', `/2/media/upload/${encodeURIComponent(mediaId)}/append`, { form, timeoutMs: 120_000 });
      opts.onProgress?.(`appended segment ${seg + 1}/${segments}`);
    }
  } finally {
    closeSync(fd);
  }

  const fin = await client.request('POST', `/2/media/upload/${encodeURIComponent(mediaId)}/finalize`);
  let info = fin.data?.processing_info ?? fin.processing_info;
  let waited = 0;
  while (info && info.state !== 'succeeded') {
    if (info.state === 'failed') throw new Error(`Media processing failed: ${JSON.stringify(info.error ?? info).slice(0, 300)}`);
    const wait = Math.min(15, Math.max(1, Number(info.check_after_secs ?? 2)));
    await new Promise((r) => setTimeout(r, wait * 1000));
    waited += wait;
    if (waited > 300) throw new Error('Media processing timed out after 5 minutes.');
    const st = await client.request('GET', '/2/media/upload', { query: { command: 'STATUS', media_id: mediaId } });
    info = st.data?.processing_info ?? st.processing_info;
    opts.onProgress?.(`processing… ${info?.progress_percent ?? '?'}%`);
  }

  if (opts.altText) {
    try {
      await client.request('POST', '/2/media/metadata', { body: { id: mediaId, metadata: { alt_text: { text: opts.altText.slice(0, 1000) } } } });
    } catch (e) {
      opts.onProgress?.(`alt text failed (non-fatal): ${(e as Error).message}`);
    }
  }
  return { media_id: mediaId, kind: item.kind, bytes: item.bytes, duration_seconds: item.duration_seconds, processing_seconds: Number(((Date.now() - t0) / 1000).toFixed(1)) };
}

export const VIDEO_GATE_SECONDS = ALGO.MIN_VIDEO_SECONDS_EXCLUSIVE;
