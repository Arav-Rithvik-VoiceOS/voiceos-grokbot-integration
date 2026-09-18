#!/bin/zsh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/opt/homebrew/opt/node@22/bin:/usr/local/bin:$PATH"

# stdout is the MCP wire. @composio/core's version checker prints an upgrade
# banner through its logger on the first API call, which corrupts the JSON-RPC
# stream and drops this integration's tools from routing until VoiceOS
# restarts. Silence the SDK logger at the source; stdoutGuard.ts is the
# second line of defence for anything else a dependency prints.
export COMPOSIO_LOG_LEVEL=off

# Setup-field fallback: VoiceOS builds with setup fields inject COMPOSIO_API_KEY
# as an env var (that injection always wins). Older builds that register a bare
# MCP command don't — so fill only what's missing from a local .env, if present.
if [[ -z "${COMPOSIO_API_KEY:-}" && -f "$SCRIPT_DIR/.env" ]]; then
  set -a; . "$SCRIPT_DIR/.env"; set +a
fi

BUN=""
for candidate in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun "$(command -v bun 2>/dev/null || true)"; do
  if [[ -n "$candidate" && -x "$candidate" ]]; then BUN="$candidate"; break; fi
done

if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
  if [[ -n "$BUN" ]]; then
    (cd "$SCRIPT_DIR" && "$BUN" install) >&2 || (cd "$SCRIPT_DIR" && npm install) >&2
  else
    (cd "$SCRIPT_DIR" && npm install) >&2
  fi
fi

# Bun executes TypeScript natively — the fast path.
if [[ -n "$BUN" ]]; then
  exec "$BUN" "$SCRIPT_DIR/server.ts" "$@"
fi

# Node path: tsx is a declared dependency, so it's local after install.
if [[ -x "$SCRIPT_DIR/node_modules/.bin/tsx" ]]; then
  exec "$SCRIPT_DIR/node_modules/.bin/tsx" "$SCRIPT_DIR/server.ts" "$@"
fi
exec npx --yes tsx "$SCRIPT_DIR/server.ts" "$@"
