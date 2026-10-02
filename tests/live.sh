#!/usr/bin/env bash
# Live checks against a real Claude Code session: what the mocked tests in register.test.ts can't
# show. Each scenario runs a throwaway Haiku session in tmux with a one-minute idle delay, loaded
# from this checkout. Takes about four minutes and a little Haiku usage.
#
#   tests/live.sh            run every scenario
#   tests/live.sh slash      run one (baseline, slash, subagent)
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${IDLE_COMPACT_LIVE_DIR:-${TMPDIR:-/tmp}/idle-compact-live}
SETTINGS='{"pluginConfigs":{"idle-compact@inline":{"options":{"idleMinutes":1,"minTokens":1000}}}}'
STORY='Write a 300-word story about a lighthouse keeper.'
# The transcript line, not the status line (which starts with a warning sign instead).
COMPACTED='● idle-compact: compacted at'
# The footer of a finished turn, as in "Brewed for 6s · done 5:18 pm" or "Cooked for 1m 56s".
DONE=' for [0-9][0-9ms ]*s\( ·\|$\)'

pane() { tmux capture-pane -t "ic-$1" -p -S -300; }

count() { pane "$1" | grep -c -- "$2"; }

# Wait until the pane matches a pattern (on that many lines, if given), or give up after a number
# of seconds.
wait_for() {
  local name=$1 pattern=$2 limit=$3 lines=${4:-1} waited=0
  until [ "$(count "$name" "$pattern")" -ge "$lines" ]; do
    sleep 2
    waited=$((waited + 2))
    if [ "$waited" -ge "$limit" ]; then return 1; fi
  done
}

start() {
  local name=$1
  shift
  mkdir -p "$WORK/$name"
  rm -f "$WORK/$name/debug.log"
  tmux kill-session -t "ic-$name" 2>/dev/null
  tmux new-session -d -s "ic-$name" -x 150 -y 50 -c "$WORK/$name" \
    claude --plugin-dir "$ROOT" --model haiku \
    --debug-file "$WORK/$name/debug.log" --settings "$SETTINGS" "$@"
  # a folder Claude Code hasn't seen asks whether to trust it, with "No, exit" selected; these
  # folders are empty and ours
  if wait_for "$name" 'trust this folder' 6; then
    if pane "$name" | grep -q '❯ No, exit'; then tmux send-keys -t "ic-$name" Down; fi
    tmux send-keys -t "ic-$name" Enter
  fi
  wait_for "$name" 'for shortcuts' 30 || echo "  ($name: prompt not seen, carrying on)"
}

# Type the text, then press Enter on its own: sent together, the Enter can land in the paste.
say() {
  tmux send-keys -t "ic-$1" -l "$2"
  sleep 1
  tmux send-keys -t "ic-$1" Enter
}

now() { date +%s; }
ok() { echo "ok    $1"; }
fail() {
  echo "FAIL  $1"
  return 1
}

# A turn, then nothing: compacts about a minute after the turn ends.
baseline() {
  start baseline
  say baseline "$STORY"
  wait_for baseline "$DONE" 90 || { fail 'baseline: the turn never ended'; return; }
  local t0 t
  t0=$(now)
  wait_for baseline "$COMPACTED" 120 || { fail 'baseline: no compaction'; return; }
  t=$(($(now) - t0))
  ok "baseline: compacted ${t}s after the turn"
}

# A slash command that calls no model, half way through the wait, must not cancel the timer.
# /context runs locally: it prints its grid inline, starts no turn and only calls count_tokens.
# Had it reset the timer, the compaction would land 90s or more after the turn, or never.
slash() {
  start slash
  say slash "$STORY"
  wait_for slash "$DONE" 90 || { fail 'slash: the turn never ended'; return; }
  local t0 t
  t0=$(now)
  sleep 30
  say slash '/context'
  wait_for slash 'Context Usage' 20 || { fail 'slash: /context printed nothing'; return; }
  wait_for slash "$COMPACTED" 90 || { fail 'slash: no compaction'; return; }
  t=$(($(now) - t0))
  [ "$t" -lt 85 ] || { fail "slash: compacted ${t}s after the turn, so /context reset the timer"; return; }
  ok "slash: compacted ${t}s after the turn, /context sent at 30s"
}

# A background subagent still running when the main turn ends. Its turns fire turn.complete with an
# agentId, which the hook ignores, and no turn.start, so the main timer runs on. Compaction succeeds
# with the agent mid-command and leaves it alone. When the agent finishes, its notification is a
# main turn: that re-arms the timer, so the session compacts a second time a minute later.
# Claude Code refuses a long bare `sleep`, so the agent runs it from a script instead.
subagent() {
  mkdir -p "$WORK/subagent"
  printf 'sleep 100\necho done\n' >"$WORK/subagent/wait.sh"
  start subagent --allowedTools 'Bash(bash wait.sh)' Agent
  say subagent "Use the Agent tool once, with run_in_background set to true, to start one agent with this task: run the bash command 'bash wait.sh' in the foreground (not in the background; it takes 100 seconds), then reply with its output. Do not wait for the agent or check on it: as soon as it has started, reply 'started' and end your turn."
  local finished='Agent ".*" finished'
  # while the agent runs, the finished turn's footer reads "Waiting for 1 background agent to finish"
  wait_for subagent "background agents\? to finish\|$DONE" 90 || { fail 'subagent: the turn never ended'; return; }
  wait_for subagent "$COMPACTED" 100 || { fail 'subagent: no compaction while the agent ran'; return; }
  [ "$(count subagent "$finished")" -eq 0 ] || { fail 'subagent: the agent ended before the compaction'; return; }
  wait_for subagent "$finished" 90 || { fail 'subagent: the agent never reported back'; return; }
  wait_for subagent "$COMPACTED" 100 2 || { fail 'subagent: no second compaction after the agent reported'; return; }
  ok 'subagent: compacted with the agent running, the agent finished, compacted again after its report'
}

FAILED=0
if [ $# -eq 0 ]; then set -- baseline slash subagent; fi
PIDS=()
for scenario in "$@"; do
  case $scenario in
    baseline | slash | subagent) ;;
    *)
      echo "unknown scenario: $scenario (baseline, slash, subagent)" >&2
      exit 2
      ;;
  esac
done
for scenario in "$@"; do
  "$scenario" &
  PIDS+=($!)
done
for pid in "${PIDS[@]}"; do wait "$pid" || FAILED=1; done
echo "panes are still open: tmux attach -t ic-<scenario>; debug logs in $WORK/<scenario>/debug.log"
exit "$FAILED"
