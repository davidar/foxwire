#!/usr/bin/env bash
# Remove the foxwire MCP server registration from Claude Code (user scope).
set -euo pipefail
cmd=(claude mcp remove -s user foxwire)
echo "uninstall-mcp: running: ${cmd[*]}"
"${cmd[@]}"
