#!/bin/sh
# Kept for a session still running under a plugin whose hooks.json named this script.
exec node "$(dirname "$0")/bifrost-hook.mjs" permission
