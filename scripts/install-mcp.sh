#!/usr/bin/env bash
# Register the foxwire MCP server with Claude Code at user scope (available in every project).
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
server="$repo/mcp/dist/server.js"
if [[ ! -f "$server" ]]; then
  echo "install-mcp: $server not found; run npm run build first" >&2
  exit 1
fi
cmd=(claude mcp add -s user foxwire -- node "$server")
echo "install-mcp: running: ${cmd[*]}"
"${cmd[@]}"
