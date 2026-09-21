#!/usr/bin/env bash
# Install the three Hermes desktop plugins, and the gateway scripts they call.
#
#   ./install.sh                          # app plugin folder defaults per-OS
#   ./install.sh /path/to/desktop-plugins # point it at the app folder directly
#   HERMES_HOME=/opt/hermes ./install.sh  # non-default gateway home
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# Gateway home defaults per OS. The app can be on Windows while the gateway is
# on Linux; HERMES_HOME is always the gateway's home, never the app's.
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) DEFAULT_HERMES_HOME="${LOCALAPPDATA:-$HOME/AppData/Local}/hermes" ;;
  *) DEFAULT_HERMES_HOME="$HOME/.hermes" ;;
esac
HERMES_HOME=${HERMES_HOME:-$DEFAULT_HERMES_HOME}
PLUGIN_IDS="deepseek-rate opencode-usage session-usage"
# Shipped placeholder inside the plugins; replaced with this gateway's scripts path.
SCRIPTS_TOKEN="__HERMES_SCRIPTS__"

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) DEFAULT_DEST="${LOCALAPPDATA:-$HOME/AppData/Local}/hermes/desktop-plugins" ;;
  *) DEFAULT_DEST="$HERMES_HOME/desktop-plugins" ;;
esac
DEST=${1:-$DEFAULT_DEST}

# Normalise scripts path to forward slashes, even on Windows, because the
# plugins execute through the gateway shell where C:/... style paths work.
SCRIPTS_PATH="$HERMES_HOME/scripts"
# Convert any Windows/MSYS path to a drive-letter forward-slash form that both
# cmd.exe and Windows Python accept (C:/Users/... rather than /c/Users/...).
if command -v cygpath >/dev/null 2>&1; then
  SCRIPTS_PATH=$(cygpath -m "$SCRIPTS_PATH")
elif [[ "$SCRIPTS_PATH" =~ ^[A-Za-z]:\\\\ ]]; then
  drive=${SCRIPTS_PATH:0:1}
  rest=${SCRIPTS_PATH:3}
  SCRIPTS_PATH="${drive^^}:/${rest//\\//}"
fi
# Ensure forward slashes everywhere; the final separator between HERMES_HOME and
# scripts is already '/', but a Windows HERMES_HOME may contain '\'.
SCRIPTS_PATH="${SCRIPTS_PATH//\\//}"

mkdir -p "$DEST"
for id in $PLUGIN_IDS; do
  mkdir -p "$DEST/$id"
  cp "$HERE/desktop-plugins/$id/plugin.js" "$DEST/$id/plugin.js"
  echo "installed $id -> $DEST/$id/plugin.js"
done

# Point the plugins at THIS gateway's scripts. Only the SCRIPTS_DIR line is
# touched; nothing else in the file changes.
for id in session-usage opencode-usage; do
  if command -v perl >/dev/null 2>&1; then
    # Pass the path through the environment so perl does not interpret \U, \t,
    # \A, \L etc. inside a Windows path as replacement-string escapes.
    HDP_SCRIPTS_PATH="$SCRIPTS_PATH" perl -pi -e 's#\Q__HERMES_SCRIPTS__\E#$ENV{HDP_SCRIPTS_PATH}#g' "$DEST/$id/plugin.js"
    echo "rewrote script paths in $id for HERMES_HOME=$HERMES_HOME"
  elif sed --version >/dev/null 2>&1; then
    NEW=$(printf '%s' "$SCRIPTS_PATH" | sed 's/[\/&]/\\&/g')
    sed -i "s#$SCRIPTS_TOKEN#$NEW#g" "$DEST/$id/plugin.js"
    echo "rewrote script paths in $id for HERMES_HOME=$HERMES_HOME"
  else
    echo "WARNING: no perl or GNU sed here."
    echo "Edit the SCRIPTS_DIR line by hand in $DEST/$id/plugin.js"
    echo "so it points at $SCRIPTS_PATH"
  fi
done

# Gateway scripts: the plugins call these over the gateway's shell.exec RPC.
mkdir -p "$HERMES_HOME/scripts"
cp "$HERE/gateway-scripts/model_price_lookup.py" "$HERMES_HOME/scripts/"
cp "$HERE/gateway-scripts/opencode_go_usage.py" "$HERMES_HOME/scripts/"
cp "$HERE/gateway-scripts/opencode_go_models.py" "$HERMES_HOME/scripts/"
chmod +x "$HERMES_HOME/scripts/model_price_lookup.py" "$HERMES_HOME/scripts/opencode_go_usage.py" "$HERMES_HOME/scripts/opencode_go_models.py"
echo "installed gateway scripts -> $HERMES_HOME/scripts"

# Best-effort dev-credits config: exact billed spend only reaches the app when
# the gateway runs with HERMES_DEV_CREDITS truthy.
CONFIG_FILE="$HERMES_HOME/config.yaml"
if [ -f "$CONFIG_FILE" ]; then
  CURRENT=$(grep -E "^\s*HERMES_DEV_CREDITS\s*:" "$CONFIG_FILE" 2>/dev/null | tail -1 | sed -E 's/.*:\s*//' | tr '[:upper:]' '[:lower:]' || true)
  if [ "$CURRENT" = "1" ] || [ "$CURRENT" = "true" ] || [ "$CURRENT" = "yes" ]; then
    echo "HERMES_DEV_CREDITS already set ($CURRENT); leaving config.yaml unchanged"
  else
    BACKUP="$CONFIG_FILE.bak-dev-credits-$(date +%Y%m%d)"
    cp "$CONFIG_FILE" "$BACKUP"
    echo "backed up config.yaml -> $BACKUP"
    if command -v hermes >/dev/null 2>&1; then
      hermes config set terminal.env.HERMES_DEV_CREDITS 1
      echo "set terminal.env.HERMES_DEV_CREDITS = 1 via hermes config"
    else
      echo "hermes CLI not on PATH; set it yourself with:"
      echo "  hermes config set terminal.env.HERMES_DEV_CREDITS 1"
    fi
  fi
else
  echo "no $CONFIG_FILE found; skipping HERMES_DEV_CREDITS step"
fi

cat <<'DONE'

Next:
  1. opencode-usage needs OPENCODE_GO_API_KEY in the gateway's .env
  2. session-usage's exact billed-spend row needs HERMES_DEV_CREDITS=1 in the
     gateway config (install.sh sets it when config.yaml exists and hermes is on PATH)
  3. If the app was already running, run "Reload desktop plugins" (Ctrl+K / Cmd+K)
  4. Check the app log for "[plugins] runtime load failed" if a chip is missing
DONE
