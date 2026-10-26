#!/usr/bin/env bash
# Provision a machine (macOS or Linux) as a GitHub Actions self-hosted runner
# for UWF jobs: Node 24, claude, codex, gh, the Actions runner as a service.
#
# Secrets are read from the environment only and are never printed:
#   GH_TOKEN (or UWF_BOT_TOKEN)  bot token used for `gh` and to mint the registration token
#   ANTHROPIC_API_KEY            written to the runner's .env (service environment)
#   OPENAI_API_KEY               written to the runner's .env (service environment)
#
# See docs/guide/self-hosted-runner.md.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'USAGE'
Usage: provision.sh (--repo owner/name | --org name) [options]

  --repo owner/name   register the runner for one repository
  --org name          register the runner for an organization
  --name NAME         runner name (default: uwf-<hostname>)
  --labels LIST       comma-separated labels (default: self-hosted,uwf)
  --dir PATH          runner install dir (default: $HOME/actions-runner-<name>)
  --dry-run           print every command instead of running it (plan for a fresh machine)
  --check             run doctor.sh and exit with its status
  -h, --help          this help

Environment (values are never printed):
  GH_TOKEN | UWF_BOT_TOKEN, ANTHROPIC_API_KEY, OPENAI_API_KEY
USAGE
}

REPO="" ORG="" NAME="" LABELS="self-hosted,uwf" DIR="" DRY=0 CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="${2:?--repo needs owner/name}"; shift 2 ;;
    --org) ORG="${2:?--org needs a name}"; shift 2 ;;
    --name) NAME="${2:?--name needs a value}"; shift 2 ;;
    --labels) LABELS="${2:?--labels needs a value}"; shift 2 ;;
    --dir) DIR="${2:?--dir needs a path}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --check) CHECK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$NAME" ] || NAME="uwf-$(hostname -s 2>/dev/null || echo host)"
[ -n "$DIR" ] || DIR="$HOME/actions-runner-$NAME"

if [ "$CHECK" -eq 1 ]; then
  exec bash "$SELF_DIR/doctor.sh" --name "$NAME" --dir "$DIR"
fi

if [ -n "$REPO" ] && [ -n "$ORG" ]; then echo "use --repo or --org, not both" >&2; exit 2; fi
if [ -z "$REPO" ] && [ -z "$ORG" ]; then echo "one of --repo or --org is required" >&2; usage >&2; exit 2; fi
if [ -n "$REPO" ]; then
  case "$REPO" in */*) ;; *) echo "--repo must be owner/name" >&2; exit 2 ;; esac
  SCOPE_URL="https://github.com/$REPO"
  TOKEN_ENDPOINT="repos/$REPO/actions/runners/registration-token"
else
  SCOPE_URL="https://github.com/$ORG"
  TOKEN_ENDPOINT="orgs/$ORG/actions/runners/registration-token"
fi

OS="${UWF_OS:-$(uname -s)}"        # UWF_OS / UWF_ARCH are test hooks
ARCH="${UWF_ARCH:-$(uname -m)}"
case "$OS" in
  Darwin) RUNNER_OS=osx ;;
  Linux) RUNNER_OS=linux ;;
  *) echo "unsupported OS: $OS (macOS and Linux only)" >&2; exit 2 ;;
esac
case "$ARCH" in
  arm64|aarch64) RUNNER_ARCH=arm64 ;;
  x86_64|amd64|x64) RUNNER_ARCH=x64 ;;
  *) echo "unsupported architecture: $ARCH" >&2; exit 2 ;;
esac

export GH_TOKEN="${GH_TOKEN:-${UWF_BOT_TOKEN:-}}"
REG_TOKEN=""

# ---- helpers -------------------------------------------------------------

step() { printf '\n== %s\n' "$*"; }

quote() { case "$1" in *[!A-Za-z0-9_@%+=:,./-]*) printf '%q' "$1" ;; *) printf '%s' "$1" ;; esac; }

# Print a command with the registration token redacted.
show() {
  local out="+" a
  for a in "$@"; do
    if [ -n "$REG_TOKEN" ] && [ "$a" = "$REG_TOKEN" ]; then out="$out <redacted>"; else out="$out $(quote "$a")"; fi
  done
  printf '%s\n' "$out"
}
run() { show "$@"; [ "$DRY" -eq 1 ] || "$@"; }
run_sh() { printf '+ %s\n' "$1"; [ "$DRY" -eq 1 ] || bash -c "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

node_major() { have node && node --version | sed 's/^v//; s/\..*//' || echo 0; }

load_nvm() {
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  [ -s "$nvm_dir/nvm.sh" ] || return 1
  export NVM_DIR="$nvm_dir"
  set +eu; . "$nvm_dir/nvm.sh"; set -eu
}

# Set KEY=VALUE in an env file without printing the value; no-op when unchanged.
set_env_line() {
  local file="$1" key="$2" value="$3" tmp
  if [ -f "$file" ] && grep -qxF "$key=$value" "$file"; then return 0; fi
  tmp="$(mktemp)"
  { [ -f "$file" ] && grep -v "^$key=" "$file" || true; } >"$tmp"
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  mv "$tmp" "$file"
  chmod 600 "$file"
}

# ---- preflight -----------------------------------------------------------

step "plan: $OS/$ARCH -> runner $RUNNER_OS-$RUNNER_ARCH, name=$NAME, labels=$LABELS, scope=$SCOPE_URL, dir=$DIR"
[ "$DRY" -eq 1 ] && echo "(dry-run: nothing is executed; the plan below is for a fresh machine)"

for v in GH_TOKEN ANTHROPIC_API_KEY OPENAI_API_KEY; do
  if [ -n "${!v:-}" ]; then echo "env $v: set"; else
    echo "env $v: NOT SET"
    if [ "$DRY" -eq 0 ]; then
      [ "$v" = GH_TOKEN ] && echo "missing: set GH_TOKEN (or UWF_BOT_TOKEN) to the bot token" >&2 || echo "missing: export $v before provisioning" >&2
      exit 1
    fi
  fi
done

# ---- 1. Node 24 ----------------------------------------------------------

step "1. Node >= 24"
if [ "$DRY" -eq 0 ] && [ "$(node_major)" -ge 24 ]; then
  echo "ok: node $(node --version) already installed"
else
  if [ "$DRY" -eq 0 ] && load_nvm; then
    run nvm install 24
    run nvm alias default 24
    run nvm use 24
  elif [ "$OS" = Darwin ] && { [ "$DRY" -eq 1 ] || have brew; }; then
    run brew install node@24
    run brew link --overwrite --force node@24
  elif [ "$DRY" -eq 1 ] || [ "$OS" = Linux ]; then
    run_sh 'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash'
    if [ "$DRY" -eq 1 ]; then
      run nvm install 24
      run nvm alias default 24
    else
      load_nvm; run nvm install 24; run nvm alias default 24; run nvm use 24
    fi
  else
    echo "cannot install Node: no nvm and no Homebrew; install one and re-run" >&2; exit 1
  fi
fi

# ---- 2. CLIs -------------------------------------------------------------

step "2. claude CLI (@anthropic-ai/claude-code)"
if [ "$DRY" -eq 0 ] && have claude; then echo "ok: claude already installed"; else run npm install -g @anthropic-ai/claude-code; fi

step "3. codex CLI (@openai/codex)"
if [ "$DRY" -eq 0 ] && have codex; then echo "ok: codex already installed"; else run npm install -g @openai/codex; fi

step "4. gh"
if [ "$DRY" -eq 0 ] && have gh; then
  echo "ok: gh already installed"
elif [ "$OS" = Darwin ]; then
  run brew install gh
elif [ "$DRY" -eq 0 ] && have dnf; then
  run $SUDO dnf install -y gh
else
  run_sh '(type -p wget >/dev/null || (sudo apt-get update && sudo apt-get install -y wget)) && sudo mkdir -p -m 755 /etc/apt/keyrings && wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null && sudo apt-get update && sudo apt-get install -y gh'
fi

step "5. verify bot identity (gh uses GH_TOKEN; no interactive login)"
run gh auth status

# ---- 6. Actions runner ---------------------------------------------------

step "6. download the Actions runner ($RUNNER_OS-$RUNNER_ARCH) into $DIR"
if [ "$DRY" -eq 0 ] && [ -x "$DIR/config.sh" ]; then
  echo "ok: runner already unpacked in $DIR"
else
  if [ "$DRY" -eq 1 ]; then
    RV='X.Y.Z'
    echo '+ RUNNER_VERSION=X.Y.Z  # $(gh api repos/actions/runner/releases/latest --jq .tag_name | sed "s/^v//")'
  else
    RV="$(gh api repos/actions/runner/releases/latest --jq .tag_name | sed 's/^v//')"
  fi
  ARCHIVE="actions-runner-$RUNNER_OS-$RUNNER_ARCH-$RV.tar.gz"
  run mkdir -p "$DIR"
  run curl -fsSL -o "$DIR/$ARCHIVE" "https://github.com/actions/runner/releases/download/v$RV/$ARCHIVE"
  run tar xzf "$DIR/$ARCHIVE" -C "$DIR"
  run rm "$DIR/$ARCHIVE"
  if [ "$OS" = Linux ]; then run $SUDO "$DIR/bin/installdependencies.sh"; fi
fi

step "7. service environment: API keys and PATH into $DIR/.env (mode 600, values not printed)"
if [ "$DRY" -eq 1 ]; then
  echo "+ write ANTHROPIC_API_KEY, OPENAI_API_KEY, PATH to $DIR/.env"
else
  NODE_BIN="$(dirname "$(command -v node)")"
  set_env_line "$DIR/.env" ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
  set_env_line "$DIR/.env" OPENAI_API_KEY "$OPENAI_API_KEY"
  set_env_line "$DIR/.env" PATH "$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  echo "ok: $DIR/.env up to date"
fi

step "8. register with labels $LABELS"
if [ "$DRY" -eq 0 ] && [ -f "$DIR/.runner" ]; then
  echo "ok: already registered (.runner exists)"
else
  if [ "$DRY" -eq 1 ]; then
    echo "+ REG_TOKEN=\$(gh api --method POST $TOKEN_ENDPOINT --jq .token)   # needs the bot permission documented in the guide"
    REG_ARG="__REGISTRATION_TOKEN__"
  else
    REG_TOKEN="$(gh api --method POST "$TOKEN_ENDPOINT" --jq .token)"
    REG_ARG="$REG_TOKEN"
  fi
  run "$DIR/config.sh" --unattended --url "$SCOPE_URL" --token "$REG_ARG" --name "$NAME" --labels "$LABELS" --work _work --replace
  REG_TOKEN=""
fi

step "9. install and start the service"
# Linux installs a systemd unit (needs root, runs as the current user); macOS installs a
# LaunchAgent for the current user (no sudo).
if [ "$OS" = Linux ]; then
  SVC_PREFIX="${SUDO:+$SUDO }"; SVC_INSTALL_ARGS="install $(id -un)"
else
  SVC_PREFIX=""; SVC_INSTALL_ARGS="install"
fi
svc_running() {
  local out
  out="$(cd "$DIR" && ${SVC_PREFIX}./svc.sh status 2>&1 || true)"
  printf '%s' "$out" | grep -Eiq 'not started|inactive|stopped|not installed' && return 1
  printf '%s' "$out" | grep -Eiq 'active \(running\)|started'
}
if [ "$DRY" -eq 0 ] && [ -f "$DIR/.service" ]; then
  echo "ok: service already installed"
else
  run_sh "cd '$DIR' && ${SVC_PREFIX}./svc.sh $SVC_INSTALL_ARGS"
fi
if [ "$DRY" -eq 0 ] && svc_running; then
  echo "ok: service already running"
else
  run_sh "cd '$DIR' && ${SVC_PREFIX}./svc.sh start"
fi

step "10. doctor"
if [ "$DRY" -eq 1 ]; then
  echo "+ bash $SELF_DIR/doctor.sh --name $NAME --dir $DIR"
else
  bash "$SELF_DIR/doctor.sh" --name "$NAME" --dir "$DIR"
fi
