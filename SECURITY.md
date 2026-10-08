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
   or returns the login session (which resumes a login without the password) or key
   material — including keys MEGAcmd prints as attributes: the S4 configuration of
   a node (`s4`, which can hold storage access keys) and private user attributes
   such as the keyring — nor shows an existing public link's key without asking
   (the key opens the link even where a password was set on it elsewhere), nor
   reads the account's recovery key file
   (`MEGA-RECOVERYKEY.txt` or its name in another language of MEGA's web app, or any
   file holding just such a key).
2. **The session store is never read, written, uploaded, downloaded into, copied,
   moved, shared or published** — locally (`~/.megaCmd` and its other locations,
   in any spelling of the path, and a `.megaCmd` folder anywhere in an uploaded or
   synced folder, such as a home folder) or as a copy in the cloud (a `.megaCmd`
   folder, a wildcard that could match one, or a folder that contains one). Any name
   starting `.megaCmd` counts, as in the sync rule: a copy kept aside (`.megaCmd (1)`,
   `.megaCmd.bak`, `.megaCmd~`) may still hold a valid session. An
   upload leaves the store out (also when it is given a symlink to a folder that
   holds it; symlinks inside a folder rebuilt around the store are not followed,
   as a whole-folder upload does not follow them); a two-way sync leaves it out with `.megaignore`
   rules written before the sync starts - at the end of the root file, which is
   kept out of the sync itself, and excluding only the store and each protected
   folder, by its own path as MEGA names it in the cloud (`%xx` escapes decoded; a path
   with wildcard characters as an exact regex) - and `mega_sync_ignore` cannot undo them (nor remove MEGA's default
   `-:.*`); a new root file starts from MEGA's own default exclusions. A periodic
   backup, which cannot leave anything out, is refused for a folder that contains
   it. No upload, download, copy or move writes a file named `.megaignore` into a
   synced folder or over an existing one (a folder downloaded by path is searched
   for one, and so are uploaded local folders, copied or moved cloud folders and
   a cloud folder about to be synced), and none removes or moves one out of a
   synced folder. A folder is not two-way synced, nor a paused sync resumed, while
   a `.megaignore` lies below its local root (a folder that a link, or a download
   holding one, went into in this session is always searched), and a link is not
   downloaded into a synced folder that holds a `.megaCmd` copy (nor imported there, nor
   opened to others' writes), nor one that could not be searched completely; a sync waits
   for a background download into its folder to finish, and does not start over a root
   `.megaignore` a download may have put there. Names are judged as MEGA uploads them: `%2emegaignore`
   arrives as `.megaignore`. What a public link or an import holds is not known
   before it arrives: those are refused where a protected folder lies below.
3. **What runs is what was previewed.** Every argument that changes a confirmed
   command is shown in its preview and bound into its confirmation token; every
   target is bound too (a list as given, pattern matches pinned by handle -
   patterns start with "/", and a match in someone else's shared folder is
   checked as `//from/...`), and
   the preview lists the first 200 and the total; MEGAcmd reads back exactly the
   words that were sent (`src/argv.ts`), and a path names exactly the node the
   checks looked at (normalized as MEGA does, NFC; no `.`/`..` or empty segments,
   including a leading `//Name`, which MEGAcmd reads as `/Name`;
   no line breaks or other control characters, and no `name#<10 digits>` version
   names as a destination; a file version - which keeps its own name - is
   downloaded or copied, on its own, to an explicit path under the file's name;
   MEGA cannot move one). A preview also says when its
   destination is shared or has a public link, or has a pending invitation (so
   others will see the result); when the destination is itself an existing file
   that would be replaced; and when several items have the name it acts on
   (MEGAcmd acts on all of them); and when the destination is in a two-way synced
   folder, where on this computer the result is written (with the same checks as a
   download); removing or moving something out of a synced folder says what changes
   on this computer, and is refused where that is a protected folder. Copying into
   or creating a folder in a shared, linked or synced folder (or one that cannot be
   checked) asks first and says so - not in the Rubbish Bin or Inbox, where MEGA's
   web app does not ask either - a copy also before
   replacing a file or making a new version of one, and several items need an
   existing destination folder; setting an attribute or a thumbnail says so too.
   What was placed in a folder without a confirmation is named, and bound, when
   that folder is later shared, published, copied or moved (within the session,
   following moves). A thumbnail is set only from an image file. Sharing or
   publishing a folder also says which two-way syncs keep carrying files from this
   computer into it, and is bound to what the folder holds (anything moved in or
   out, or a folder swapped in under its name, voids the confirmation); a download
   into a synced folder says where the sync uploads it and who can see that. What a
   preview says about its destination is checked again on confirmation, and the
   tools that place content in the cloud or open it to others run one at a time. A
   version name in a deletion must name exactly one older version, deleted by its
   handle, and turning file versioning off says so in plain words. A copy, move,
   share, link or deletion is bound to what its source or target holds (anything
   moved in or out after the preview voids it); share and link previews also name
   scheduled backups that write into the target, and uploads, thumbnails and
   attributes changed in it earlier in the session. A copy or move refuses a
   destination that names several items or holds a wildcard (MEGAcmd writes to
   the first item it finds, the checks would see them all), or whose items cannot
   be counted. Shares and links in the
   Rubbish Bin and Inbox are looked up there (a folder moved to the Rubbish Bin
   keeps them). Nothing placed in a two-way synced folder - by a copy, move,
   upload, import or backup - may bring a `.megaignore` along, or reach a protected
   folder below it; a cloud folder about to be synced may not hold one below its
   root. A download into a synced folder is bound to what its source holds and runs
   with no copy or move in between, as does a pattern download; a download that would
   land in a synced folder below its destination - merged, into an existing folder of
   the same name (which MEGA downloads into), or through a symlink - is refused.
   Moving a folder that holds a sync's or a scheduled backup's cloud side says it
   follows; a move between your drive and a share to you says when it makes a
   same-named file's new version - and that with identical content MEGA copies
   nothing and deletes the moved file with all its versions - and cannot rename or
   replace (MEGA would keep the old name). Resuming a paused sync names both sides and runs the checks of a new
   sync on its current cloud folder (refused if that folder moved while paused).
   Giving someone write access to a synced folder says the sync brings what they add
   to this computer, and is refused where that local folder is or holds a protected
   one or a `.megaCmd` copy - and so is the same state reached the other way round: a
   sync started, resumed or moved onto a folder others can write into (shared
   read/write or more, or someone else's share). A download whose landing folder is a
   symlink into a synced folder is refused like one that is the synced folder. A
   download into a folder a scheduled backup copies says the next backup uploads it.
   Copying, downloading, sharing or publishing a file named like MEGA's recovery key
   file (or a copy of one this session made under another name - by a copy, move or
   upload, confirmed or not) says so, and such a copy asks first; uploading a local
   file named like it says so; a download names what was copied into it without a
   confirmation. A folder, copy, move or upload whose name a scheduled backup's
   rotation counts as one of its copies (`<name>_bk_<time>` in that backup's cloud
   folder, which MEGA deletes for good beyond the kept count) asks first and says so;
   an import into such a folder, write access (a share or a writable link) to a folder
   holding one, and an upload merged into a folder holding one say it too. A link's
   expiry is shown in words as MEGAcmd reads it (`m` is months, `M` minutes), anything
   else refused; a link that MEGA made without its password or expiry is withdrawn in
   pattern mode too (judged by MEGAcmd's own answer; a link there before the call is
   left alone), and a password is judged by the link at the end of MEGAcmd's line, not
   by link-shaped text in a node's name (in pattern mode, the link right after the
   node's own path). Showing a sync's filters returns rule lines only. A copy or move
   into a synced folder that a scheduled backup copies says the next backup uploads it
   (and who sees that backup); a list naming one item twice is refused, and list
   previews start with what the destination is. A pattern that names a root itself
   (`/`, `//bin`, `//in`) is refused: MEGA would act on it under its own name (Rubbish
   Bin, Vault), which no check saw. The sync list is read only when it has as many rows
   as a listing without any path in it (a folder name with a line break cannot add a
   row), and a sync two rows answer to is refused. The attribute that marks a backup
   copy's state (`BACKST`) is not set. Changing a sync's filters names both sides of the sync and who sees the cloud side.
   A download or upload that merges into existing folders names the shared or linked
   folders inside its landing (not only above it), and so do sync previews; a scheduled
   backup's folder at a download's landing counts like a synced one; a folder holding the
   recovery key file anywhere inside is named when it is shared, published, copied, moved
   or downloaded; a writable public link counts as others writing; moving a shared or
   linked folder into a synced one says so; cp and mv onto an existing file say that the
   file and all its versions are deleted for good (measured), and a version is not copied
   onto its own file. Previews show invisible characters (zero-width, tags) escaped.
   Every uploaded folder's landing is checked by path: a sync's cloud side at it gets the
   synced landing checks, one below it refuses the upload; under //from and //in only an
   existing folder is uploaded into; a sync is refused while a .megaignore that an upload
   or download of this session carries has not yet arrived where it will land (then the
   nested-rules search refuses it), and waits for transfers whose contents were not known
   (links); that record is kept and asked again on every call, since a folder transfer
   still scanning shows no transfers; nothing is copied or moved into a synced folder
   while such a record lies inside it. Pattern-mode checks use the names as listed.
   Command lines are kept under 8 KB (split by the gate's own count, the other words
   included; a batch still refused counts as failed and the rest run), and values with
   broken Unicode (lone surrogates) are refused. An upload of a filesystem root (`/`)
   is checked folder by folder, each under its own name. A file link is not downloaded
   merged. MEGAcmd is given a download folder in its spelling on disk (a case mismatch
   would make MEGA save under "<name> (1)"). An upload is not merged into a folder that holds a sync's cloud side below it; a
   folder rebuilt around the store goes up under the names MEGA gives (`%xx` decoded);
   removing or moving with the sync list unreadable is refused; a download's audience is
   checked again under the write lock; share, link, sync and backup listings are
   compared in NFC. `mega_cat` reads one file per call (no wildcards), and a name shaped like a
   node handle ("H:" and 8 characters) is refused as a destination or new folder.
4. **Transfers never write into the directories the connector depends on**: the
   MEGAcmd program (on macOS the whole `.app`) and cache directories, its macOS
   socket folder, the plugin's data directory (which holds the file-reading
   choice), the macOS login helper, this connector's own folder, and the hosts' own
   configuration (`~/.claude`, `~/.claude.json`, `~/.codex`, Claude Desktop's
   settings folders - also its `Claude-3p` profile and a packaged Windows install's
   own folder - and `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`CLAUDE_USER_DATA_DIR` when set,
   a leading `~` taken both literally and expanded; the hosts' programs: Claude Code's
   native install and Claude Desktop's app; per project,
   the `.claude`, `.mcp.json` and `.codex` of every project the hosts list - read
   again whenever a host's project list changes - and of the working folder; and
   wherever a symlink inside these leads), which decides
   what runs at the next start — whether the destination is inside one of them,
   above it, or reaches it through a symlink, in any spelling of the path (a
   firmlink such as `/System/Volumes/Data`, case, or letters APFS treats as equal,
   such as `ſ` for `s`, and the `%xx` spellings MEGA writes on Windows, exFAT and
   HFS+), also before such a folder exists. macOS's data volume root
   (`/System/Volumes/Data`) and the folders above it are refused as local paths, by
   name and by identity: they hold every home folder under another spelling (an
   upload of `/` is rebuilt down through them, so the store is still left out); so
   are macOS's `/.vol`, `/.nofollow` and `/.resolve` path forms. Whether a destination is
   in a two-way synced folder is judged the same way. A two-way sync of a folder that
   contains one leaves it out with a `.megaignore` rule. A tool never makes
   downloaded files executable; when MEGAcmd's own file permissions (set by the
   user; POSIX only) include execute bits, the previews of downloads, thumbnail
   downloads, syncs and writes into synced folders say so.
5. **File contents reach the assistant only after the user agreed**, through the
   app's settings or the confirm-gated `mega_file_reading`. (A file downloaded to this
   computer is read, if at all, with the app's own file tools under the app's own
   permissions - not through this connector.) Turning reading off
   takes effect for every running server process sharing the plugin's data folder,
   also for a read already waiting for another operation to finish (asked again
   before and after it runs).

Parts of rules 1-3 are enforced once more for every MEGAcmd call, whatever tool
built it (`src/invocation.ts`), on top of each tool's own checks: only listed
MEGAcmd commands run, credentials are removed from the outputs MEGAcmd prints them
in (and link keys from contact and share listings), the argv round trip and the session-store copy check. Rule 4 is checked by
each transfer tool.

Email addresses - the user's, their contacts', share recipients' and sharers' -
are not treated as secret: listings show them as MEGAcmd prints them. Nor are the
session IDs `mega_sessions` lists: each names a session for `mega_killsession` and
cannot be used to log in (`mega_killsession` takes only an ID's canonical spelling,
so this computer's own session is recognised however it is written).

## Known limits

- The two-call confirmation is a protocol between the connector and the app. It
  guarantees that a preview exists and matches what runs; it cannot prove that a
  person read it. That is the app's approval prompt.
- Signature checks of the MEGAcmd binaries happen before the first command of a
  process; a binary replaced afterwards by other software is out of scope (above).
  The launch-time check itself is kept on purpose, as defence in depth (it also
  stops a damaged or wrong install), even though replaced binaries are out of
  scope - a review should not remove it on that ground.
- On Windows, only `MEGAclient.exe` and `MEGAcmdServer.exe` are signature-checked,
  not the DLLs next to them nor `MEGAcmdShell.exe`.
- MEGA's Linux packages are not code-signed, so on Linux the MEGAcmd found on
  `PATH` is run without a signature or checksum check. On macOS, a MEGAcmd outside
  an `.app` bundle (configured, or found on `PATH`) is not signature-checked either.
- The searches inside a local folder - for `.megaCmd` copies, `.megaignore` files,
  and links into protected or synced folders - stop after 20,000 folders and skip
  folders that cannot be read. For store copies the upload and backup previews say
  so, and a sync gets the `.megaCmd` name rule anyway; the live session store is
  checked by location and always found.
- Symlinks inside the hosts' configuration folders are followed two levels deep
  (through linked folders, and to where a dangling link points), and looked at again
  when such a folder's own entries change: a link added deeper down while the server
  runs is seen only after a restart.
- A sync's `.megaignore` rules compare names folding ASCII letters only, while
  the file systems of macOS and Windows fold Unicode too ("ſ" is "s"). A sync is
  refused while its cloud side holds such a twin of a folder it leaves out, and
  the connector's own transfers check landing names the way the file system does;
  a twin that arrives otherwise after the sync started is not seen.
- A sync leaves a folder out by a rule in its root `.megaignore`; a `.megaignore`
  deeper down is consulted first for what lies below it. No transfer of this
  connector writes one into a synced folder, and a sync is not started or resumed
  over one the search finds, but one delivered later otherwise (a link, the user's
  own, someone with write access) could re-include something there.
- Leaving folders out of a two-way sync relies on MEGA's `.megaignore` rules
  (MEGA SDK `syncfilter.cpp`); the connector writes them before the sync starts.
- Only MEGAcmd's own syncs are known to the connector. A folder synced by the MEGA
  desktop app counts as an ordinary cloud folder: a copy into it runs without the
  synced-folder question. A paused sync is matched by its last known cloud path (MEGA
  does not update it while paused); resuming one checks that its folder is still there.
- A pattern download takes each node's name when it is fetched: a rename made by
  someone else (the owner of a shared folder) during a long download is not seen.
- What was placed in a folder without a confirmation is remembered only while the
  server process runs.
- Turning file reading on or off is not locked across server processes: two
  answers given in different processes at the same instant can leave the older
  one in place.

## Reporting

Please report vulnerabilities to MEGA through https://mega.io/contact.
