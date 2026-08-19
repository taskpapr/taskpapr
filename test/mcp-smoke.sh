#!/bin/bash
# Thin wrapper so the MCP smoke test fits alongside the bash test/*.sh
# convention documented in CLAUDE.md, even though it's implemented in
# Node (an MCP stdio client can't reasonably be driven from bash).
#
# Usage: bash test/mcp-smoke.sh
exec node "$(dirname "$0")/mcp-smoke.js" "$@"
