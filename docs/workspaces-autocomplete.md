# Terminal suggestions and workspaces

State of the branch `workspaces-autocomplete` (cut from `main` at 0.1.9). Not merged, not released.

## What is built

**Suggestions in the terminal** (`src/shared/complete.ts`, `src/shared/completeSpecs.ts`,
`src/main/core/completion.ts`, `src/renderer/src/components/TerminalSuggest.tsx`)

- The line is read from the screen of the terminal (from the place where the first key of a line was typed
  up to the cursor), never from the keys. Text typed without echo is never seen.
- Sources: programs in `PATH` of the server, subcommands and options of about 130 common commands, files and
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

## Checked

- `npm run typecheck`, `npm test` (unit tests for layout, parsing, suggestions, quoting; the list commands and
  the search for the shell run against a real `sh` and a real pseudo terminal on macOS).
- `npm run test:e2e`: `tests/e2e/workspace.e2e.ts` drives suggestions, split view, keyboard resizing, focus
  mode, saving and opening a workspace and the restart with restored tabs in the real app.

## Not checked yet

- A real Linux server with OpenSSH: the folder detection through `/proc`, bash and zsh with their own line
  editors (syntax highlighting, autosuggestion plugins, right prompts), fish.
- Windows: everything in this branch ran on macOS only. The unit tests that need `sh` are skipped there.
- Very small windows with three panes side by side, 200 % zoom, and a screen reader on the suggestion list
  (it announces through a polite live region; the roles are listbox and option).
- Restoring a tab whose screen or container no longer exists shows the error of the server in that pane.

## Ideas left out

- Dragging a tab from the sidebar into another tab (use "Another Host…" in the split menu instead).
- Typing into several panes at once.
- Restoring the folder of a terminal (file panes come back in their last folder, terminals in the home folder).
