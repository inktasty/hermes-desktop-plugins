#!/usr/bin/env bash
# Install the three Hermes desktop plugins, and the gateway scripts they call.
#
#   ./install.sh                          # app plugin folder defaults per-OS
#   ./install.sh /path/to/desktop-plugins # point it at the app folder directly
#   HERMES_HOME=/opt/hermes ./install.sh  # non-default gateway home
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
HERMES_HOME=${HERMES_HOME:-$HOME/.hermes}
PLUGIN_IDS="deepseek-rate opencode-usage session-usage"
# Shipped default inside the plugins; always rewritten to $HERMES_HOME below.
SHIPPED_HOME="/home/ubuntu/.hermes"

case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) DEFAULT_DEST="${LOCALAPPDATA:-$HOME/AppData/Local}/hermes/desktop-plugins" ;;
  *) DEFAULT_DEST="$HERMES_HOME/desktop-plugins" ;;
esac
DEST=${1:-$DEFAULT_DEST}

mkdir -p "$DEST"
for id in $PLUGIN_IDS; do
  mkdir -p "$DEST/$id"
  cp "$HERE/desktop-plugins/$id/plugin.js" "$DEST/$id/plugin.js"
  echo "installed $id -> $DEST/$id/plugin.js"
done

# Point the plugins at THIS gateway's scripts. Only the one command line per
# plugin is touched; nothing else in the file changes.
for id in session-usage opencode-usage; do
  if command -v perl >/dev/null 2>&1; then
    perl -pi -e "s#\Q$SHIPPED_HOME\E/scripts/#$HERMES_HOME/scripts/#g" "$DEST/$id/plugin.js"
    echo "rewrote script paths in $id for HERMES_HOME=$HERMES_HOME"
  elif sed --version >/dev/null 2>&1; then
    OLD=$(printf '%s' "$SHIPPED_HOME" | sed 's/[\/&]/\\&/g')
    NEW=$(printf '%s' "$HERMES_HOME" | sed 's/[\/&]/\\&/g')
    sed -i "s#$OLD/scripts/#$NEW/scripts/#g" "$DEST/$id/plugin.js"
    echo "rewrote script paths in $id for HERMES_HOME=$HERMES_HOME"
  else
    echo "WARNING: no perl or GNU sed here."
    echo "Edit the PRICE_CMD / SCRIPT_CMD line by hand in $DEST/$id/plugin.js"
    echo "so it points at $HERMES_HOME/scripts/"
  fi
done

# Gateway scripts: the plugins call these over the gateway's shell.exec RPC.
mkdir -p "$HERMES_HOME/scripts"
cp "$HERE/gateway-scripts/model_price_lookup.py" "$HERMES_HOME/scripts/"
cp "$HERE/gateway-scripts/opencode_go_usage.py" "$HERMES_HOME/scripts/"
chmod +x "$HERMES_HOME/scripts/model_price_lookup.py" "$HERMES_HOME/scripts/opencode_go_usage.py"
echo "installed gateway scripts -> $HERMES_HOME/scripts"

cat <<'DONE'

Next:
  1. opencode-usage needs OPENCODE_GO_API_KEY in the gateway's .env
  2. If the app was already running, run "Reload desktop plugins" (Ctrl+K / Cmd+K)
  3. Check the app log for "[plugins] runtime load failed" if a chip is missing
DONE
