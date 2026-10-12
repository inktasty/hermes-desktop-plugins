#!/usr/bin/env bash
# Uninstall the three Hermes desktop plugins, and the gateway scripts they call.
#
#   ./uninstall.sh                          # app plugin folder defaults per-OS
#   ./uninstall.sh /path/to/desktop-plugins # point it at the app folder directly
#   HERMES_HOME=/opt/hermes ./uninstall.sh  # non-default gateway home
#
# This is the inverse of install.sh: it removes the plugin folders from the app's
# desktop-plugins directory and the three scripts from the gateway's scripts
# directory. It writes no config and touches nothing else -- in particular it does
# not remove code the plugins did not install.
set -euo pipefail

# Gateway home defaults per OS. HERMES_HOME is always the gateway's home, never
# the app's (see install.sh).
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) DEFAULT_HERMES_HOME="${LOCALAPPDATA:-$HOME/AppData/Local}/hermes" ;;
  *) DEFAULT_HERMES_HOME="$HOME/.hermes" ;;
esac
HERMES_HOME=${HERMES_HOME:-$DEFAULT_HERMES_HOME}
PLUGIN_IDS="deepseek-rate opencode-usage session-usage"
GATEWAY_SCRIPTS="model_price_lookup.py opencode_go_usage.py opencode_go_models.py"

# The APP's plugin folder -- deliberately NOT derived from HERMES_HOME (see
# install.sh for why the two can differ).
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) DEFAULT_DEST="${LOCALAPPDATA:-$HOME/AppData/Local}/hermes/desktop-plugins" ;;
  *) DEFAULT_DEST="$HOME/.hermes/desktop-plugins" ;;
esac
DEST=${1:-$DEFAULT_DEST}

removed=0
for id in $PLUGIN_IDS; do
  target="$DEST/$id"
  if [[ -d "$target" ]]; then
    rm -rf "$target"
    echo "removed $target"
    removed=$((removed + 1))
  else
    echo "absent  $target"
  fi
done

for name in $GATEWAY_SCRIPTS; do
  target="$HERMES_HOME/scripts/$name"
  if [[ -e "$target" ]]; then
    rm -f "$target"
    echo "removed $target"
    removed=$((removed + 1))
  else
    echo "absent  $target"
  fi
done

cat <<DONE

Removed $removed item(s).
Next:
  1. If the app was running, run "Reload desktop plugins" (Ctrl+K / Cmd+K) so the
     chips disappear without a restart.
  2. Nothing else was touched: no config, no .env, no HERMES_DEV_CREDITS flag.
DONE
