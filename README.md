# MEGA Cloud MCP Server

An MCP server that lets an AI assistant operate a **MEGA** cloud account by
wrapping the [MEGAcmd](https://github.com/meganz/MEGAcmd) CLI. It works with any
MCP client: it ships as a **Claude Desktop Extension** (`.mcpb`) for one-click
install, and runs under **OpenAI Codex** or any other MCP client via a standard
MCP server configuration.

## Security model (non-negotiable)

- **Login never goes through the AI.** There is no login tool and no tool accepts
  a password. You authenticate **out-of-band** in the MEGAcmd interactive shell
  (`login <email>`, hidden password prompt); this server only issues
  already-authenticated `mega-*` commands.
- **No session/credential material is ever returned or logged.** `mega_whoami`
  surfaces only your account email. `mega_account` does run `whoami -l` to read
  the plan tier, but a fail-closed allowlist parser returns only plan + storage —
  the raw `session` id, master/recovery key, and payment data are never returned.
- Destructive and data-moving actions (`rm`, `deleteversions`, `export`, `share`,
  `get`, `put`, `mv`) are **confirm-gated** via a two-call token protocol: the first
  call returns a preview plus a single-use token and executes nothing; only a second
  call carrying that token runs.
- **The session store is off-limits to every tool.** MEGAcmd's `session` file holds
  material from which the account **master key** can be recovered, and unlike a
  session id the master key cannot be rotated. No local path that resolves to that
  store — under `$HOME`, beside the MEGAcmd executable on Windows, or through any
  spelling the OS folds to the same object — can be read or written. A bulk backup
  that merely *contains* it is allowed but says so in the preview. Transfers into
  the MEGAcmd program directory are refused too, since a file dropped there would be
  loaded by the MEGAcmd process itself.

> [!NOTE]
> **What the confirmation protocol is and is not.** MCP has no native confirm
> dialog, so the two-call token is a *two-phase commit*, not proof a human agreed:
> the token goes to the model, and nothing stops a model from calling twice in the
> same turn. It reliably prevents accidental one-shot damage and gives your MCP
> client a preview to show you — but the control that actually asks *you* is your
> client's own tool-approval prompt. If you set a tool to "always allow", you are
> removing the human checkpoint, not just the click.

> [!IMPORTANT]
> **These guardrails are enforced at the MCP layer only — they do not sandbox
> MEGAcmd itself.** They limit what an AI can do *through this server's tools*.
> If you run this server inside a CLI or coding agent that **also has shell /
> terminal access**, that agent can bypass this server entirely and invoke the
> `mega-*` binaries directly against your already-authenticated MEGAcmd session.
> That reaches account-security commands this server deliberately does **not**
> expose — e.g. `passwd` (change your account password) and `masterkey` (print
> your master/recovery key) — as well as the data-moving and session commands it
> normally confirm-gates (`rm`, `export`, `share`, `logout`, `killsession`),
> with no confirmation prompt. MEGAcmd keeps a single shared local session, so
> **any process on your machine that can run `mega-*` acts as you.**
>
> Only enable this server in an agent whose shell access you trust. A tools-only
> MCP client such as Claude Desktop has no shell, so this bypass does not apply
> there.

## Privacy Policy

This connector is governed by MEGA's privacy policy: **<https://mega.io/privacy>**.

What this extension does with your data:

- **Runs locally.** The MCP server and the MEGAcmd engine it drives run entirely
  on your machine. This extension has no backend and sends nothing to its
  authors.
- **Credentials.** Your MEGA email/password are entered out-of-band in your own
  terminal (the MEGAcmd interactive shell, hidden prompt) and are **never**
  passed through the AI or this connector. No login/credential tool exists. The
  login session is stored only by MEGAcmd, in its local config (`~/.megaCmd`);
  this extension never reads, returns, or transmits it.
- **What reaches the AI model.** Like any tool use, the **arguments you/the model
  provide and the results a tool returns** are sent to your AI provider
  as part of the conversation — e.g. a
  folder you list, a path you act on, or a public link you create. The extension
  deliberately returns only the requested operation's result (listings are
  capped) and never local file contents or session data.
- **MEGAcmd download.** On first use the extension downloads MEGAcmd from MEGA's
  own servers (`https://mega.nz`) and verifies it before running; no telemetry is
  collected by the extension.
- **Retention/sharing.** This extension stores nothing beyond MEGAcmd's local
  cache/session on your device and shares data with no third party. Data sent to
  your AI provider is handled per that provider's terms.
- **Contact:** <https://mega.io/contact>.

## Getting started

Install the server in your MCP client:

- **Claude Desktop:** double-click `mega-cloud-mcp.mcpb` and approve it.
- **OpenAI Codex plugin:** this repo includes Codex plugin wrapper files:
  `.codex-plugin/plugin.json` and `.mcp.json`. The Codex wrapper runs the
  checked-in single-file bundle at `dist/plugin-server.js`, so an installed
  plugin does not need `node_modules`. Rebuild that bundle after source changes
  with `npm install && npm run build:plugin`. The wrapper does **not** need to
  live on public GitHub unless you want other people or a remote marketplace to
  install it from that source.
- **OpenAI Codex / other MCP clients:** build the server (`npm install && npm run
  build`), then register it as a standard stdio MCP server — for example, in an
  `mcpServers` config block:

  ```json
  {
    "mcpServers": {
      "mega": { "command": "node", "args": ["/absolute/path/to/dist/index.js"] }
    }
  }
  ```

  (Consult your client's docs for its exact MCP config syntax — e.g. Codex uses
  `~/.codex/config.toml`. Optional settings are passed as `env` vars; see the
  `MEGA_MCP_*` keys in `manifest.json`.)

Then, in any client:

1. First time only: when a tool reports MEGAcmd isn't available, run
   **`megacmd_setup`** and approve the one-time download. It verifies MEGAcmd's
   code signature before running anything and does **not** log you in.
2. Log in **out-of-band** (your password never goes through the AI): `mega_whoami`
   prints the exact command — open the MEGAcmd interactive shell it names and run
   `login <your-email>`, entering your password at the hidden prompt. Then retry.
3. You're set — ask the assistant to work with your MEGA files.

## Example prompts

- "List my MEGA cloud drive and show how much storage I'm using."
- "Find every PDF under /Documents modified in the last week."
- "Upload ~/Reports/q2.xlsx to /Work/Reports and then create a public link for it."
  (The assistant will ask you to confirm the upload and the link before doing either.)
- "What MEGA plan am I on and when does it renew?"

## Requirements

- Node.js >= 18
- MEGAcmd — acquired automatically on first use (see below). No separate install
  is required.

## How MEGAcmd is obtained

The `.mcpb` stays light and does **not** bundle MEGAcmd. Instead, the server
locates the MEGAcmd binaries in this order:

1. bundled (`vendor/megacmd/<platform-arch>/`, if ever shipped)
2. a user-configured directory (`megacmd_dir` setting)
3. the **standard OS install** (macOS: `/Applications/MEGAcmd.app`)
4. the per-user **cache** (fallback when the standard location isn't writable)
5. the system `PATH`

`megacmd_setup` installs MEGAcmd for you on first use, **verifying it before
running anything**. It is confirm-gated (you approve the one-time download) and
never logs you in. It installs to the **standard location** so the OS's MEGAcmd
client auto-spawns the server natively.

Per-platform status:

- **macOS** — fully implemented and validated. Installs MEGAcmd.app to
  `/Applications` (falls back to a per-user cache if `/Applications` isn't
  writable). Integrity: Developer-ID code signature + notarization (team
  `T9RH74Y7L9`) verified before execution. A SHA-256 pin is optional (MEGA
  publishes none and the URL rolls); set `MEGA_MCP_DOWNLOAD_SHA256` to enforce one.
- **Windows** — implemented; on-device validation in progress. Downloads the official MEGAcmd
  NSIS installer, verifies its Authenticode signature (signer organization
  `Mega Limited`) before running, then launches it via `explorer.exe` so MEGAcmd
  installs **standalone** to the real `%LOCALAPPDATA%\MEGAcmd` — outside the MSIX
  package container, so its server auto-spawn works and the session is shared. The
  install is interactive: complete the dialog, then retry (`megacmd_setup` reports
  an "installing" status until it's detected).
- **Linux** — the standard install needs root (`apt`/`dnf`), which the connector
  can't do for you, so `megacmd_setup` guides you to install MEGAcmd via your
  package manager (from <https://mega.io/cmd>); the connector then detects it on
  `PATH`.

Because MEGAcmd is downloaded from MEGA's own servers (not redistributed by this
extension), the BSD/GPL redistribution concerns do not apply.

## Uninstalling / cleanup

Removing the connector does **not** automatically remove MEGAcmd or your session
(MCPB has no uninstall hook). To fully clean up:

1. Log out (invalidates the session): run the `mega_logout` tool, in a terminal
   `mega-logout`, or revoke the session in the MEGA app (Settings → Sessions).
2. Remove the engine: drag `/Applications/MEGAcmd.app` to the Trash (macOS) /
   remove the package (Linux) / delete `~/Library/Caches/mega-cloud-mcp`
   (if the cache fallback was used).
3. Remove the session store if desired: delete `~/.megaCmd`.

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm run build:plugin # bundle Codex plugin server -> dist/plugin-server.js
npm test           # vitest unit tests (no live MEGAcmd needed)
npm run typecheck

# End-to-end stdio smoke test against the built server:
node scripts/smoke-stdio.mjs
node scripts/smoke-stdio.mjs mega_whoami '{}'

# Build an installable Claude Desktop Extension (.mcpb):
npm run pack            # build -> stage -> validate -> pack  =>  mega-cloud-mcp.mcpb
```

To exercise live MEGA operations you must (1) install MEGAcmd and (2) log in
yourself in the MEGAcmd interactive shell (`login <email>`). The server detects
that out-of-band session automatically.

## Tools

- Setup: `megacmd_setup` (download + verify MEGAcmd on first use; confirm-gated)
- Read-only (auto): `mega_whoami`, `mega_account`, `mega_df`, `mega_ls`,
  `mega_find`, `mega_tree`, `mega_du`, `mega_mount`, `mega_transfers`,
  `mega_version`, `mega_mediainfo`, `mega_attr`, `mega_errorcode`
- Read-only (auto), sync/backup status: `mega_sync_list`, `mega_backup_list`,
  `mega_sync_issues`, `mega_sync_config`
- Read-only matching options: `ls`/`find` accept `usePcre` (Perl regex) and native
  `*`/`?` wildcards. The destructive/exfiltration ops (`rm`/`export`/`share`/`get`)
  also accept `usePcre`, but first show the matched node set in their confirmation
  preview and then act on exactly those nodes.
- **Matching many nodes destructively requires `usePcre`.** Since 1.0.2 the
  destructive and link-creating tools no longer accept native `*`/`?` in a path.
  MEGAcmd expands those **server-side, after you approve**, so the preview could
  name one node while several were affected — `usePcre: true` lists the matches
  before you confirm and operates on exactly those.
- Mutating (auto): `mega_mkdir`, `mega_cp`
- Settings: `mega_config` (show is auto; changing a value is confirm-gated;
  turning HTTPS off is refused)
- Confirm-gated: `mega_mv`, `mega_put`, `mega_get`, `mega_thumbnail`, `mega_rm`,
  `mega_deleteversions`, `mega_export` (create/delete), `mega_share` (add/remove),
  `mega_logout`, `mega_killsession`, `mega_attr_set`, `mega_userattr_set`,
  `mega_user_remove`, `mega_user_verify`, `mega_transfer_control`, `mega_invite`,
  `mega_ipc`, `mega_import`, `mega_sync_add`, `mega_sync_control`,
  `mega_sync_ignore` (add/remove), `mega_backup_add`, `mega_backup_control`
- Opt-in only (`expose_contacts`, off by default — surfaces contact PII):
  `mega_users`, `mega_showpcr`, `mega_userattr`
- Opt-in only (`expose_account_details`, off by default — surfaces your own login
  metadata + financial PII): `mega_sessions`, `mega_balance`
- Opt-in only (`expose_file_contents`, off by default — brings file content into
  the conversation): `mega_cat` (read a file's text, capped to 1 MB / max 10 MB,
  text-only). File content is treated as untrusted data; destructive/exfiltration
  tools stay confirm-gated so embedded instructions cannot cause silent harm.

`mega_account` runs `whoami -l` (the only source of the plan tier) but returns
ONLY plan + storage via a fail-closed allowlist parser — the session list,
balance, and payment history are never surfaced. Login credentials, the master
/ recovery key, and the resumable session id are never accessible through any
tool by design.

The plain-text output parsers (`ls`, `df`, `find`, and the read-only tools) are
written defensively and covered by unit tests.

## License

Wrapper source: MIT. MEGAcmd (downloaded at runtime, not redistributed) is
under a mixed license: the components this project invokes — the background
server, the non-interactive client, the `mega-*` shims, and the `mega-exec`
dispatcher — are BSD-2-Clause (some IPC sources are dual BSD-2-Clause /
GPL-3.0); the interactive MEGAcmd shell is GPL-3.0 and is neither invoked nor
redistributed here. See `LICENSE` and `NOTICE`.
