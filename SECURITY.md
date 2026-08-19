# Security

This server holds an OAuth token for a real X account and takes instructions from an LLM agent, so it is designed assuming the agent can be prompt-injected by content it reads from X.

What it enforces today:

- Tokens and state live in `~/.x-mcp` (dir 0700, files 0600). Env is read only from that directory or `X_MCP_ENV_FILE`, never from the current working directory. `X_API_BASE` is locked to `api.x.com` unless explicitly allowed.
- Media uploads are limited to files whose realpath is under `X_MCP_MEDIA_ROOT`; URLs, relative paths, dotfiles and symlink escapes are refused before any read.
- All ids are validated as numeric snowflakes and every URL path segment is encoded, so agent input cannot reach other endpoints.
- Approval mode is on by default; any `force` override, any `dm`, and `delete_post` always require a human tap in the CLI. `delete_post` only accepts posts the server knows as yours.
- HTTP mode requires a bearer token and validates Host/Origin against localhost.
- Third-party text in tool output is labelled as data, not instructions.

If you find a way around any of these, please open a private report via GitHub's "Report a vulnerability" on this repository (or email the maintainer shown on the GitHub profile) rather than a public issue. I'll respond within a few days.
