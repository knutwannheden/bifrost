#!/usr/bin/env bash
# Usage: ./scripts/test-summarize.sh <path-to-jsonl-file> [provider:model]
#
# Examples:
#   ./scripts/test-summarize.sh session.jsonl ollama:phi4-mini
#   ./scripts/test-summarize.sh session.jsonl ollama:gemma3:1b
#   ./scripts/test-summarize.sh session.jsonl claude:haiku
#
# Default: ollama:phi4-mini

set -euo pipefail

JSONL_FILE="${1:?Usage: $0 <jsonl-file> [provider:model]}"
SPEC="${2:-ollama:phi4-mini}"
PROVIDER="${SPEC%%:*}"
MODEL="${SPEC#*:}"

if [[ ! -f "$JSONL_FILE" ]]; then
  echo "Error: File not found: $JSONL_FILE" >&2
  exit 1
fi

TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

# Extract first 5 + last 5 user/assistant lines using grep + head/tail
grep -E '"type":"(user|assistant)"' "$JSONL_FILE" > "$TMPFILE"
TOTAL=$(wc -l < "$TMPFILE" | tr -d ' ')

if [[ "$TOTAL" -le 10 ]]; then
  INPUT_FILE="$TMPFILE"
else
  INPUT_FILE=$(mktemp)
  trap 'rm -f "$TMPFILE" "$INPUT_FILE"' EXIT
  { head -4 "$TMPFILE"; tail -6 "$TMPFILE"; } > "$INPUT_FILE"
fi

LINE_COUNT=$(wc -l < "$INPUT_FILE" | tr -d ' ')
echo "Selected $LINE_COUNT of $TOTAL user/assistant lines from $(basename "$JSONL_FILE")" >&2

PROMPT='You are summarizing a Claude Code session transcript. The input is a sequence of JSONL lines from the session.

Each line is a JSON object with a "type" field:
- "user": A message from the user. The "message.content" field contains the user'\''s text or tool results.
- "assistant": A response from Claude. The "message.content" array may contain "text" (prose), "thinking" (internal reasoning), or "tool_use" (tool invocations) blocks.

The input contains the first few and last few user/assistant exchanges to give you both the initial intent and the current state of the work.

Output exactly two short plain-text sentences on a single line, no markdown, no bullet points, no numbering. The first sentence should capture the goal or intent. The second should describe the current focus or state of the work. Start with an action verb (e.g. "Implementing...", "Fixing...", "Investigating..."). Do not start with "A Claude Code session", "The user", or similar filler.'

case "$PROVIDER" in
  ollama)
    if ! command -v ollama &>/dev/null; then
      echo "Error: ollama not found" >&2
      exit 1
    fi
    echo "--- Using ollama ($MODEL) ---" >&2
    ollama run "$MODEL" "$PROMPT" < "$INPUT_FILE"
    ;;
  claude)
    echo "--- Using claude -p --model $MODEL ---" >&2
    claude -p --model "$MODEL" "$PROMPT" < "$INPUT_FILE"
    ;;
  *)
    echo "Error: Unknown provider '$PROVIDER'. Use 'ollama' or 'claude'." >&2
    exit 1
    ;;
esac
