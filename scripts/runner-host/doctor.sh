#!/usr/bin/env bash
# Verify a UWF self-hosted runner machine. Exit 0 when every check passes,
# exit 1 with a named fix for each failing check. Secret values are never printed.
#
#   doctor.sh [--name NAME] [--dir RUNNER_DIR] [--strict-idle]
#
# Env: GH_TOKEN | UWF_BOT_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY (the API keys may
# instead live in RUNNER_DIR/.env, which is what the runner service reads).
# Test/ops overrides: UWF_DOCTOR_MIN_DISK_GB (default 10).
set -uo pipefail

NAME="" DIR="" STRICT_IDLE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="${2:?--name needs a value}"; shift 2 ;;
    --dir) DIR="${2:?--dir needs a path}"; shift 2 ;;
    --strict-idle) STRICT_IDLE=1; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$DIR" ]; then
  if [ -n "$NAME" ]; then DIR="$HOME/actions-runner-$NAME"; else
    DIR="$(ls -d "$HOME"/actions-runner-* 2>/dev/null | head -n 1)"
    [ -n "$DIR" ] || DIR="$HOME/actions-runner"
  fi
fi

FAILS=0
ok() { printf 'ok:      %s\n' "$*"; }
warn() { printf 'warn:    %s\n' "$*"; }
fail() { printf '%s\n' "$*"; FAILS=$((FAILS + 1)); }
have() { command -v "$1" >/dev/null 2>&1; }

# ---- CLIs ----------------------------------------------------------------

if have node; then
  v="$(node --version 2>/dev/null || echo v0)"; major="${v#v}"; major="${major%%.*}"
  case "$major" in ''|*[!0-9]*) major=0 ;; esac
  if [ "$major" -ge 24 ]; then ok "node $v"; else
    fail "outdated: node $v (need >= 24) - run: nvm install 24 && nvm alias default 24  (macOS without nvm: brew install node@24)"
  fi
else
  fail "missing: node - run: nvm install 24  (macOS without nvm: brew install node@24)"
fi

if have claude; then ok "claude $(claude --version 2>/dev/null | head -n 1)"; else
  fail "missing: claude - run: npm i -g @anthropic-ai/claude-code"
fi
if have codex; then ok "codex $(codex --version 2>/dev/null | head -n 1)"; else
  fail "missing: codex - run: npm i -g @openai/codex"
fi

# ---- gh and its auth (bot token via env, never an interactive login) ------

BOT="${GH_TOKEN:-${UWF_BOT_TOKEN:-}}"
if have gh; then
  ok "gh $(gh --version 2>/dev/null | head -n 1)"
  if [ -z "$BOT" ]; then
    fail "missing: GH_TOKEN (bot token) - run: export GH_TOKEN=<bot token> (or UWF_BOT_TOKEN), then re-run"
  elif GH_TOKEN="$BOT" gh auth status >/dev/null 2>&1; then
    ok "gh auth status (token from env)"
  else
    fail "failing: gh auth status - run: check that GH_TOKEN is the bot's valid token (rotation steps in docs/guide/self-hosted-runner.md)"
  fi
else
  fail "missing: gh - run: brew install gh (macOS) or see https://github.com/cli/cli#installation (Linux), or re-run scripts/runner-host/provision.sh"
fi

# ---- API keys: present, values never echoed -------------------------------

env_has() { # env_has KEY : set in environment or in the runner's .env
  local key="$1"
  [ -n "${!key:-}" ] && return 0
  [ -f "$DIR/.env" ] && grep -Eq "^$key=.+" "$DIR/.env"
}
for key in ANTHROPIC_API_KEY OPENAI_API_KEY CODEX_API_KEY; do
  if env_has "$key"; then ok "$key present (value not shown)"; else
    if [ "$key" = CODEX_API_KEY ]; then
      fail "missing: CODEX_API_KEY (what `codex exec` reads) - run: export OPENAI_API_KEY=<key> and re-run scripts/runner-host/provision.sh (writes CODEX_API_KEY to $DIR/.env)"
    else
      fail "missing: $key - run: export $key=<key> and re-run scripts/runner-host/provision.sh (writes it to $DIR/.env)"
    fi
  fi
done

# ---- the service environment must be able to resolve the CLIs ----------------

if [ -f "$DIR/.env" ] && grep -q '^PATH=' "$DIR/.env"; then
  svc_path="$(grep '^PATH=' "$DIR/.env" | tail -n 1)"; svc_path="${svc_path#PATH=}"
  for cli in node claude codex gh; do
    if ! PATH="$svc_path" command -v "$cli" >/dev/null 2>&1; then
      fail "unreachable: $cli is not on the runner service PATH in $DIR/.env - run: re-run scripts/runner-host/provision.sh (rewrites PATH) then restart the service"
    fi
  done
fi

# ---- disk ----------------------------------------------------------------

MIN_GB="${UWF_DOCTOR_MIN_DISK_GB:-10}"
probe="$DIR"; [ -d "$probe" ] || probe="$HOME"
free_kb="$(df -Pk "$probe" 2>/dev/null | awk 'NR==2 {print $4}')"
case "$free_kb" in ''|*[!0-9]*) fail "failing: could not read free disk space for $probe - run: df -h $probe" ;; *)
  free_gb=$((free_kb / 1024 / 1024))
  if [ "$free_gb" -ge "$MIN_GB" ]; then ok "disk free ${free_gb} GB (>= ${MIN_GB})"; else
    fail "low disk: ${free_gb} GB free on $probe (need >= ${MIN_GB}) - run: rm -r $DIR/_work/_temp $DIR/_work/_actions (or grow the volume)"
  fi ;;
esac

# ---- runner registration, service, idleness -------------------------------

if [ -f "$DIR/.runner" ]; then ok "runner registered ($DIR/.runner)"; else
  fail "missing: runner registration in $DIR - run: scripts/runner-host/provision.sh --repo <owner/name> --name <name>"
fi

# Classify `svc.sh status` output by its state line only (journal lines in a systemd
# status may contain words like "failed" even when the unit is healthy).
svc_state() {
  local out="$1" active
  active="$(printf '%s\n' "$out" | grep -Ei '^[[:space:]]*Active:' | head -n 1)"
  if [ -n "$active" ]; then
    if printf '%s' "$active" | grep -Eiq 'active \(running\)'; then echo running; else echo stopped; fi
  elif printf '%s\n' "$out" | grep -Eiq '^[[:space:]]*Not started'; then echo stopped
  elif printf '%s\n' "$out" | grep -Eiq '^[[:space:]]*Started'; then echo running
  else echo unknown; fi
}

# The Linux systemd svc.sh refuses every command (status included) unless run as root.
# UWF_DOCTOR_SUDO overrides the prefix (set it empty to disable; used by the tests).
if [ -n "${UWF_DOCTOR_SUDO+x}" ]; then pre="${UWF_DOCTOR_SUDO:+$UWF_DOCTOR_SUDO }"
elif [ "$(id -u)" -eq 0 ] || [ "$(uname -s)" = Darwin ]; then pre=""; else pre="sudo "; fi
if [ -f "$DIR/.service" ] && [ -x "$DIR/svc.sh" ]; then
  status_out="$(cd "$DIR" && ${pre}./svc.sh status 2>&1 || true)"
  state="$(svc_state "$status_out")"
  if [ "$state" = stopped ]; then
    fail "stopped: runner service - run: cd $DIR && ${pre}./svc.sh start"
  elif [ "$state" = running ]; then
    ok "runner service running"
  else
    fail "unknown: runner service state - run: cd $DIR && ${pre}./svc.sh status"
  fi
else
  fail "missing: runner service - run: cd $DIR && ${pre}./svc.sh install && ${pre}./svc.sh start (or re-run scripts/runner-host/provision.sh)"
fi

if have pgrep && pgrep -f 'Runner\.Worker' >/dev/null 2>&1; then
  if [ "$STRICT_IDLE" -eq 1 ]; then fail "busy: a job is running (Runner.Worker) - run: re-check when idle"; else
    warn "runner is busy (a job is running); pass --strict-idle to fail on this"
  fi
else
  ok "runner idle (no Runner.Worker process)"
fi

# ---- verdict -------------------------------------------------------------

if [ "$FAILS" -eq 0 ]; then echo "doctor: all checks passed"; exit 0; fi
echo "doctor: $FAILS check(s) failed" >&2
exit 1
