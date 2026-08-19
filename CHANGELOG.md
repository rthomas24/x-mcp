# Changelog

## 0.2.0 — 2026-08-19

- Business layer: `people` (relationship ledger auto-built from interactions, `suggest_follows`), `schedule` (calendar, `next_best` hours learned from your own history, `run_due`, `x-mcp tick`), `insights` (OON-entry rate, engagement@24h, by kind/tag/hour, goals, advice), `brand` (lane/voice/banned words/goals, enforced in `draft_check`/`publish`), `ideas` (pipeline → `publish(idea_id)`), `report` (owner digest, `x-mcp report`).
- `scout(circle=true)` searches your top people's fresh originals; `publish` accepts `tags`/`idea_id`; `account_pulse` shows due scheduled posts.
- Hardening from the security review: env only from the state dir, `X_API_BASE` locked, media roots + realpath checks, numeric-id validation and encoded paths, approval on by default with `force` always parked, `delete_post` limited to known posts, HTTP token + Host/Origin checks, synchronous multi-process-safe state writes, untrusted-content labelling.

## 0.1.0 — 2026-08-19

Initial release.

- 16 tools: `account_pulse`, `post_performance`, `inbox`, `conversation`, `scout`, `who`, `publish`, `reply`, `repost`, `delete_post`, `dm`, `handoff`, `draft_check`, `spend`, `doctor`, `approvals`.
- Resources `x://playbook`, `x://boundary`, `x://handoff`; prompt `operate`.
- For You rules engine derived from xai-org/x-algorithm@11a71f8; pay-per-use cost ledger with 24h read dedup and a monthly budget.
- Human handoff queue with x.com/intent links and owned-read reconciliation (quote/follow/like/cold reply are not available via the self-serve API).
- OAuth 2.0 PKCE login CLI, chunked v2 media upload with MP4-duration detection, stdio + localhost HTTP transports, approval queue.
