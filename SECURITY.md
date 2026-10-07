# Security model

This connector lets an AI assistant operate a MEGA account through MEGAcmd. This
page says what it defends against, what it does not, and the rules the code keeps.
Security reviews are judged against it.

## What it defends against

**An assistant that has been misled.** Text the assistant reads — file names, file
contents, web pages, messages — can carry instructions written by someone else.
The connector assumes any tool call may come from such instructions, and that the
user approves actions by reading the confirmation preview their app shows.

## Out of scope

- **Software already running on the user's computer** (malware, another app with
  the user's permissions, an administrator). It can read MEGAcmd's session store
  directly, replace installed binaries, or run its own MEGAcmd, without going
  through this connector.
- **Defects in MEGAcmd or the MEGA SDK themselves.**
- **The user's own deliberate actions**, including approving a preview, or setting
  a tool to "always allow" in their app (which removes the approval step).

## Rules the code keeps

1. **Login never passes through the assistant.** No tool takes the account password
   or returns session or key material.
2. **The session store is never read, written, uploaded, downloaded into, copied,
   moved, shared or published** — locally (`~/.megaCmd` and its other locations,
   in any spelling of the path) or as a copy in the cloud (a `.megaCmd` folder, a
   wildcard that could match one, or a folder that contains one).
3. **What runs is what was previewed.** Every argument that changes a confirmed
   command is shown in its preview and bound into its confirmation token; every
   target is listed (at most 200 per confirmation); MEGAcmd reads back exactly the
   words that were sent (`src/argv.ts`), so no value turns into an option.
4. **Transfers never write into the directories the connector depends on**: the
   MEGAcmd program and cache directories, the plugin's data directory (which holds
   the file-reading choice) and the macOS login helper — whether the destination is
   inside one of them or above it.
5. **File contents reach the assistant only after the user agreed**, through the
   app's settings or the confirm-gated `mega_file_reading`. Turning reading off
   takes effect for every running server process sharing the plugin's data folder.
6. **Third-party email addresses are shown only after the user agreed** (the
   "Expose contact tools" setting, or a confirmation): contact lists, share
   recipients, and the people who shared folders with the user.

Rules 2-4 are enforced once more for every MEGAcmd call, whatever tool built it
(`src/invocation.ts`), on top of each tool's own checks.

## Known limits

- The two-call confirmation is a protocol between the connector and the app. It
  guarantees that a preview exists and matches what runs; it cannot prove that a
  person read it. That is the app's approval prompt.
- Signature checks of the MEGAcmd binaries happen before the first command of a
  process; a binary replaced afterwards by other software is out of scope (above).
- On Windows, only `MEGAclient.exe` and `MEGAcmdServer.exe` are signature-checked,
  not the DLLs next to them.

## Reporting

Please report vulnerabilities to MEGA through https://mega.io/contact.
