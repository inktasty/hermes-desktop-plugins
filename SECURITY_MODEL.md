<!-- One threat model covers wiz101-app, DeerQuest-clean and hermes-desktop-plugins. This repo's components: Hermes Plugins, Hermes Gateway Scripts. Keep this file in sync across the three repos. -->

# Threat model: wiz101-app, DeerQuest-clean, hermes-desktop-plugins

Owner: Luke (inktasty). Built from the code (no SECURITY_MODEL.md in any repo) plus the owner's answers (marked **[owner]**). Nothing here comes from a separate infrastructure repo. DeerQuest's deploy units live in the repo itself (`deerquest.service`, `app/deploy/*.service|timer`).

## Components

| Name | Repo | Code |
|---|---|---|
| wiz101 Backend API | wiz101-app | `backend/main.py`, `database.py`, `chat.py`, `wikitext_parser.py`, `wizbuilder_drift.py` |
| wiz101 Frontend | wiz101-app | `frontend/` (vanilla JS SPA, `js/app.js`, `js/graph.js`) |
| wiz101 Desktop Shell | wiz101-app | `src-tauri/` (`src/lib.rs`, `capabilities/default.json`, `tauri.conf.json`, `harvester/inject.js`) |
| DeerQuest Server | DeerQuest-clean | `app/server.py` plus the stores it loads (`store.py`, `memory.py`, `thread.py`, `factedit.py`, `sections.py`, ...) and `app/static/` |
| DeerQuest Automation | DeerQuest-clean | `app/automation/` (intake, LLM, push, quest keeper, today writer, backup, watchdog), `app/sources/`, `app/deploy/`, `plugin/deerquest/` |
| Hermes Plugins | hermes-desktop-plugins | `desktop-plugins/*/plugin.js` |
| Hermes Gateway Scripts | hermes-desktop-plugins | `gateway-scripts/*.py`, `install.sh`, `uninstall.sh`, `deploy-windows.ps1` |

Scratch and dev code, which is lower priority: wiz101 `backend/_*.py`, DeerQuest `mockups/`, `design/`, `tools/notes_server.py`, hermes `verify/`.

## Trust boundaries and entry points

- **wiz101 Backend API**: FastAPI on `127.0.0.1:8021` (the `HOST` env can override it; `_start_backend.py` binds `0.0.0.0`). CORS allows the tauri origins and `localhost:8021`. Its write routes are `/api/wiki/ingest`, `/api/wiki/ingest_wikitext`, `/api/compare`, `/api/settings/llm` (stores the user's LLM base_url and API key), `/api/settings/llm/test`, `/api/chat` (the LLM has DB lookup tools) and `/api/knowledge-feedback`. The harvest-error routes are gated by `_require_dev_tools`. Most routes have no auth. Untrusted input comes from wiki page content (via `harvester/inject.js` running inside the third-party wiki window), from LLM responses, from wizbuilder.net data, and from any local process or web page that can reach localhost:8021.
- **wiz101 Desktop Shell**: Tauri v2 with `csp: null` and `shell:allow-execute`/`shell:allow-spawn` on all windows (`"windows": ["*"]`), which includes the wiki-viewer window that loads third-party content. It spawns the backend with a bare `python` from PATH.
- **DeerQuest Server**: a `ThreadingHTTPServer` on `127.0.0.1:8798`. **[owner]** The owner uses it through Tailscale Serve at its `.ts.net` address, so any browser on the tailnet that the owner uses can reach it cross-site. `authorized()` allows the configured `AUTH_EMAIL` **or a missing or empty `Tailscale-User-Login` header** (local processes). Localhost-only routes (`POST /api/today/cards`, the plugin routes) refuse any Tailscale header and require `X-DeerQuest-Token`.
- **DeerQuest Automation**: systemd timers run LLM-driven jobs on personal data. `intake.py` runs tesseract/pdftotext on uploaded files. Sources shell out to `gh` and calendar tools. LLM output and email content are untrusted (prompt injection).
- **Hermes Plugins**: JS loaded by the Hermes desktop app. Session Usage and OpenCode Go Usage call the gateway's `shell.exec` RPC with command strings built from a scripts path and arguments. DeepSeek Rate and Session Usage fetch session data through `session.stats` or `session.usage`. Model names, session data and models.dev registry data are inputs.
- **Hermes Gateway Scripts**: Python run on the gateway. The OpenCode Go scripts read `OPENCODE_GO_API_KEY*` values and the credential pool and call OpenCode endpoints. The pricing and model scripts read Hermes's local models.dev registry cache rather than calling models.dev directly.

## Assets (all marked critical by the owner) **[owner]**

1. DeerQuest personal data: email, calendar, money, health, food logs, Hermes memory and facts.
2. API keys and credentials: OpenCode Go and DeepSeek keys, the wiz101 user's LLM key, the GitHub token used by `gh`, and the DeerQuest token.
3. Command execution on the owner's machine or the Hermes gateway (and, for wiz101, on its users' machines).
4. Integrity of the wiz101 gear database (`gear.db`, `wiki_data`, `curated_sets`).

## Attackers **[owner]**

- In scope: people on the owner's tailnet or with access to the owner's machine (local and LAN attackers); malicious web pages that reach localhost services (CSRF, DNS rebinding); malicious wiki or third-party content; prompt-injected LLM, email or document content.
- In scope: **wiz101-app will be publicly released**, so its users' machines are targets too (malicious wiki content, a malicious LLM endpoint, local web pages hitting port 8021).
- Out of scope: attackers on the public internet reaching DeerQuest or wiz101 directly. Neither is exposed beyond Tailscale or localhost.

## Existing controls

- Localhost binds (wiz101 by default; DeerQuest always), Tailscale identity header check, DeerQuest shared token for local writer and plugin routes, and the FastAPI CORS allowlist.
- wiz101 uses parameterized SQLite queries in `database.py` (verify per finding) and rejects ambiguous wiki binds with 409.
- Session Usage quotes the script path and arguments before `shell.exec`. OpenCode Go Usage quotes the script path and validates its argument tokens before passing them unquoted.

## Out of scope and accepted risk

- **[owner]** Public-internet attackers are out of scope: neither DeerQuest nor wiz101 is exposed beyond Tailscale or localhost. (The owner chose "use the draft's assumptions".)
- The owner did **not** rule out tailnet or local attackers, or any asset, so findings that need those attackers stay in scope.
- Calling scratch/dev code lower priority (listed under Components) is Devin's reading of the code, not something the owner said.

## Open questions

- Is `AUTH_EMAIL` always set in production? An unset value would make `authorized()` permissive.
- **[owner]** Confirmed: DeerQuest is used over Tailscale Serve at its `.ts.net` address. Is the Serve config (which strips or sets `Tailscale-User-Login`) managed anywhere in code?
- Does the public wiz101 release keep `shell:allow-execute` and `csp: null`?
