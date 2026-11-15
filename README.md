<p align="center">
  <img src="build/icon.png" width="96" alt="Clavium logo" />
</p>

<h1 align="center">Clavium</h1>

<p align="center">
  Open-source SSH, SFTP and FTP(S) client for Windows and macOS, with an encrypted vault and a built-in,
  permission-gated <b>MCP server</b> so Claude and Codex can work on your servers, only where and how you allow it.
</p>

<p align="center">
  <a href="https://github.com/006mi4/Clavium/releases/latest/download/Clavium-Setup.exe"><img src="docs/buttons/download-windows.svg" width="264" height="72" alt="Download Clavium for Windows" /></a>
  &nbsp;&nbsp;
  <a href="https://github.com/006mi4/Clavium/releases/latest/download/Clavium-mac.dmg"><img src="docs/buttons/download-macos.svg" width="264" height="72" alt="Download Clavium for macOS" /></a>
</p>

<p align="center">
  <sub>Windows 10 and 11 (installer) · macOS 11 or later (Apple silicon and Intel) ·
  <a href="https://github.com/006mi4/Clavium/releases/latest">all files and older versions</a></sub>
</p>

<p align="center">
  <a href="#ai-access-mcp">AI access setup</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="#deutsch">Deutsch</a>
</p>

![Hosts](docs/screenshots/03-hosts.png)

*Clavium* comes from Latin *clavis* — "key".

## Features

- **SSH terminal** with tabs (xterm.js, 256 colours, copy/paste, resize), password, key, SSH agent
  (Windows OpenSSH agent / Pageant, the SSH agent of macOS) and keyboard-interactive / 2FA logins
- **Screens made simple** (GNU screen): the terminal shows which screens are running under your user. One
  click opens a screen in its own tab, with what it printed so far in the scrollback, so the mouse wheel just
  works. The keyboard goes straight to the program inside, e.g. the console of a game server. Closing the tab
  only detaches (like Ctrl+A, D); the program keeps running. Ending a screen is a separate button that asks first.
- **Docker overview**: when a server has Docker, the terminal offers a page for it. It lists all containers,
  grouped by Compose project, with status, ports, processor and memory use. Start, stop, restart, pause and
  remove containers with one click, or a whole project at once. Open the log of a container or a shell inside
  it as a tab, set whether a container starts again by itself, and see and delete images. Download images
  with a progress display, and create containers with a form for ports, folders and settings instead of a
  long command line.
- **File manager for SFTP and FTP(S)** that works the way Explorer and Finder do
  (on macOS every `Ctrl` shortcut below is `Cmd`):
  - drag files and whole folders from Explorer or Finder into the window to upload them, onto a folder to upload into it
  - drag files and folders out of the window onto the desktop or into an Explorer or Finder window to download them
  - drag items onto a folder, a part of the path or the "move to enclosing folder" bar to move them
  - cut, copy and paste with Ctrl+X / Ctrl+C / Ctrl+V or the right-click menu: inside a server, from one
    server to another, from your computer to the server and (up to 200 MB) from the server to your computer
  - Ctrl+Z takes back moves, renames and copies, for as long as the app is running
  - a transfer queue: several files at the same time (3 by default), with speed and remaining time, an
    optional speed limit, and pause, resume, retry, reorder and cancel for each transfer or for all of them
  - interrupted transfers continue where they stopped instead of starting again (SFTP and FTP)
  - nothing is replaced without asking: moves and copies never overwrite; when a transferred file already
    exists you choose between replace, skip, keep both, replace if newer and continue, once or for all files
  - modification times are kept, and new files on the server keep their permissions
  - one file that fails does not stop a folder: the rest goes on and the failures are listed for a retry
  - sort by name, size or date, filter the folder (Ctrl+F), show or hide hidden files, follow links
  - a folder tree next to the list, bookmarks for folders, and every host opens in the folder you left it in
  - search by name or pattern (`*.log`) in a folder and everything below it (Ctrl+Shift+F)
  - full keyboard use: arrow keys, Home, End, Page Up and Down, Shift to select a range, and typing a name
    jumps to it; folders with many thousands of entries stay fast
  - properties of files and folders: size of a folder with everything inside, owner and group, permissions
    with checkboxes or the numeric form, for folders also with everything inside; over SFTP the owner and
    the group can be changed too
  - FTP servers that do not use UTF-8 for file names can be set to Western European (ISO 8859-1) per host
  - synchronise a local folder with a folder on the server: compare first and see every difference, then
    upload, download or go both ways; a mirror also deletes at the target, after showing the list and asking
  - keep a folder up to date: Clavium watches a local folder and uploads every change, with the status in
    view and a button to stop
  - when the connection breaks off, Clavium connects again by itself and running transfers continue where
    they stopped; idle FTP connections are kept alive
  - reach a server through a jump host (SSH) or through a SOCKS5 or HTTP proxy (SSH, SFTP, FTP and FTPS)
  - preview pictures without downloading them, and step through the pictures of a folder with the arrow keys
  - open a file in your own editor: Clavium uploads it every time you save, and asks before replacing
    changes someone else made on the server
  - the built-in editor opens files up to 32 MB and reads and writes UTF-8, UTF-16 and the common Western,
    Central European, Cyrillic, Greek, Turkish and Baltic character sets
- **Vault backup**: save the encrypted vault as one file and restore it on this or another PC
- **Built-in text editor**: double-click a remote file to edit it and save it back to the server
  - several files in tabs, split view (two files or one file twice side by side), new files
  - syntax colors for about 25 file types (YAML, JSON, shell, nginx/INI configs, Dockerfile, HTML/CSS/JS/TS,
    Python, PHP, Go, Rust, SQL, Markdown, logs and more), switchable by hand
  - find and replace with match case, whole word and regular expressions, go to line, zoom, line wrapping
  - the usual editor shortcuts and a right-click menu: duplicate, move, delete and comment lines, indent,
    auto-closing brackets, matching-bracket and same-word highlighting
  - warns when a file changed on the server, asks before discarding unsaved text, and keeps unsaved text
    through a lost connection or a locked vault
- **FTPS** (explicit and implicit TLS) and plain FTP (clearly marked as unencrypted)
- **Tunnels** (`ssh -L` style port forwarding, bound to 127.0.0.1 only)
- **Keys**: generate Ed25519 / ECDSA / RSA-4096 keys or import existing ones (with passphrase)
- **Known hosts** with trust-on-first-use and loud warnings when a server key changes
- **Encrypted vault** (scrypt + AES-256-GCM) for all hosts, passwords and keys, auto-lock, lock on Windows lock
- **MCP server for AI clients** (Claude Code, Claude Desktop, Codex, any MCP client) with per-host access
  levels, approval dialogs and an activity log
- Native-feeling interface that follows the light / dark setting of the system; tray mode (menu bar on macOS),
  installer and portable `.exe` for Windows, disk image for macOS

## Screenshots

Clavium follows the light / dark setting of Windows and macOS.

| Hosts | Hosts (dark) |
|---|---|
| ![Hosts](docs/screenshots/03-hosts.png) | ![Hosts, dark](docs/screenshots/03-hosts-dark.png) |

| Terminal | Terminal (dark) |
|---|---|
| ![Terminal](docs/screenshots/05-terminal.png) | ![Terminal, dark](docs/screenshots/05-terminal-dark.png) |

| Files (SFTP) | New host |
|---|---|
| ![SFTP](docs/screenshots/06-sftp.png) | ![Host editor](docs/screenshots/02-host-editor.png) |

| Right-click menu in the file manager | Permissions |
|---|---|
| ![File menu](docs/screenshots/06e-files-menu.png) | ![Permissions](docs/screenshots/06f-files-permissions.png) |

| Text editor | Text editor (dark) |
|---|---|
| ![Editor](docs/screenshots/06b-editor.png) | ![Editor, dark](docs/screenshots/06b-editor-dark.png) |

| Find and replace | Find and replace (dark) |
|---|---|
| ![Find](docs/screenshots/06c-editor-find.png) | ![Find, dark](docs/screenshots/06c-editor-find-dark.png) |

| Split view | Split view (dark) |
|---|---|
| ![Split](docs/screenshots/06d-editor-split.png) | ![Split, dark](docs/screenshots/06d-editor-split-dark.png) |

| AI access | Approval before a command runs |
|---|---|
| ![AI access](docs/screenshots/07-ai-access.png) | ![AI approval](docs/screenshots/08-ai-approval-dark.png) |

| AI change in the editor, waiting for your review |
|---|
| ![AI editor](docs/screenshots/08b-ai-editor.png) |

| Host key verification | Activity log |
|---|---|
| ![Host key](docs/screenshots/04-host-key.png) | ![Activity](docs/screenshots/09-activity.png) |

| Keys | Settings (dark) |
|---|---|
| ![Keys](docs/screenshots/10-keys.png) | ![Settings](docs/screenshots/11-settings-dark.png) |

| First start | Locked (dark) |
|---|---|
| ![Create vault](docs/screenshots/01-create-vault.png) | ![Locked](docs/screenshots/12-locked-dark.png) |

## Download & install

Get the latest version from **[Releases](https://github.com/006mi4/Clavium/releases/latest)**:

| File | What it is |
|---|---|
| `Clavium-Setup-x.y.z.exe` | Installer (per user, no admin rights needed), start menu + desktop shortcut |
| `Clavium-x.y.z-portable.exe` | Single exe, no installation |
| `Clavium-x.y.z-mac.dmg` | macOS 11 or later, Apple silicon and Intel in one file |
| `Clavium-x.y.z-mac.zip` | The same app as a zip. Installed copies download it to update themselves |
| `SHA256SUMS.txt`, `SHA256SUMS-mac.txt` | Checksums of the files above |
| `Clavium-Setup.exe`, `Clavium-mac.dmg` | The installer and the disk image again under names without a version, for the download buttons above |

**Windows SmartScreen:** Clavium is open source and its releases are not signed with a paid
code-signing certificate, so Windows may show *"Windows protected your PC"* on the first start.
Click **More info → Run anyway**. Instead of trusting us blindly, you can verify the download:

```powershell
# 1. compare with SHA256SUMS.txt from the same release
Get-FileHash .\Clavium-Setup-0.1.0.exe -Algorithm SHA256

# 2. verify it was built by this repository's GitHub Actions workflow (GitHub CLI)
gh attestation verify .\Clavium-Setup-0.1.0.exe --repo 006mi4/Clavium
```

**macOS:** open the `.dmg` and drag Clavium into *Applications*. If the release was built without an
Apple Developer ID, macOS refuses the first start with *"Clavium can't be opened"*. Open
**System Settings › Privacy & Security**, scroll to the message about Clavium and click **Open Anyway**.
You can verify the download the same way:

```bash
shasum -a 256 Clavium-0.1.4-mac.dmg          # compare with SHA256SUMS-mac.txt
gh attestation verify Clavium-0.1.4-mac.dmg --repo 006mi4/Clavium
```

### Updates

The installed version updates itself in place: **Settings → Updates → Check Now → Download Update →
Restart and Install**. Your vault and settings are kept. Clavium checks GitHub for a new release on start
and twice a day (can be switched off), but it never downloads or installs anything without your click.

An update is installed only if it is signed with the Clavium release key (Ed25519) that is built into the
app, is strictly newer than the installed version, and matches the signed size and SHA-512 checksum.
This works for the installed Windows version and, from 0.1.8 on, for the macOS version in the
*Applications* folder. The portable Windows version can't update itself, and neither can a macOS copy that
is not signed with an Apple Developer ID (for example one built from source); download the new file instead.
Details in
[SECURITY.md](SECURITY.md#updates).

Every release is built from the tagged source by [`.github/workflows/release.yml`](.github/workflows/release.yml)
— nothing is built on a developer machine.

## AI access (MCP)

Clavium contains an [MCP](https://modelcontextprotocol.io) server. When you enable it, AI assistants can
list your shared servers, run commands and work with files — **but only on hosts you explicitly share**:

| Access level | Allowed |
|---|---|
| **Off** (default) | Host is invisible to the AI |
| **Read** | list directories, read files, file info — never commands |
| **Full** | additionally run commands, write, rename, delete |

For every shared host you also choose when Clavium asks you first: **every action**, **commands & changes**
(default) or **never**. Approval dialogs show exactly what will be executed and auto-deny after 120 s.

### Setup

1. Clavium → **AI Access** → switch **MCP Server** on.
2. Under *Shared Hosts* (or in a host's details) set *Allow AI to* → *Read Files* or *Full Access*.
3. Under *Set Up a Client*, pick your client and click **Copy**:

**Claude Code** (one command, available in all projects):

```bash
claude mcp add --scope user --transport http clavium http://127.0.0.1:47821/mcp --header "Authorization: Bearer clv_…"
```

**Claude Desktop** (`claude_desktop_config.json`, via Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "clavium": {
      "command": "C:\\Users\\you\\AppData\\Roaming\\Clavium\\bin\\clavium-mcp.exe",
      "args": [],
      "env": { "CLAVIUM_MCP_TOKEN": "clv_…" }
    }
  }
}
```

**Codex** (`%USERPROFILE%\.codex\config.toml`):

```toml
[mcp_servers.clavium]
command = "C:\\Users\\you\\AppData\\Roaming\\Clavium\\bin\\clavium-mcp.exe"
args = []
env = { CLAVIUM_MCP_TOKEN = "clv_…" }
tool_timeout_sec = 180
```

On macOS the command is `/Users/you/Library/Application Support/Clavium/bin/clavium-mcp` and the Codex
file is `~/.codex/config.toml`. The *AI Access* page always shows the exact text to copy.

`clavium-mcp` is a tiny stdio ↔ HTTP bridge (C# on Windows, Swift on macOS, sources in [`bridge/`](bridge/))
for clients that only speak stdio. It starts Clavium if it is not running. Clavium must be **unlocked** for
tools to work; keep it in the tray (the menu bar on macOS).

### Tools

| Tool | Access | Description |
|---|---|---|
| `list_hosts` | – | hosts shared with AI and their access level |
| `run_command` | full, SSH | run a non-interactive command (timeout, 100 KiB output cap) |
| `list_directory` | read | list a remote directory |
| `file_info` | read | type, size, permissions, mtime |
| `read_file` | read | read a text file (≤ 2 MiB) |
| `write_file` | full | create / overwrite a text file (≤ 2 MiB) |
| `make_directory` | full | create a directory |
| `rename_path` | full | rename / move |
| `delete_path` | full | delete a file or (recursively) a directory; `/` is refused |
| `editor_list_open_files` | – | files open in the built-in editor (shared hosts only) |
| `editor_open_file` | read | open a remote file in your editor |
| `editor_read_file` | read | text of an open file, including your unsaved changes |
| `editor_edit_file` | full | change the text **in the editor only**; you review it there and save it yourself |
| `screen_list` | full | the GNU screen sessions of the logged-in user |
| `screen_read` | full | the last lines a screen has printed, e.g. the console of a game server |
| `screen_send` | full | type one line into the program in a screen and press Enter |
| `docker_list` | full | Docker containers with image, state, ports and Compose project |
| `docker_logs` | full | the last lines of a container's log |
| `docker_container_action` | full | start, stop or restart a container (no creating, no removing) |

The editor tools let an assistant work with you instead of behind your back: it can show you a file and
propose a change in the editor, where the change is marked as made by an AI and nothing reaches the server
until you press Save.

> ⚠️ AI agents can be manipulated by content they read (prompt injection) — for example a malicious
> file on a server. Keep approvals on for production systems and read what you approve.

## Security

Short version — details and threat model in [SECURITY.md](SECURITY.md):

- **Vault:** scrypt (N=2¹⁷, r=8, p=1) → AES-256-GCM, header authenticated, atomic writes, key wiped on lock,
  brute-force throttling. No password recovery, no cloud, no telemetry.
- **SSH:** modern algorithms only (Ed25519/ECDSA/RSA-SHA2, curve25519, AES-GCM/CTR, ETM MACs); legacy SHA-1
  only per host on request. Host keys pinned (TOFU); changed keys are refused for AI sessions and shown as a
  big warning to you. Agent forwarding is never enabled.
- **FTPS:** TLS ≥ 1.2, certificate validated before the password is sent; self-signed certificates only after
  you pinned their fingerprint.
- **MCP:** listens on 127.0.0.1 only, random 256-bit bearer token (constant-time compare, rate limited),
  requests with a browser `Origin` or a foreign `Host` header are rejected (CSRF / DNS rebinding). The AI never
  sees passwords or keys. Everything is logged in *Activity*.
- **Updates:** Ed25519-signed manifest verified against a key compiled into the app, no downgrades, HTTPS to
  GitHub only, nothing installs without your click.
- **Electron:** context isolation, sandboxed renderer, no Node in the renderer, strict CSP, all IPC validated
  with zod and restricted to the app window, navigation/new windows blocked, permissions denied, fuses
  (`RunAsNode`, `NODE_OPTIONS`, `--inspect` off, ASAR integrity on).

## Build from source

Requirements: Node.js 24, Git and either Windows 10/11 or macOS 11 or later with the Xcode command line
tools (`xcode-select --install`). The MCP bridge is compiled with the C# compiler that ships with Windows,
or with the Swift compiler of the command line tools; no extra SDK is needed.

```bash
git clone https://github.com/006mi4/Clavium.git
cd Clavium
npm ci
npm run dev        # start in development mode
npm test           # unit + integration tests (local SSH/SFTP test server, MCP, bridge)
# optional, needs a server with GNU screen and key login:
#   CLAVIUM_SCREEN_TEST=user@host:22 CLAVIUM_SCREEN_KEY=~/.ssh/id_ed25519 npx vitest run -c vitest.e2e.config.mts tests/e2e/screen.e2e.ts
# optional, needs a server with Docker, key login and an image with `sh` on it:
#   CLAVIUM_DOCKER_TEST=user@host:22 CLAVIUM_DOCKER_KEY=~/.ssh/id_ed25519 CLAVIUM_DOCKER_IMAGE=alpine npx vitest run -c vitest.e2e.config.mts tests/e2e/docker.e2e.ts
# optional, the AI tools for screens and Docker against the same kind of server:
#   CLAVIUM_TOOLS_TEST=user@host:22 CLAVIUM_TOOLS_KEY=~/.ssh/id_ed25519 CLAVIUM_TOOLS_IMAGE=alpine npx vitest run -c vitest.e2e.config.mts tests/e2e/server-tools.e2e.ts
npm run test:e2e   # drives the real Electron app with Playwright
npm run dist       # Windows: dist/Clavium-Setup-x.y.z.exe and dist/Clavium-x.y.z-portable.exe
                   # macOS:   dist/Clavium-x.y.z-mac.dmg, signed with your Developer ID certificate
npm run dist:mac:adhoc   # macOS without a certificate (ad-hoc signature, Gatekeeper warns on first start)
```

Project layout:

```
src/main/core/      vault, SSH, SFTP/FTP, host keys, MCP server (Electron-free, unit tested)
src/main/           Electron glue: window, IPC, terminals, transfers, tray, auto-lock
src/preload/        minimal allow-listed bridge to the renderer
src/renderer/       React UI
bridge/             clavium-mcp (stdio bridge; C# for Windows, Swift for macOS)
tests/              vitest tests incl. an in-process SSH/SFTP server; tests/e2e drives the app
```

## Roadmap

Jump hosts / ProxyJump · snippets · search in the terminal · split panes · macOS & Linux builds · German UI ·
SFTP editing in an external editor

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

---

## Deutsch

**Clavium** ist ein kostenloser Open-Source-Client für Windows und macOS, um sich per **SSH, SFTP und FTP(S)** mit
Servern zu verbinden — ähnlich wie Termius. Alle Zugangsdaten liegen in einem mit Master-Passwort
verschlüsselten Tresor auf deinem Rechner (keine Cloud, keine Telemetrie).

Zusätzlich enthält Clavium einen **MCP-Server**, über den **Claude** (Code/Desktop) und **Codex** deine
Server nutzen können — aber nur Hosts, die du freigibst, nur mit den Rechten, die du festlegst
(*Lesen* oder *Voll*), und standardmäßig erst nach deiner Bestätigung pro Befehl.

**Installation:** Unter [Releases](https://github.com/006mi4/Clavium/releases/latest) `Clavium-Setup-x.y.z.exe`
(Installer) oder `Clavium-x.y.z-portable.exe` herunterladen. Da die Datei nicht kostenpflichtig signiert ist,
zeigt Windows evtl. „Der Computer wurde durch Windows geschützt" → **Weitere Informationen → Trotzdem
ausführen**. Die Echtheit lässt sich mit `SHA256SUMS.txt` bzw. `gh attestation verify` prüfen (siehe oben).

**macOS:** `Clavium-x.y.z-mac.dmg` herunterladen, öffnen und Clavium in den Ordner *Programme* ziehen. Die Datei
läuft auf Macs mit Apple-Chip und mit Intel-Prozessor. Falls macOS den ersten Start verweigert:
**Systemeinstellungen › Datenschutz & Sicherheit › Dennoch öffnen**. Tastenkürzel nutzen auf dem Mac `Cmd`
statt `Strg`.

**KI einrichten:** Clavium → *AI Access* → *MCP Server* einschalten → bei einem Host *Allow AI to* auf
*Read Files* oder *Full Access* stellen → unter *Set Up a Client* das Snippet für Claude Code, Claude Desktop oder Codex kopieren.
