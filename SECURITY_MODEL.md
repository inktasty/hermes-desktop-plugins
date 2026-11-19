# Security model: hermes-desktop-plugins

This file describes the plugins' design, trust boundaries and the assets they handle. It covers this repository only.

## Components

| Name | Code |
|---|---|
| Hermes Plugins | `desktop-plugins/*/plugin.js` (`deepseek-rate`, `opencode-usage`, `session-usage`) |
| Hermes Gateway Scripts | `gateway-scripts/*.py`, `install.sh`, `uninstall.sh`, `deploy-windows.ps1` |

Test-only code: `verify/`.

## Trust boundaries and entry points

- **Hermes Plugins**: JavaScript loaded by the Hermes desktop app. They fetch data through the gateway's `shell.exec` RPC, running scripts from the deployed scripts directory (`__HERMES_SCRIPTS__`). Inputs include model names, session data and models.dev registry data.
- **Hermes Gateway Scripts**: Python run on the gateway host. They read `OPENCODE_GO_API_KEY*` and the credential pool, and call the OpenCode Go and models.dev APIs.
- **Install scripts**: copy the plugins and scripts into the Hermes app and gateway directories.

## Assets

1. API keys and credentials: OpenCode Go keys (the credential pool) and any DeepSeek key.
2. Command execution on the gateway host through `shell.exec`.
3. Accuracy of the usage, quota and cost data the plugins show.

## Attackers

- In scope: local attackers on the machine running Hermes or the gateway, malicious or tampered data from models.dev or other API responses, and prompt-injected content that reaches session data or model names.
- Out of scope: attackers on the public internet reaching the gateway directly.

## Existing controls

- Plugins quote command arguments before passing them to `shell.exec`.
- Scripts take keys from environment variables or the credential pool, not from the repository.
- `verify/harness.mjs` runs regression tests offline against a stubbed SDK.
