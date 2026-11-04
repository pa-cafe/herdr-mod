# PA Cafe mod for Herdr

Connects Herdr to a PA Cafe. Residents (such as a chief of staff) use coding agents in Herdr as their tools. When a coding agent in a Herdr pane finishes or stops to ask something, the cafe hears about it. Only pane ids, workspace ids and the status leave the machine, never titles, prompts or screen text.

## Install and connect

```sh
herdr plugin install pa-cafe/herdr-mod
herdr plugin action invoke connect --plugin pacafe.herdr
```

Run the same install again to get a newer version. Without a terminal (an agent running it), add `--yes`.

`connect` opens a popup with a code like `BCDF-2345` and opens the cafe in the browser. The barista signs in, checks the code and approves it. The cafe creates a Herdr source and sends its address and signing key back to this terminal, encrypted to a key the popup made, so no key is copied by hand. The cafe shows the connection as done only after this terminal has taken it. The connection is saved in `herdr plugin config-dir pacafe.herdr` as `pacafe.json` (mode 600).

An agent without a Herdr pane can pair from a shell: `PACAFE_ORIGIN=<cafe address> PACAFE_NO_BROWSER=1 node "<plugin root>/connect.mjs"`. It finds the config directory with `herdr plugin config-dir pacafe.herdr`, prints the code and approval link, and exits once the barista approves (no key press needed when there is no terminal).

To bind it to a key, add to Herdr's `config.toml`:

```toml
[[keys.command]]
key = "prefix+P"
type = "plugin_action"
command = "pacafe.herdr.connect"
description = "connect to PA Cafe"
```

`connect` needs an open Herdr workspace for its popup. Without one it prints the error and exits with 1; pair from a shell instead.

Other actions: `status` shows which cafe events go to. `disconnect` removes this machine's Herdr source from the cafe and forgets it here. Pairing again while connected removes the previous source once the new one is saved, so the cafe keeps one Herdr source per machine.

## Notifications

`notify.mjs` handles `pane.agent_status_changed`:

- `done` is sent only if the pane is still done or idle 15 seconds later with the same terminal and completion number.
- `blocked` is sent at once after the current state confirms it.
- Each completion is sent once, even when several hook processes see it. A failed send can be retried with the same delivery id.

The cafe applies its own Herdr dedupe on top (set per source in the cafe: Settings → Sources → Herdr).

## Settings

| Variable | Use |
| --- | --- |
| `PACAFE_ORIGIN` | Cafe address for `connect`; defaults to `https://pacafe.dnplus.dev` |
| `PACAFE_NO_BROWSER` | Set to skip opening the browser |
| `PACAFE_HERDR_URL`, `PACAFE_HERDR_SECRET` | Older manual setup; used only when the mod was never connected |

Requires Node 18 or newer on `PATH` and Herdr 0.9 or newer.
