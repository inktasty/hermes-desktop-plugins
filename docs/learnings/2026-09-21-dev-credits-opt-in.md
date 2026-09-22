# Installers must not flip a dev flag (HERMES_DEV_CREDITS)

## What the flag does

`session-usage` prefers the provider's real billed spend when the payload carries
`dev_credits_spent_micros`. Hermes adds that field only when the process that builds the payload
runs with `HERMES_DEV_CREDITS` truthy; the producer's own comment says it is gated that way "so the
payload stays clean otherwise". While the flag is on the runtime also logs a credits line for every
response.

## Who actually reads it

The producer reads `os.environ` of the gateway (or desktop backend) process. Consequences:

- The flag must be in that process's environment. The gateway's own `.env` works, because the
  dotenv loader writes into `os.environ` at startup and on reload.
- There is no `config.yaml` key for it. `terminal.env` is not a Hermes config key at all
  (`DEFAULT_CONFIG["terminal"]` has `env_passthrough`, and `hermes_cli/config.py`'s config→env
  bridge maps only the listed `TERMINAL_*` keys), so writing that path sets a key nothing reads.
- A file the script edited is not proof the setting took effect. Prove it from the runtime:
  with the flag on, the log fills with `credits ▸` lines; with it off, those lines never appear.

## The decision

An installer changes nothing about the user's runtime. The exact-billed row stays opt-in and is
documented, not enabled:

- `install.sh` writes no config (a step that used to flip `terminal.env.HERMES_DEV_CREDITS` is
  gone, it was a no-op).
- The README section "Optional: exact billed spend" gives the one line to add and the restart that
  makes it take effect, and states what the row shows without it.
- The fallback is not a broken state: the row relabels itself "Session cost (est.)" and shows the
  estimate from tokens and rates, which works on every provider.

## Why it matters beyond this plugin

A plugin that silently turns on a development readout in someone else's gateway is imposing a
behaviour change it does not own, and the flag's own name tells the user it is unsupported. When a
feature needs a dev flag, document it as opt-in and make the default path honest.
