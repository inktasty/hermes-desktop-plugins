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
HERMES_HOME_EXPLICIT=${HERMES_HOME:+1}   # set only when the caller supplied one
HERMES_HOME=${HERMES_HOME:-$DEFAULT_HERMES_HOME}
PLUGIN_IDS="deepseek-rate opencode-usage session-usage"
# Shipped placeholder inside the plugins; replaced with this gateway's scripts path.
SCRIPTS_TOKEN="__HERMES_SCRIPTS__"

# The APP's plugin folder -- deliberately NOT derived from HERMES_HOME, which is
# the GATEWAY's home (see above). The app only reads its own
# ~/.hermes/desktop-plugins, so deriving one from the other installs the plugins
# where the app never looks, silently, whenever the app is not the gateway.
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) DEFAULT_DEST="${LOCALAPPDATA:-$HOME/AppData/Local}/hermes/desktop-plugins" ;;
  *) DEFAULT_DEST="$HOME/.hermes/desktop-plugins" ;;
esac
DEST=${1:-$DEFAULT_DEST}
if [[ -n "${HERMES_HOME_EXPLICIT:-}" && "$DEST" == "$HERMES_HOME/desktop-plugins" ]]; then
  echo "note: DEST is the GATEWAY home's desktop-plugins, but the app reads its own"
  echo "      ~/.hermes/desktop-plugins. Pass the app's folder as \$1 if they differ."
fi

# Normalise scripts path to forward slashes, even on Windows, because the
# plugins execute through the gateway shell where C:/... style paths work.
SCRIPTS_PATH="$HERMES_HOME/scripts"
# Convert any Windows/MSYS path to a drive-letter forward-slash form that both
# cmd.exe and Windows Python accept (C:/Users/... rather than /c/Users/...).
if command -v cygpath >/dev/null 2>&1; then
  SCRIPTS_PATH=$(cygpath -m "$SCRIPTS_PATH")
elif [[ "$SCRIPTS_PATH" =~ ^[A-Za-z]:\\ ]]; then
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
# The path is spliced into a single-quoted JS string literal, so a quote or a
# backslash in it has to be escaped for the literal (`#`/`&`/`/` additionally for
# sed). A path may legitimately contain any of those.
JS_PATH=${SCRIPTS_PATH//\\/\\\\}
JS_PATH=${JS_PATH//\'/\\\'}
SED_PATH=$(printf '%s' "$JS_PATH" | sed 's/[\/&#\\]/\\&/g')

for id in session-usage opencode-usage; do
  target="$DEST/$id/plugin.js"
  if command -v perl >/dev/null 2>&1; then
    # Pass the path through the environment so perl does not interpret \U, \t,
    # \A, \L etc. inside a Windows path as replacement-string escapes.
    HDP_SCRIPTS_PATH="$JS_PATH" perl -pi -e 's#\Q__HERMES_SCRIPTS__\E#$ENV{HDP_SCRIPTS_PATH}#g' "$target"
  elif [[ "$(uname -s)" == Darwin* || "$(uname -s)" == *BSD* ]]; then
    sed -i '' "s#$SCRIPTS_TOKEN#$SED_PATH#g" "$target"   # BSD/macOS sed
  else
    sed -i "s#$SCRIPTS_TOKEN#$SED_PATH#g" "$target"      # GNU sed
  fi
  # Whichever tool ran, the placeholder must be gone: a plugin still carrying it
  # refuses every call, so failing loudly beats a silently broken install.
  if grep -q "$SCRIPTS_TOKEN" "$target"; then
    echo "ERROR: could not rewrite $SCRIPTS_TOKEN in $target"
    echo "       edit its SCRIPTS_DIR line by hand to point at $SCRIPTS_PATH"
    exit 1
  fi
  echo "rewrote script paths in $id -> $SCRIPTS_PATH"
done

# Gateway scripts: the plugins call these over the gateway's shell.exec RPC.
mkdir -p "$HERMES_HOME/scripts"
cp "$HERE/gateway-scripts/model_price_lookup.py" "$HERMES_HOME/scripts/"
cp "$HERE/gateway-scripts/opencode_go_usage.py" "$HERMES_HOME/scripts/"
cp "$HERE/gateway-scripts/opencode_go_models.py" "$HERMES_HOME/scripts/"
chmod +x "$HERMES_HOME/scripts/model_price_lookup.py" "$HERMES_HOME/scripts/opencode_go_usage.py" "$HERMES_HOME/scripts/opencode_go_models.py"
echo "installed gateway scripts -> $HERMES_HOME/scripts"

# The exact billed-spend row in session-usage needs the GATEWAY process itself to run with
# HERMES_DEV_CREDITS=1. That is a development readout (upstream gates the field on it on
# purpose, and it logs a credits line for every response), so this installer does not turn
# it on for you and does not touch any config. README: "Optional: exact billed spend".

cat <<'DONE'

Next:
  1. opencode-usage needs OPENCODE_GO_API_KEY in the gateway's .env
  2. optional: session-usage's exact billed-spend row needs HERMES_DEV_CREDITS=1
     in the GATEWAY's own environment, then a gateway restart. See README
     "Optional: exact billed spend". Without it the row is an estimate.
  3. If the app was already running, run "Reload desktop plugins" (Ctrl+K / Cmd+K)
  4. Check the app log for "[plugins] runtime load failed" if a chip is missing
     Windows:     %LOCALAPPDATA%\hermes\logs\desktop.log
     macOS/Linux: ~/.hermes/logs/desktop.log
DONE
