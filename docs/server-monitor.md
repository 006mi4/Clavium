# Server monitor: state and open points

A handoff note for whoever continues this work.

## What is built

A fourth kind of pane next to terminal, files and Docker: the monitor of a server. It opens from the page of
a host ("Monitor"), from the toolbar of a terminal, from the split menu ("Monitor to the Right", "Monitor
Below") and from the host picker of a split. It is saved in workspaces and comes back with the last session.

- `src/main/core/monitor.ts`: the measuring command (one read-only `sh -c` script) and the pure functions
  that read its output (`parseSample`) and turn two measurements into rates (`toSample`).
- `src/main/monitor.ts`: `MonitorManager`, one SSH connection per open monitor, one measurement at a time.
- `src/renderer/src/components/MonitorView.tsx`: the page. Rings, bars, charts with a scale, a tooltip for
  mouse and arrow keys, and all values again as a table.
- IPC: `monitor:open`, `monitor:sample`, `monitor:close`, event `monitor:closed`.

## Where the numbers come from

Only from what the kernel reports, never from the table of a tool, because tools differ between
distributions: `/proc/stat`, `/proc/meminfo`, `/proc/loadavg`, `/proc/uptime`, `/proc/net/dev`,
`/proc/diskstats`, `/sys/class/thermal`, `/sys/class/hwmon`, and `df -kPT` (falling back to `df -kP`).
Graphics cards: `nvidia-smi --query-gpu` for NVIDIA, `/sys/class/drm/card*/device` for AMD.

The renderer asks every 3 seconds (the second measurement after 1 second, because rates need two). Nothing
is stored: the history of 5 minutes lives in the memory of the page.

## Checked

- Unit tests (`tests/monitor.test.ts`): the parser with outputs of Ubuntu, a df without `-T`, a container
  root, a kernel without `MemAvailable`, restart of the server between two measurements, NVIDIA with missing
  values, AMD. The real script is run by a real `sh` against a copied Linux file tree.
- In the real app (`tests/e2e/monitor.e2e.ts`) against the test server: all cards, pause, keyboard, tooltip,
  narrow pane without sideways scrolling, split view, restore after restart, a server that is not Linux.
- Colours: the two chart colours pass the palette validator of the dataviz method in both modes (colour
  blindness and 3:1 against the card). Fill against track is 3.1:1 or more in both modes.

## Not checked

- A real Linux server. The test server only replays text. Worth trying: Debian or Ubuntu, Alpine (BusyBox),
  a machine with an NVIDIA card, one with an AMD card, a Raspberry Pi, a container.
- Windows as the client.
- Dark mode by eye (only the contrast was computed), 200 % zoom, a real screen reader.

## Known limits, left out on purpose

- Inside containers `/proc` shows the memory and processors of the host, not the limit of the container.
  Reading the cgroup limits would fix that.
- No list of processes. `ps` differs under BusyBox, so this needs `/proc/<pid>/stat` or two variants.
- Intel graphics cards: there is no way to read them without root rights.
- Servers that are not Linux (macOS, BSD) get a message instead of numbers.
- The cache segment of the memory bar is below 3:1 against its neighbours. Its value is written next to it.
- Network: bridges, VPN and container interfaces are left out so traffic is not counted twice. On a server
  that only has such an interface, the network card shows nothing.

## Processes and ports (second step)

Two more tabs in the monitor. Code: `src/main/core/activity.ts` (command, parser, ending a process),
`src/renderer/src/components/MonitorActivity.tsx` (both lists), IPC `monitor:activity` and `monitor:signal`.
The answer is only asked for while one of the two tabs is shown, every 4 seconds.

### Where the lists come from

- Processes: `/proc/<pid>/stat` and `/proc/<pid>/status`, read with builtins of the shell (no `ps`, whose
  columns differ under BusyBox). Memory is `VmRSS` in kB, so the page size does not matter. The share of the
  processor compares the ticks of a process with the ticks of all processors, so `CLK_TCK` does not matter.
  Command lines come from one `head -n 1 /proc/[0-9]*/cmdline`.
- Ports: `/proc/net/tcp`, `tcp6`, `udp`, `udp6`. These give port, address, the owning user and the inode of
  the socket to every user. Which process holds a socket comes from `ss -tulnpe` (matched by inode), or from
  `ls -l /proc/*/fd` where there is no `ss`.

### Rights, and what the page says about them

- Nothing is read with sudo. sudo writes every call to the log of the server, and the lists are read every
  few seconds.
- `/proc` mounted with `hidepid`: the user sees only its own processes. The page says so in a note.
- Programs behind ports of other users are invisible without root. The row then names the owner and says
  that the program is hidden, instead of showing an empty or guessed name.
- Ending a process: the user's own (or any, as root) with `kill`. A process of another user with
  `sudo -n kill`, after a dialog that says so. sudo that wants a password, a user who is not in sudoers and
  a server without sudo each get their own message. Clavium never enters a sudo password.
- Before the signal the start time of the process is compared with what the list showed, so a process that
  took over the number in the meantime is left alone.
- No actions are offered for process 1, threads of the kernel and processes that have already ended.
  Processes the connection itself runs through are marked, and the dialog warns.

### Checked

- `tests/activity.test.ts`: parser, addresses, hidden processes, root and not root, the fallback without
  `ss`, a command line that poses as another process or as the end of the answer, the messages for every
  kind of refusal. The real command is run by a real `sh` against a copied Linux file tree, and ending a
  process really ends a started `sleep` (and leaves it alone when the start time differs).
- `tests/e2e/monitor.e2e.ts`: both lists in the real app, sorting, search, "Only Mine", ending a process by
  mouse and by keyboard, the refusal of sudo, jumping from a port to its process.

### Not checked

- A real Linux server, again. Above all: BusyBox (`head` with many files, `grep`, `cut`), a server with
  `hidepid`, real `sudo` answers in other languages (the messages are matched in English; an unknown answer
  is shown as the server wrote it), a server with thousands of processes.
- Screen reader, 200 % zoom, dark mode by eye.

### Known limits

- Ports of containers that a firewall rule forwards without a listening program are not in `/proc/net`.
- Sockets in other network namespaces (containers) are not listed.
- A tunnel to a port cannot be opened from the list: tunnels are part of the settings of a host.
- UDP lists every bound socket, also short-lived ones of clients.
