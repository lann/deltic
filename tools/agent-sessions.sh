#!/usr/bin/env bash
# agent-sessions.sh — inspect opencode subagent (child) sessions for recovery.
#
# A content-filter abort or a paseo interrupt kills the `task` tool call but
# NOT the child session: its context persists in the opencode db, and any
# file/command effects it made persist on disk. This script finds those
# orphaned children so the orchestrator can resume them via the task tool's
# `task_id` parameter instead of relaunching from scratch.
#
# Usage:
#   tools/agent-sessions.sh                 # recent top-level sessions (this dir)
#   tools/agent-sessions.sh <session-id>    # child sessions of that session
#   tools/agent-sessions.sh -a              # recent top-level sessions (all dirs)
#
# Reading the output: a child whose last message role is "user" (or an
# assistant message with an error) was interrupted mid-turn — resume it with
# task_id and ask for a status summary before deciding to continue or restart.
set -euo pipefail

DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"
[ -r "$DB" ] || { echo "error: opencode db not found at $DB" >&2; exit 1; }

sql() { sqlite3 -readonly -header -column "$DB" "$1"; }

if [ "${1:-}" = "-a" ] || [ -z "${1:-}" ]; then
  where="parent_id IS NULL"
  if [ "${1:-}" != "-a" ]; then
    where="$where AND directory = '$(pwd)'"
    echo "Top-level sessions in $(pwd) (use -a for all):"
  else
    echo "Top-level sessions (all directories):"
  fi
  sql "SELECT id,
              substr(title, 1, 56) AS title,
              datetime(time_updated/1000, 'unixepoch', 'localtime') AS updated
       FROM session
       WHERE $where
       ORDER BY time_updated DESC
       LIMIT 15;"
  echo
  echo "Next: tools/agent-sessions.sh <session-id>   # list its children"
else
  parent="$1"
  sql "SELECT s.id,
              s.agent,
              substr(s.title, 1, 40) AS title,
              datetime(s.time_created/1000, 'unixepoch', 'localtime') AS created,
              (SELECT json_extract(m.data, '\$.role')
                 FROM message m
                WHERE m.session_id = s.id
                ORDER BY m.time_created DESC LIMIT 1) AS last_role,
              (SELECT CASE WHEN json_extract(m.data, '\$.error') IS NOT NULL
                           THEN COALESCE(json_extract(m.data, '\$.error.name'), 'error')
                           ELSE '' END
                 FROM message m
                WHERE m.session_id = s.id
                  AND json_extract(m.data, '\$.role') = 'assistant'
                ORDER BY m.time_created DESC LIMIT 1) AS last_error
       FROM session s
       WHERE s.parent_id = '$parent'
       ORDER BY s.time_created DESC;"
  echo
  echo "Resume a child: call the task tool with task_id=<id> (context is intact)."
fi
