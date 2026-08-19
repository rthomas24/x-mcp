# Changelog

## 0.1.0 — 2026-08-19

Initial release.

- 16 tools: `account_pulse`, `post_performance`, `inbox`, `conversation`, `scout`, `who`, `publish`, `reply`, `repost`, `delete_post`, `dm`, `handoff`, `draft_check`, `spend`, `doctor`, `approvals`.
- Resources `x://playbook`, `x://boundary`, `x://handoff`; prompt `operate`.
- For You rules engine derived from xai-org/x-algorithm@11a71f8; pay-per-use cost ledger with 24h read dedup and a monthly budget.
- Human handoff queue with x.com/intent links and owned-read reconciliation (quote/follow/like/cold reply are not available via the self-serve API).
- OAuth 2.0 PKCE login CLI, chunked v2 media upload with MP4-duration detection, stdio + localhost HTTP transports, approval queue.
