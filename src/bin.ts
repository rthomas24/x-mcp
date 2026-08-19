#!/usr/bin/env node
/**
 * x-mcp CLI
 *   x-mcp                      serve on stdio (default; for Hermes, Claude Code, Cursor …)
 *   x-mcp --http [--port N] [--token T]   localhost Streamable HTTP (token mandatory; generated if absent)
 *   x-mcp login | logout       OAuth 2.0 PKCE login for the account to operate
 *   x-mcp approve <id>|--all   execute queued actions (approval mode / force overrides)
 *   x-mcp queue                list queued API actions and the human handoff queue
 *   x-mcp spend | doctor       ledger / health
 */
import { loadConfig } from './config.js';
import { describeHandoff } from './format.js';
import { connectInMemory, resultText, serveXMcpHttp, serveXMcpStdio, VERSION } from './index.js';
import { Store } from './store.js';
import { Ctx } from './tools/context.js';
import { loginInteractive, revokeToken } from './x/auth.js';

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith('--') ? args[0] : 'serve';
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : undefined;
};

function help(): void {
  console.error(`x-mcp ${VERSION} — MCP server for running an X account with an agent

Usage:
  x-mcp                       stdio transport (default)
  x-mcp --http [--port 8478] [--token T]    (X_MCP_HTTP_TOKEN also works; a token is always required)
  x-mcp login                 authorize the account (OAuth 2.0 PKCE, opens browser)
  x-mcp logout                revoke + forget tokens
  x-mcp approve <id> | --all  execute queued actions (approval mode is the default)
  x-mcp queue                 show approval queue + human handoff queue with links
  x-mcp spend                 month-to-date spend
  x-mcp doctor                auth/config health

Env (read from the environment or <state dir>/.env — never from the current directory):
  X_CLIENT_ID (required)  X_CLIENT_SECRET (confidential apps only)
  X_REDIRECT_URI (default http://127.0.0.1:8477/callback — must be registered in the app)
  X_MCP_STATE_DIR=~/.x-mcp   X_MCP_MEDIA_ROOT=<state dir>/media[,more,dirs]
  X_MCP_MONTHLY_BUDGET_USD=25  X_MCP_REQUIRE_APPROVAL=true
  X_MCP_MIN_HOURS_BETWEEN_ORIGINALS=4  X_MCP_MAX_REPLIES_PER_HOUR=12  X_MCP_MAX_REPOSTS_PER_DAY=10  X_MCP_MAX_DMS_PER_HOUR=5
  X_MCP_MAX_READS_PER_CALL=100  X_MCP_REQUEST_TIMEOUT_MS=30000`);
}

async function main(): Promise<void> {
  if (args.includes('--help') || args.includes('-h') || cmd === 'help') return help();
  const cfg = loadConfig();

  if (cmd === 'login') {
    const store = new Store(cfg.stateDir);
    const t = await loginInteractive(cfg, store);
    console.error(`Logged in. Scopes: ${t.scope ?? '(unknown)'}. Tokens stored in ${cfg.stateDir}/tokens.json`);
    const { client, close } = await connectInMemory({ config: cfg, store });
    console.error(resultText(await client.callTool({ name: 'doctor', arguments: { verify_network: true } })));
    await close();
    return;
  }
  if (cmd === 'logout') {
    const store = new Store(cfg.stateDir);
    const t = store.loadTokens();
    if (t?.access_token) await revokeToken(cfg, t.access_token).catch(() => undefined);
    store.clearTokens();
    console.error('Logged out.');
    return;
  }
  if (cmd === 'spend' || cmd === 'doctor') {
    const { client, close } = await connectInMemory({ config: cfg });
    console.log(resultText(await client.callTool({ name: cmd, arguments: cmd === 'spend' ? { recent: 15 } : {} })));
    await close();
    return;
  }
  if (cmd === 'queue') {
    const store = new Store(cfg.stateDir);
    const q = store.s.queue.filter((x) => x.status === 'pending');
    console.log(`Approval queue (${q.length} pending):`);
    for (const x of q) console.log(`  [${x.id}] ${x.tool}: ${x.preview}`);
    const h = store.s.handoff.filter((x) => x.status === 'pending');
    console.log(`\nHuman handoff (${h.length} pending):`);
    for (const x of h) console.log(describeHandoff(x));
    return;
  }
  if (cmd === 'approve') {
    const id = args[1];
    if (!id) throw new Error('usage: x-mcp approve <id> | --all');
    const store = new Store(cfg.stateDir);
    const ctx = new Ctx(cfg, store);
    ctx.bypassApproval = true; // the human is approving these exact calls
    const { client, close } = await connectInMemory({ ctx });
    const targets = store.s.queue.filter((x) => x.status === 'pending' && (id === '--all' || x.id === id));
    if (!targets.length) console.error('Nothing to approve.');
    for (const q of targets) {
      console.error(`→ ${q.tool}: ${q.preview}`);
      const r = await client.callTool({ name: q.tool, arguments: q.args });
      store.update((s) => {
        const it = s.queue.find((x) => x.id === q.id);
        if (!it) return;
        it.status = r.isError ? 'failed' : 'executed';
        it.result = r.structuredContent ?? resultText(r);
      });
      console.log(resultText(r));
    }
    await close();
    return;
  }
  if (cmd !== 'serve') {
    help();
    process.exit(2);
  }
  if (args.includes('--http')) {
    const port = Number(flag('--port') ?? process.env.PORT ?? 8478);
    const token = flag('--token') ?? process.env.X_MCP_HTTP_TOKEN;
    const { close } = await serveXMcpHttp({ config: cfg, port, token });
    const shutdown = () => void close().finally(() => process.exit(0));
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }
  // stdio: anything a dependency prints with console.log would corrupt JSON-RPC.
  console.log = (...a: unknown[]) => console.error(...a);
  const handle = serveXMcpStdio({ config: cfg });
  const shutdown = () => void Promise.resolve(handle.close()).finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  console.error(`[x-mcp ${VERSION}] serving on stdio (state: ${cfg.stateDir}, budget $${cfg.monthlyBudgetUsd}/mo, approval ${cfg.requireApproval ? 'ON' : 'off'}, media roots: ${cfg.mediaRoots.join(', ')})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
