When changing anything under `src/claude-plugin/` — hooks, skills, the MCP server, `.mcp.json` — bump `version` in `src/claude-plugin/.claude-plugin/plugin.json`, and tell the user they need to accept the integration update for it to take effect.

An install on disk is never refreshed in place. `ensureHooks` writes `hooks.json` only when it is missing, and `checkIntegration` offers an update only when the source version differs from the deployed one, so without the bump the change reaches new installs alone and Bifrost reports nothing to update.

The main process therefore receives hooks from whatever plugin copy the user has. An event the app does not act on has to be ignored on the receiving side; unregistering it in `hooks.json` only stops it for installs that took the update.
