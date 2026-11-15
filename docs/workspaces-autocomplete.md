# Terminal suggestions and workspaces

Part of Clavium since 0.1.11. What is marked "since 0.1.12" came with that version.

## What is built

**Suggestions in the terminal** (`src/shared/complete.ts`, `src/shared/completeSpecs.ts`,
`src/main/core/completion.ts`, `src/renderer/src/components/TerminalSuggest.tsx`)

- The line is read from the screen of the terminal (from the place where the first key of a line was typed
  up to the cursor), never from the keys. Text typed without echo is never seen.
- Sources: programs in `PATH` of the server, subcommands and options of about 130 common commands (the long
  spellings of the options of the GNU tools since 0.1.12), files and
  folders, git branches and remotes, systemd units, docker containers and images, hosts of `~/.ssh/config`,
  users, processes, network interfaces, and the shell history (read once per connection, kept in memory).
- Everything that comes from the server is fetched with read-only commands on a channel next to the shell
  (`term:completeContext`, `term:completeList`, `term:completeHistory`). Paths are quoted, never pasted into
  a command. Names with control characters are dropped, and names are escaped before they are typed.
- The folder of the shell is found without anything installed on the server: the process with a terminal
  below the sshd of the connection, then the folder of the foreground process of that terminal (`/proc`,
  or `lsof` on macOS and the BSDs). If a program other than a shell has the terminal (an editor, a database
  client, another ssh), nothing is suggested.
- Tab and Enter wait until the characters typed so far have come back from the server, so a fast typist never
  gets a suggestion that belongs to an older state of the line.
- `Ctrl+Space` opens the list where nothing is typed yet: the last commands on an empty line, the programs
  after `sudo ` or a pipe. The key itself does not reach the shell (since 0.1.12).
- A line is remembered for the session once all of it has come back from the server, and only as long as it
  was typed: a prompt at the right edge or a suggestion of the shell in grey is not part of it (since 0.1.12).
- Off for screens, container logs and shells inside containers. Setting: "Suggestions in the terminal".

**Workspaces** (`src/shared/layout.ts`, `src/renderer/src/App.tsx`, `src/renderer/src/components/Workspaces.tsx`)

- A tab holds up to 8 connections in a tree of splits. Panes are rendered flat and positioned by the tree, so
  splitting, closing and focus mode never reconnect a terminal.
- Focus mode shows only the focused pane. Dividers are `role="separator"`, draggable and movable with the
  arrow keys (Shift for bigger steps, Home for the middle).
- Saved workspaces and the tabs of the last session live in the encrypted vault (`workspaces`, `lastSession`).
  A pane whose host was deleted is left out when a workspace is opened.
- Shortcuts: `Ctrl+Shift+D` split right, `Ctrl+Shift+E` split down, `Ctrl+Shift+Enter` focus mode,
  `Ctrl+Alt+Arrow` move between panes (Cmd instead of Ctrl on macOS). `Ctrl+Shift+W` now closes the focused pane.

Since 0.1.12:

- A terminal comes back in the folder its shell was in, after a restart and when a workspace is opened. The
  folder is asked for a moment after every line that is sent (the same read-only question the suggestions
  use) and saved with the pane. The shell is then started with `cd` into that folder; if the folder is gone
  or the server has no `sh`, the usual login shell starts in the home folder.
- "Type into All Terminals of This Tab" in the split menu: every key goes to all terminals of the tab until it
  is stopped. Each terminal shows a bar that says so, with a button to stop. No suggestions meanwhile.
- A tab can be dragged from the sidebar onto another tab: onto its entry in the sidebar, or onto a pane of the
  visible tab (its lower part puts it below, the rest to the right). The same from the split menu ("Move … Here").
  The moved tab keeps its own splits, and nothing is connected again.
- A restored pane whose screen or container no longer exists offers "Open a Terminal on … Instead" and "Close".
- Narrow panes: the buttons lose their words, then the ones that can wait; the button that closes the pane and,
  as long as there is room, the name of the host stay.

## Checked

- `npm run typecheck`, `npm test` (unit tests for layout, parsing, suggestions, quoting; the list commands and
  the search for the shell run against a real `sh` and a real pseudo terminal on macOS).
- `npm run test:e2e`: `tests/e2e/workspace.e2e.ts` drives suggestions, split view, keyboard resizing, focus
  mode, saving and opening a workspace and the restart with restored tabs in the real app.

## Checked on Windows

With 0.1.11, in the built app against OpenSSH 9.6 on Ubuntu with bash:

- `npm run typecheck`, `npm test` and `npm run test:e2e` pass. The unit tests that need `sh` are skipped on Windows.
- Suggestions: folders, files with spaces and umlauts, git subcommands and branches, programs in `PATH`, insertion with
  Tab and with the mouse. The folder of the shell is found through `/proc` and follows `cd`. Nothing is suggested inside
  `python3` and `less`, and nothing for text typed without echo (`read -s`).
- A shell without a UTF-8 locale drops the umlauts of an inserted name; with `LANG=C.UTF-8` the name arrives complete.
- Split view with `Ctrl+Shift+D` and `Ctrl+Shift+E`, a file pane next to terminals, `Ctrl+Alt+Arrow`, focus mode, resizing
  with the mouse. The caption buttons of Windows do not cover the toolbar of the pane in the top right corner.
- A saved workspace with four panes opens again from the library, and the tabs of the last session come back after a
  restart with the same divider position and focus mode.

With 0.1.12, in the built app against OpenSSH 9.6 on Ubuntu:

- zsh 5.9 with zsh-autosuggestions, zsh-syntax-highlighting and a prompt on the right, and fish 3.7: folders,
  files with spaces and umlauts, git subcommands and branches, insertion with Tab, the list on an empty line.
- A terminal came back in the folder it was left in after a restart of the app (bash as the login shell).
- Typing into three terminals at once, the bar in each of them, and stopping it.
- Three panes side by side at 1280 pixels, in a window of 820 by 520 pixels and at 200 % zoom: the close
  button of every pane can be clicked. The pane below the caption buttons of Windows keeps its buttons clear of them.
- AltGr characters (`@`, `{`, `}`, `€`) arrive in the terminal and trigger none of the shortcuts.
- `tests/e2e/screen.e2e.ts` against that server: 5 of 5.

## Not checked yet

- An input method that uses Ctrl+Space, and a screen reader on the bar of "type into all terminals".
- Dragging a tab with a real mouse (the test moves the pointer through the test driver), and all of the
  above on macOS by hand: there it ran in the automated tests only.
- Docker: the tests against a real server were not run for this round.
- A screen reader on the suggestion list (it announces through a polite live region; the roles are listbox
  and option).

## Ideas left out

- Learning the options of a program from its `--help` on the server: that would run programs nobody asked
  to run. The lists stay built in.
