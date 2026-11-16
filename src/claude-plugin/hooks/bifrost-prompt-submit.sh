#!/bin/sh
# Codex runs this, and so does a session still running under a plugin whose hooks.json named it.
exec node "$(dirname "$0")/bifrost-hook.mjs" prompt-submit
