# MEGA Cloud MCP

Lets Claude work with your **MEGA** cloud account: list and search folders,
check storage, upload and download files, create links, share folders, and
manage syncs and backups. It does this through a local MCP server that drives
[MEGAcmd](https://github.com/meganz/MEGAcmd), MEGA's official command-line
client, on your own computer.

## Where it works

- **Claude Code** (terminal, IDE extensions and the desktop app's Code tab).
- **Cowork** tasks that run on your computer in the Claude desktop app. Cowork
  tasks that run in the cloud, such as ones started on the web or mobile,
  can't reach your computer, so the tools aren't available there.
- **Not in Claude chat** (claude.ai on the web, the desktop app's chat, mobile):
  chat doesn't start local MCP servers, so the plugin's tools are unavailable
  there. For the desktop app's chat, use the MEGA Cloud MCP desktop extension
  described in the [project README](https://github.com/meganz/mega-mcp#readme).

## Requirements

- Node.js 18 or later on your `PATH`. The plugin runs a single prebuilt file
  with `node` and installs nothing from npm.
- MEGAcmd. If it isn't installed, the plugin offers to install it (see below).
- A MEGA account.

## Use it

1. Ask Claude something like "List my MEGA cloud drive and show how much
   storage I'm using".
2. **First time only:** if MEGAcmd isn't installed, Claude calls
   `megacmd_setup`. It shows what it will download and does nothing until you
   approve.
3. **Log in yourself, outside the conversation.** Claude tells you which
   MEGAcmd shell to open; there you run `login <your-email>` and type your
   password at a hidden prompt (on macOS, by double-clicking the provided
   `Login to MEGA.command` file). There is no login tool, and no tool accepts a
   password, so your credentials never pass through Claude.
4. Ask Claude to work with your files. Deleting, moving, uploading, downloading,
   sharing, creating public links, logging out and similar actions use a
   two-step confirmation: the first call returns only a preview, and Claude
   needs your go-ahead before it makes the second call that acts.

Reading a file's contents is off by default. When a request needs it, Claude
calls `mega_file_reading`, which asks you first. Your answer lasts while the
server keeps running unless you say not to ask again, and you can ask Claude to
stop reading your files at any time.

## What the plugin runs, fetches and sends

- **Runs:** `node ${CLAUDE_PLUGIN_ROOT}/dist/plugin-server.js`, a stdio MCP
  server bundled with esbuild (not minified) from the TypeScript source in
  [`src/`](https://github.com/meganz/mega-mcp/tree/main/src). The server runs
  MEGAcmd's `mega-*` commands on your computer.
- **Fetches:** only when you approve `megacmd_setup`, the MEGAcmd installer from
  MEGA's own servers:
  - macOS: `https://mega.nz/MEGAcmdSetup.dmg`. Before running anything, it
    checks the Apple Developer ID signature and notarization (team
    `T9RH74Y7L9`), then installs `MEGAcmd.app` to `/Applications`, or to a
    per-user cache if `/Applications` isn't writable.
  - Windows: `https://mega.nz/MEGAcmdSetup64.exe`. It checks the Authenticode
    signature (signer `Mega Limited`), then opens the installer for you to
    complete.
  - Linux: nothing is downloaded. Claude explains how to install MEGAcmd with
    your package manager from <https://mega.io/cmd>.
- **Sends:** MEGAcmd talks to MEGA's servers to carry out the operations you
  ask for, using the session you created when you logged in. The plugin has no
  backend of its own, sends nothing to its authors and collects no telemetry.
- **Never reads credentials:** the server works out where MEGAcmd keeps its
  login session (`~/.megaCmd`, or beside the MEGAcmd executable on Windows)
  only so it can refuse every tool path that resolves there. It never reads,
  copies or returns that session or any other credential; only MEGAcmd itself
  uses the session you created when you logged in.
- **Shares with Claude:** as with any tool, the arguments Claude passes and the
  results the tools return become part of your conversation, for example a
  folder listing, a path or a public link you created. File contents enter the
  conversation only through `mega_cat`, after you allow file reading. Session
  data, your master key and payment details are never returned by any tool.

## Shell access warning

The confirmations above are enforced by this MCP server only. Claude Code can
also run shell commands, and MEGAcmd keeps one shared login session on your
computer, so a shell command such as `mega-rm` or `mega-export` would act on
your account directly, without these confirmations. The shell also reaches
MEGAcmd's account-security commands (changing your password, printing your
master key) that this plugin deliberately doesn't expose. Read every shell
command that runs a `mega-*` program before you approve it, and don't add
`mega-*` commands to your allowed tools.

## Privacy Policy

This plugin is governed by MEGA's privacy policy: <https://mega.io/privacy>.

- **Data collection:** the plugin collects no personal data and no telemetry.
- **Usage and storage:** it runs entirely on your computer. MEGAcmd stores your
  login session in its own local folder (`~/.megaCmd`), which no tool of this
  plugin can read or return. If you tell Claude not to ask again about file
  reading, that answer is saved as `file-reading.json` in the plugin's data
  directory under `~/.claude/plugins/data/`.
- **Third-party sharing:** none. Your files and commands go only to MEGA,
  through MEGAcmd. Tool arguments and results reach Anthropic as part of your
  Claude conversation and are handled under Anthropic's terms.
- **Data retention:** the plugin keeps nothing beyond the files above. Claude
  Code deletes the plugin's data directory when you uninstall the plugin;
  MEGAcmd and its session stay until you remove them (see below).
- **Contact:** <https://mega.io/contact>.

## Uninstalling

Removing the plugin doesn't remove MEGAcmd or log you out. To clean up fully:

1. Log out: ask Claude to run `mega_logout` before you uninstall, run
   `mega-logout` in a terminal, or end the session in the MEGA app under
   Settings → Sessions.
2. Remove MEGAcmd: on macOS, move `/Applications/MEGAcmd.app` to the Trash
   (or delete `~/Library/Caches/mega-cloud-mcp` if it was installed there); on
   Windows, uninstall MEGAcmd; on Linux, remove the package.
3. Optionally delete MEGAcmd's local data in `~/.megaCmd`.

## Source and license

Source, issues and the full documentation:
<https://github.com/meganz/mega-mcp>. The plugin is MIT licensed (see
`LICENSE`). MEGAcmd is downloaded from MEGA at runtime and isn't redistributed
here; see `NOTICE` for its licenses.
