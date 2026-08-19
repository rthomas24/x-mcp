# Contributing

Thanks for looking. This is a small, opinionated project; PRs that keep it small are the ones that land.

## Ground rules

- **Prices and limits come from the docs, with a link.** Anything in `src/pricing.ts` or the API-boundary text (`src/playbook.ts`) must cite the docs.x.com page it came from and the date you read it.
- **Algorithm rules cite the code.** Anything in `src/rules.ts` must point at a file:line in [xai-org/x-algorithm](https://github.com/xai-org/x-algorithm).
- **Safety rails are not optional.** Media roots, numeric-id validation, the approval queue, the budget stop and the untrusted-content marker stay on by default. If a change loosens one, say so in the PR title.
- **No new runtime dependencies** without a reason the README can explain in one line.

## Dev loop

```bash
npm install
npm run typecheck
npm test          # rules engine + full server through an in-memory MCP client against a mock X API
npm run build
```

Tests must not touch the real X API. The mock server in `test/server.test.ts` is the place to add endpoints.

## Reporting a security issue

See [SECURITY.md](SECURITY.md).
