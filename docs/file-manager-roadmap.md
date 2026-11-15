# File manager roadmap

Goal: as a pure FTP and SFTP client, Clavium should beat WinSCP and FileZilla.
The work is split into four packages. Each one is finished only when it can be used in the real
app, is covered by tests, and typecheck, unit tests and end-to-end tests are green.

Not part of this roadmap: a local file pane, and importing sites from FileZilla, WinSCP or PuTTY.

## Package A: transfer engine

- [x] Transfer queue with parallel transfers (default 3, adjustable)
- [x] Pause, resume, retry, reorder, cancel one and cancel all
- [x] Resume interrupted transfers (SFTP by offset, FTP with REST and APPE) instead of deleting the partial file
- [x] Speed and remaining time, per transfer and in total
- [x] Rules for existing files: ask, overwrite, skip, rename, only if newer, resume, with "apply to all"
- [x] Speed limit
- [x] Keep modification time and permissions
- [x] An error inside a folder no longer stops the folder: the rest continues, errors are listed

## Package B: browsing

- [x] Bookmarks for folders
- [x] Remember the last folder per host
- [x] Folder tree
- [x] Search on the server
- [x] Folder size
- [x] Recursive permissions, change owner (SFTP), properties dialog
- [x] Character set per FTP host
- [x] Virtualised file list for large folders
- [x] Arrow keys and type-to-jump

## Package C: synchronisation

- [ ] Compare a local folder with a server folder, with a preview of the differences
- [ ] Synchronise one way, both ways, and as a mirror
- [ ] Keep a folder up to date (watch the local folder and upload)

## Package D: connections and editing

- [ ] Jump host and proxy (SOCKS5, HTTP CONNECT) for SSH and SFTP, and for FTP where possible
- [ ] Reconnect automatically and continue running transfers
- [ ] Keepalive for FTP
- [ ] External editor with upload on save
- [ ] Image preview
- [ ] Built-in editor beyond 2 MB and with more character sets than UTF-8

## Open points from finished packages

- [ ] Package A: setting the modification time over FTP (`MFMT`) has no automated test, because
  the FTP test server does not know the command. It needs a test server that does, or a check
  against a real server.
- [ ] Package B: the character set of an FTP host can be UTF-8 or ISO 8859-1 only (what the FTP
  library can do). The test covers reading names, not writing them: the test server cuts
  non-ASCII letters out of commands when UTF-8 is switched off.
- [ ] Package B: changing the owner is tested against a server that writes the request down
  instead of carrying it out (that needs root).

## Status

Packages A and B are finished. Packages C and D are open; C is next.

### How package B is built

- `src/main/core/remotetools.ts`: walking a tree on the server without following links, for the
  folder size, the search by name, and recursive changes of permissions and owner.
  `FileManager.background` runs such work on a connection of its own and can stop it by a token.
- `RemoteEntry` carries `uid`, `gid`, `owner` and `group` where the server tells them.
  `RemoteFs.chown` exists for SFTP and rejects for FTP.
- Bookmarks and the last folder are kept in the host record in the vault (`bookmarks`,
  `lastPath`), written through `hosts:setBookmarks` and `hosts:rememberPath`. `ftpEncoding` is a
  field of the host editor.
- `src/renderer/src/components/FileTools.tsx` has the folder tree, the search sheet and the
  properties sheet. The list in `FilesView.tsx` draws only the rows in view once a folder has
  more than 300 entries, and is driven by the keyboard through `listKey`.
- Tests: `tests/remotetools.test.ts` and one scenario in `tests/e2e/app.e2e.ts`.

### How package A is built

- `src/main/core/queue.ts` holds the queue. Every file is an entry of its own; folders are read
  step by step and add entries while transfers already run. Each running entry uses a connection
  of its own, taken from a small pool per session.
- `src/main/core/remotefs.ts`: `download` and `upload` take `TransferOptions` (offset, stop signal,
  throttle). SFTP moves chunks with many requests at once and reports the position up to which
  everything arrived without a gap. FTP continues with REST (download) and APPE (upload).
- Downloads are written to `<name>.clavium-part` and renamed when complete.
- The interface gets a snapshot of the queue over the `files:queue` event
  (`src/renderer/src/components/Transfers.tsx`). The question about an existing file is part of
  the snapshot.
- Settings: `transferConcurrency`, `transferLimitKbps`, `transferExisting`, `transferPreserve`.
- Tests: `tests/queue.test.ts`, `tests/transfer.test.ts`, and one scenario in `tests/e2e/app.e2e.ts`.

### Known limits of package A

- Setting the modification time over FTP uses `MFMT`. The FTP test server does not know that
  command, so this path has no automated test.
- The queue lives in memory. Closing the app or the session ends it; entries of a closed session
  fail and cannot be retried. Reconnecting and continuing is part of package D.
- An FTP server that allows only one connection runs transfers on the session itself. Such a
  transfer cannot be stopped in the middle of a file.
- Copies between servers are shown in the queue, but run outside of it: they can be cancelled,
  not paused or resumed.
- Uploads are written in place. A paused or failed upload over an existing file leaves that file
  incomplete until the upload is continued.
