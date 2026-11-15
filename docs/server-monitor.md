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
