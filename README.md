# x-mcp

An opinionated MCP server for running an X account with an agent.

It is not a wrapper around the X API. It is a small operator that knows four things the API does not tell you:

1. **How For You ranks** — the weights, gates and filters from X's open-sourced algorithm (xai-org/x-algorithm) are built into every tool as guardrails and advice: reply weight 5→20 for mutuals, copy-link share 20, like 0.5; strictly >10s video; ≤1 @-mention; no engagement bait; ≥4h between originals; the first favorite opens the out-of-network corpus; sub-1k-follower cold-start lift; 24h/48h windows.
2. **What the pay-per-use API actually allows** — since 2026 X rejects un-summoned replies and removed follows, likes and quote posts from self-serve. The tools do everything that is allowed and hand the human a **one-tap intent link** for the rest, then **auto-reconcile** what the human did from $0.001 owned reads.
3. **What every call costs** — a local ledger mirrors X's per-resource pricing (with the 24h dedup), enforces a monthly budget, and warns you before the $0.20 "post with URL".
4. **What a business keeps** — a relationship ledger of everyone who engaged (and who to follow back), a calendar that learns your best hours, a brand book every session shares, an idea pipeline, and an insights/report loop so the agent steers on its own numbers instead of vibes.

Built on the MCP TypeScript SDK v2. stdio by default, Streamable HTTP optional. Zero runtime dependencies beyond the SDK and zod.

## Tools

| Tool | What it does | Cost |
|---|---|---|
| `account_pulse` | One-call briefing: follower delta, your recent posts with velocity + algorithm milestones, unanswered mentions, human queue, spend | ~$0.02–0.05 |
| `post_performance` | Refresh metrics, compute velocity, explain each post's state (in OON corpus? cold-start live? next re-index at N likes? ages out at 48h) | $0.001/post |
| `inbox` | Mentions/replies to you, prioritised (on your post > mutual > large account), all API-replyable | $0.001/item |
| `conversation` | Read a thread before answering | $0.005/post |
| `scout` | Search the niche and rank posts as *opportunities* (author band, freshness, question, activity) with intent links; capped + dedup'd | $0.005/post |
| `who` | Account lookup: band, relationship (mutual = +15 reply weight), pinned post | $0.01 |
| `publish` | Original post / self-thread / community / poll, with chunked v2 media upload; rules engine + spacing + video gate + budget; `dry_run` | $0.015 ($0.20 with URL) |
| `reply` | Reply to posts that summoned you; one reply per interaction; copypasta guard; throttle; hands off cold replies with an intent link | $0.01 |
| `repost` | Repost (informational, throttled 10/day) | $0.015 |
| `delete_post` | Delete your post | $0.01 |
| `dm` | DM only after the recipient DM'd you (policy) | $0.015 |
| `handoff` | Human queue: quote / follow / like / cold reply / manual post → x.com/intent links; `reconcile` detects completion from owned reads | $0.001 on reconcile |
| `agenda` | "What should I do now?" — ranked next calls from local state: unanswered inbound, due calendar, open spacing window at a best hour, follow-backs, stale metrics, human queue, goal pace | free |
| `people` | Relationship ledger (CRM) auto-built from every mention/reply: top engagers, notes/tags, `suggest_follows` → one-tap follow links; `scout(circle=true)` finds your community's fresh posts | free |
| `schedule` | Content calendar: `when` = ISO / `+2h` / `next_best` (your own best hours from history); `run_due` posts through the normal pipeline; `x-mcp tick` for cron | free |
| `insights` | What works: OON-entry rate (first like within 24h), engagement@24h, reply rate on inbound, by kind/tag/hour, top posts, follower deltas, spend per engagement, goal progress, advice | free |
| `brand` | Brand book: lane, voice rules, banned words (enforced in `draft_check`/`publish`), goals | free |
| `ideas` | Idea bank → `publish(idea_id)` marks used | free |
| `report` | Owner digest in markdown (also `x-mcp report 7`) | free |
| `draft_check` | Score a draft (and variants) against the For You rules + the brand book | free |
| `spend` | Ledger: month-to-date, by op, by tool, price table | free |
| `doctor` | Auth, scopes, config, rate limits, API boundary | free |
| `approvals` | Approval-mode queue (list/reject; approving is CLI-only) | free |

Resources: `x://playbook` (the rules), `x://boundary` (what the API allows), `x://handoff` (live human queue). Prompt: `operate` (the working loop).

## Setup

1. **Create an app** at https://console.x.com → enable OAuth 2.0 → app type *Native App* (public, PKCE) or *Automated App/Bot* (confidential, gives a client secret) → add redirect URI `http://127.0.0.1:8477/callback` → copy the Client ID (and secret if confidential). Load some credits (pay-per-use).
2. **Configure** — env vars are read from the environment or from `~/.x-mcp/.env` (never from the current directory, so a hostile repo's `.env` can't redirect your token):
   ```bash
   cd x-mcp && npm install && npm run build
   mkdir -p ~/.x-mcp/media && cp .env.example ~/.x-mcp/.env   # set X_CLIENT_ID (+ X_CLIENT_SECRET if confidential)
   ```
   Media the agent may upload must live under `~/.x-mcp/media` (or the dirs in `X_MCP_MEDIA_ROOT`) — drop your demo video there.
3. **Log in once** (opens a browser, stores tokens in `~/.x-mcp/tokens.json`, mode 0600):
   ```bash
   node dist/bin.js login
   ```
4. **Attach to your agent.**

   Hermes (`~/.hermes/config.yaml`):
   ```yaml
   mcp_servers:
     x:
       command: node
       args: ["/absolute/path/to/x-mcp/dist/bin.js"]
       env:
         X_CLIENT_ID: "…"
         X_CLIENT_SECRET: "…"          # confidential apps only
         X_MCP_MONTHLY_BUDGET_USD: "25"
         X_MCP_REQUIRE_APPROVAL: "true" # default; keep until you have X's AI-reply approval
       timeout: 180
   ```
   Claude Code:
   ```bash
   claude mcp add x -e X_CLIENT_ID=… -e X_MCP_REQUIRE_APPROVAL=true -- node /absolute/path/to/x-mcp/dist/bin.js
   ```
   HTTP instead of stdio: `X_MCP_HTTP_TOKEN=SECRET node dist/bin.js --http --port 8478` → `url: http://127.0.0.1:8478/mcp`, header `Authorization: Bearer SECRET`. A token is always required (one is generated and printed if you don't set it); Host/Origin are checked against localhost.

5. **Run the loop.** Ask the agent to use the `operate` prompt (or paste it). Check `node dist/bin.js queue` for anything waiting on you; `node dist/bin.js approve --all` executes queued API actions; tap the intent links for the human-only actions and run `handoff(reconcile)` (or let the agent do it) so the queue clears itself.
6. **Put `tick` on a timer** (every 15 min is plenty) so scheduled posts go out, handoffs reconcile, and metrics get snapshotted for `insights`:
   ```bash
   */15 * * * * cd /absolute/path/to/x-mcp && node dist/bin.js tick >> ~/.x-mcp/tick.log 2>&1
   ```
   (Hermes users: a cron job that calls `schedule(run_due)` + `handoff(reconcile)` + `post_performance` does the same.)

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `X_CLIENT_ID` | — | required |
| `X_CLIENT_SECRET` | — | confidential apps only |
| `X_REDIRECT_URI` | `http://127.0.0.1:8477/callback` | must match the app settings |
| `X_MCP_STATE_DIR` | `~/.x-mcp` | tokens, ledger, state, `.env` |
| `X_MCP_MEDIA_ROOT` | `<state dir>/media` | comma-separated dirs the agent may upload from (realpath-checked; dotfiles, URLs and symlink escapes refused) |
| `X_MCP_MONTHLY_BUDGET_USD` | `25` | hard stop |
| `X_MCP_BUDGET_WARN_AT` | `0.8` | warn at 80% |
| `X_MCP_REQUIRE_APPROVAL` | `true` | park writes for `x-mcp approve`; any `force` override is always parked |
| `X_MCP_MIN_HOURS_BETWEEN_ORIGINALS` | `4` | author-diversity / cold-start spacing |
| `X_MCP_MAX_REPLIES_PER_HOUR` / `X_MCP_MAX_REPOSTS_PER_DAY` / `X_MCP_MAX_DMS_PER_HOUR` | `12` / `10` / `5` | throttles (ledger-based) |
| `X_MCP_COPYPASTA_SIMILARITY` | `0.7` | Jaccard on word bigrams |
| `X_MCP_MAX_READS_PER_CALL` | `100` | cap on $0.005 reads per tool call |
| `X_MCP_REQUEST_TIMEOUT_MS` | `30000` | per-request timeout |
| `X_MCP_FFPROBE` | auto | ffprobe path (falls back to parsing the MP4 header) |
| `X_MCP_ALLOW_CUSTOM_API_BASE` | unset | required to honour a non-default `X_API_BASE` (tests/mocks only) |

## What it will refuse, and why

- Two or more @-mentions in a post → routed into real-time LLM spam scoring by X. Put credits in a reply.
- "Like if / RT for / tag someone" → `SpamHighRecall`, no exemption for anyone.
- A video ≤10.0s → video head is 0 and the post is excluded from every video corpus.
- Video + image in one post → disqualified from the video corpora.
- A second original within 4h → ×0.625 in shared slates; the cold-start lift picks one post per request.
- Same reply text twice → copypasta clustering.
- Replying to a post that did not @mention you → X rejects it; you get an intent link instead.
- Any spend past the monthly budget.

Everything soft can be overridden with `force: true` — which always routes the action to the human approval queue; media roots, the budget and X's own limits cannot be overridden.

## Security model (short)

- Tokens/state live in `~/.x-mcp` (0700 dir, 0600 files); the server and the `x-mcp approve` CLI share them safely (reload-before-write, never overwrite a newer token set).
- The agent cannot read arbitrary files: `media_paths` must resolve under the media roots; IDs are validated as numeric snowflakes (no `../` path smuggling into other endpoints).
- Irreversible or policy-sensitive actions (`delete_post`, any `force`, DMs, approval mode) require a human tap in the CLI. `delete_post` only accepts posts this server knows as yours.
- Third-party text in tool outputs is labelled as data, not instructions. HTTP mode needs a bearer token and validates Host/Origin.

## Policy notes you should read

- X's automation rules (April 2026) require **prior written approval for AI reply bots**, one automated reply per user interaction, no duplicate posts, no bulk follows/likes/DMs, and the **Automated** account label (Settings → Your account → Account information → Automation). This server enforces the mechanical parts; the approval and the label are yours to get and set.
- The developer-agreement use case you submitted should describe what the agent does (posting, own-metrics reads, niche research).

## Development

```bash
npm test          # rules engine + full server through an in-memory MCP client against a mock X API
npm run typecheck
npm run build
```

Sources: X API docs (docs.x.com, read 2026-08-19: pricing, manage-posts restrictions, changelog, media v2, OAuth 2.0), and xai-org/x-algorithm@11a71f8 (`home-mixer/params/param.rs`, `scorers/`, `filters/`, `visibility-filtering/`, `phoenix/`, `grox/`). See `docs/FOR_YOU_PLAYBOOK.md` in the x-algorithm clone for the full research with file:line citations.

MIT.
