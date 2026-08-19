/**
 * OAuth 2.0 Authorization Code + PKCE for the X API.
 * Docs: https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code
 *  - authorize: https://x.com/i/oauth2/authorize
 *  - token:     https://api.x.com/2/oauth2/token   (form-encoded)
 *  - access tokens live 2h; `offline.access` yields a refresh token.
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { Config } from '../config.js';
import type { Store, Tokens } from '../store.js';

export const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
export const REVOKE_URL = 'https://api.x.com/2/oauth2/revoke';

/** Scopes this server needs. Follows/likes/quotes are Enterprise-only on pay-per-use, so we do not ask for them. */
export const SCOPES = [
  'tweet.read',
  'tweet.write',
  'users.read',
  'follows.read',
  'offline.access',
  'media.write',
  'bookmark.read',
  'bookmark.write',
  'like.read',
  'dm.read',
  'dm.write',
  'list.read',
  'list.write',
];

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Confidential clients authenticate with Basic; public clients put client_id in the form. */
function clientAuth(cfg: Config, form: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (cfg.clientSecret) headers.Authorization = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`;
  else form.client_id = cfg.clientId;
  return headers;
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function buildAuthorizeUrl(cfg: Config, state: string, challenge: string, scopes = SCOPES): string {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('scope', scopes.join(' '));
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

async function tokenRequest(cfg: Config, form: Record<string, string>): Promise<Tokens> {
  const headers = clientAuth(cfg, form);
  const res = await fetch(TOKEN_URL, { method: 'POST', headers, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(cfg.requestTimeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`OAuth token request failed (${res.status}): ${text.slice(0, 500)}`);
  const j = JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string };
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (j.expires_in ?? 7200) * 1000,
    scope: j.scope,
    token_type: j.token_type,
  };
}

export async function exchangeCode(cfg: Config, code: string, verifier: string): Promise<Tokens> {
  return tokenRequest(cfg, { grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri, code_verifier: verifier });
}

export async function refreshTokens(cfg: Config, refreshToken: string): Promise<Tokens> {
  const t = await tokenRequest(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken });
  // Some providers rotate refresh tokens; keep the old one if a new one is not returned.
  if (!t.refresh_token) t.refresh_token = refreshToken;
  return t;
}

export async function revokeToken(cfg: Config, token: string): Promise<void> {
  const form: Record<string, string> = { token, token_type_hint: 'access_token' };
  const headers = clientAuth(cfg, form);
  await fetch(REVOKE_URL, { method: 'POST', headers, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(cfg.requestTimeoutMs) });
}

/**
 * Interactive login: opens the browser (or prints the URL), runs a one-shot local
 * callback server on cfg.callbackPort, exchanges the code, stores tokens.
 */
export async function loginInteractive(cfg: Config, store: Store): Promise<Tokens> {
  if (!cfg.clientId) throw new Error('X_CLIENT_ID is not set. Create an app in https://console.x.com and set X_CLIENT_ID (and X_CLIENT_SECRET for confidential apps).');
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString('base64url');
  const url = buildAuthorizeUrl(cfg, state, challenge);
  const redirect = new URL(cfg.redirectUri);
  const port = Number(redirect.port || cfg.callbackPort);
  const path = redirect.pathname || '/callback';

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (u.pathname !== path) {
        res.writeHead(404).end('not found');
        return;
      }
      const err = u.searchParams.get('error');
      const gotState = u.searchParams.get('state');
      const gotCode = u.searchParams.get('code');
      if (gotState !== state) {
        // Wrong/missing state: answer 400 but keep listening — a stray request must not be able to kill the login window.
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('state mismatch');
        return;
      }
      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(`<h2>Authorization failed</h2><p>${escapeHtml(err)}: ${escapeHtml(u.searchParams.get('error_description') ?? '')}</p>`);
        server.close();
        reject(new Error(`OAuth error: ${err}`));
        return;
      }
      if (!gotCode) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('missing code');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h2>x-mcp is connected.</h2><p>You can close this tab and go back to the terminal.</p>');
      server.close();
      resolve(gotCode);
    });
    server.listen(port, '127.0.0.1', () => {
      console.error(`\nOpen this URL to authorize x-mcp:\n\n  ${url}\n`);
      import('node:child_process').then(({ spawn }) => {
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        try {
          spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
        } catch {
          /* fall back to printed URL */
        }
      });
    });
    const t = setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for the OAuth callback'));
    }, 5 * 60_000);
    t.unref();
  });

  // Auth codes expire in 30 seconds — exchange immediately.
  const tokens = await exchangeCode(cfg, code, verifier);
  store.saveTokens(tokens);
  return tokens;
}

/** Returns a valid access token, refreshing when within 2 minutes of expiry. */
export async function getAccessToken(cfg: Config, store: Store): Promise<Tokens> {
  const t = store.loadTokens();
  if (!t?.access_token) throw new Error('Not logged in. Run `x-mcp login` once to authorize this account.');
  if (Date.now() < t.expires_at - 120_000) return t;
  if (!t.refresh_token) throw new Error('Access token expired and no refresh token stored (offline.access scope missing). Run `x-mcp login` again.');
  const fresh = await refreshTokens(cfg, t.refresh_token);
  const merged: Tokens = { ...t, ...fresh };
  store.saveTokens(merged);
  return merged;
}
