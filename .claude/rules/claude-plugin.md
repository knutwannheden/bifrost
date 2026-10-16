Any change under `src/claude-plugin/` — hooks, skills, the MCP server, `.mcp.json` — needs `version` in `src/claude-plugin/.claude-plugin/plugin.json` bumped, and the user told they have to accept the integration update for it to take effect.

`src/claude-plugin/CLAUDE.md` says why an install is never refreshed in place, and what that means for an event the app stops acting on.
