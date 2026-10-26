#!/usr/bin/env bash
# Tests for scripts/runner-host: syntax, provision --dry-run plan, doctor with stub CLIs.
# Never installs or registers anything; doctor runs against a fake PATH and fake runner dir.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RH="$(cd "$HERE/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -r "$TMP"' EXIT

PASS=0 FAIL=0
pass() { PASS=$((PASS + 1)); echo "  ok - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }
contains() { printf '%s' "$1" | grep -Fq -- "$2"; }
assert_has() { if contains "$1" "$2"; then pass "$3"; else bad "$3 (missing: $2)"; fi; }
assert_lacks() { if contains "$1" "$2"; then bad "$3 (found: $2)"; else pass "$3"; fi; }

BASH_BIN="$(command -v bash)"

echo "syntax"
for s in provision.sh doctor.sh; do
  if "$BASH_BIN" -n "$RH/$s"; then pass "bash -n $s"; else bad "bash -n $s"; fi
done

echo "provision --dry-run"
export GH_TOKEN="ghp_FAKEBOTTOKEN0001" ANTHROPIC_API_KEY="sk-ant-FAKEKEY0002" OPENAI_API_KEY="sk-FAKEOPENAI0003"
PLAN="$("$BASH_BIN" "$RH/provision.sh" --dry-run --repo qwts/uwf-toy-app --name test 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && pass "dry-run exits 0" || bad "dry-run exits 0 (got $rc)"
assert_has "$PLAN" "npm install -g @anthropic-ai/claude-code" "plan installs claude"
assert_has "$PLAN" "npm install -g @openai/codex" "plan installs codex"
assert_has "$PLAN" "Node >= 24" "plan has the node step"
assert_has "$PLAN" "4. gh" "plan has the gh step"
assert_has "$PLAN" "repos/qwts/uwf-toy-app/actions/runners/registration-token" "plan mints the registration token via gh api"
assert_has "$PLAN" "--labels self-hosted,uwf" "plan registers default labels"
assert_has "$PLAN" "--name test" "plan uses the runner name"
assert_has "$PLAN" "--url https://github.com/qwts/uwf-toy-app" "plan registers against the repo"
assert_has "$PLAN" "svc.sh install" "plan installs the service"
assert_has "$PLAN" "svc.sh start" "plan starts the service"
assert_has "$PLAN" "doctor.sh" "plan ends with doctor"
for secret in ghp_FAKEBOTTOKEN0001 sk-ant-FAKEKEY0002 sk-FAKEOPENAI0003; do
  assert_lacks "$PLAN" "$secret" "plan does not print $secret"
done

LINUX="$(UWF_OS=Linux UWF_ARCH=x86_64 "$BASH_BIN" "$RH/provision.sh" --dry-run --org qwts --name t2 --labels self-hosted,uwf,extra 2>&1)"
assert_has "$LINUX" "actions-runner-linux-x64-" "linux/x64 runner archive"
assert_has "$LINUX" "registration-token" "org registration endpoint"
assert_has "$LINUX" "orgs/qwts/actions/runners/registration-token" "org endpoint path"
assert_has "$LINUX" "--labels self-hosted,uwf,extra" "custom labels honoured"
MAC="$(UWF_OS=Darwin UWF_ARCH=arm64 "$BASH_BIN" "$RH/provision.sh" --dry-run --repo a/b --name m 2>&1)"
assert_has "$MAC" "actions-runner-osx-arm64-" "macOS/arm64 runner archive"
assert_lacks "$MAC" "sudo" "macOS plan needs no sudo"

"$BASH_BIN" "$RH/provision.sh" --dry-run --name x >/dev/null 2>&1; rc=$?
[ "$rc" -eq 2 ] && pass "scope (--repo/--org) is required" || bad "scope required (got $rc)"

echo "doctor with stub CLIs"
# Hermetic PATH: only stubs plus symlinks to the basic tools doctor needs.
make_path() { # make_path DIR [omit-cli]
  local d="$1" omit="${2:-}" t cli
  mkdir -p "$d"
  for t in awk grep sed head ls df uname id dirname cat tr cut sort pgrep ps mktemp; do
    p="$(command -v "$t" 2>/dev/null)" && ln -s "$p" "$d/$t"
  done
  for cli in node claude codex gh; do
    [ "$cli" = "$omit" ] && continue
    case "$cli" in
      node) out="v24.1.0" ;;
      *) out="$cli 1.2.3" ;;
    esac
    printf '#!/bin/sh\ncase "$1" in auth) exit 0 ;; esac\necho "%s"\n' "$out" >"$d/$cli"
    chmod +x "$d/$cli"
  done
}
RUNNER="$TMP/runner"
mkdir -p "$RUNNER"
echo '{}' >"$RUNNER/.runner"; echo uwf >"$RUNNER/.service"
printf '#!/bin/sh\necho "active (running)"\n' >"$RUNNER/svc.sh"; chmod +x "$RUNNER/svc.sh"

make_path "$TMP/good"
OUT="$(env -i HOME="$TMP" UWF_DOCTOR_SUDO= PATH="$TMP/good" GH_TOKEN=ghp_FAKEBOTTOKEN0001 ANTHROPIC_API_KEY=sk-ant-FAKEKEY0002 OPENAI_API_KEY=sk-FAKEOPENAI0003 UWF_DOCTOR_MIN_DISK_GB=0 "$BASH_BIN" "$RH/doctor.sh" --dir "$RUNNER" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && pass "all-good exits 0" || { bad "all-good exits 0 (got $rc)"; echo "$OUT"; }
assert_has "$OUT" "all checks passed" "all-good verdict"
for secret in ghp_FAKEBOTTOKEN0001 sk-ant-FAKEKEY0002 sk-FAKEOPENAI0003; do
  assert_lacks "$OUT" "$secret" "doctor does not print $secret"
done

make_path "$TMP/nocodex" codex
OUT="$(env -i HOME="$TMP" UWF_DOCTOR_SUDO= PATH="$TMP/nocodex" GH_TOKEN=x ANTHROPIC_API_KEY=a OPENAI_API_KEY=b UWF_DOCTOR_MIN_DISK_GB=0 "$BASH_BIN" "$RH/doctor.sh" --dir "$RUNNER" 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && pass "missing codex exits 1" || bad "missing codex exits 1 (got $rc)"
assert_has "$OUT" "missing: codex - run: npm i -g @openai/codex" "named fix for codex"

make_path "$TMP/old"; printf '#!/bin/sh\necho v20.11.0\n' >"$TMP/old/node"
OUT="$(env -i HOME="$TMP" UWF_DOCTOR_SUDO= PATH="$TMP/old" GH_TOKEN=x ANTHROPIC_API_KEY=a OPENAI_API_KEY=b UWF_DOCTOR_MIN_DISK_GB=0 "$BASH_BIN" "$RH/doctor.sh" --dir "$RUNNER" 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && pass "node 20 exits 1" || bad "node 20 exits 1 (got $rc)"
assert_has "$OUT" "outdated: node v20.11.0" "named fix for old node"

OUT="$(env -i HOME="$TMP" UWF_DOCTOR_SUDO= PATH="$TMP/good" GH_TOKEN=x UWF_DOCTOR_MIN_DISK_GB=0 "$BASH_BIN" "$RH/doctor.sh" --dir "$RUNNER" 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && pass "missing API keys exits 1" || bad "missing API keys exits 1 (got $rc)"
assert_has "$OUT" "missing: ANTHROPIC_API_KEY" "named fix for anthropic key"

OUT="$(env -i HOME="$TMP" UWF_DOCTOR_SUDO= PATH="$TMP/good" GH_TOKEN=x ANTHROPIC_API_KEY=a OPENAI_API_KEY=b UWF_DOCTOR_MIN_DISK_GB=999999999 "$BASH_BIN" "$RH/doctor.sh" --dir "$RUNNER" 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && pass "low disk exits 1" || bad "low disk exits 1 (got $rc)"
assert_has "$OUT" "low disk" "low disk named"

printf '#!/bin/sh\necho "inactive (dead)"\n' >"$RUNNER/svc.sh"
OUT="$(env -i HOME="$TMP" UWF_DOCTOR_SUDO= PATH="$TMP/good" GH_TOKEN=x ANTHROPIC_API_KEY=a OPENAI_API_KEY=b UWF_DOCTOR_MIN_DISK_GB=0 "$BASH_BIN" "$RH/doctor.sh" --dir "$RUNNER" 2>&1)"; rc=$?
[ "$rc" -eq 1 ] && pass "stopped service exits 1" || bad "stopped service exits 1 (got $rc)"
assert_has "$OUT" "svc.sh start" "named fix for stopped service"

printf '#!/bin/sh\necho "$@" >"%s/sudo.log"; exec "$@"\n' "$TMP" >"$TMP/good/sudo"; chmod +x "$TMP/good/sudo"
printf '#!/bin/sh\necho "active (running)"\n' >"$RUNNER/svc.sh"
env -i HOME="$TMP" UWF_DOCTOR_SUDO=sudo PATH="$TMP/good" GH_TOKEN=x ANTHROPIC_API_KEY=a OPENAI_API_KEY=b UWF_DOCTOR_MIN_DISK_GB=0 "$BASH_BIN" "$RH/doctor.sh" --dir "$RUNNER" >/dev/null 2>&1; rc=$?
[ "$rc" -eq 0 ] && grep -q "svc.sh status" "$TMP/sudo.log" && pass "service status goes through the sudo prefix" || bad "service status goes through the sudo prefix (rc $rc)"

echo
echo "runner-host tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
