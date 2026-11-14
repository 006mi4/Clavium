# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/006mi4/Clavium/security/advisories/new) instead.
You will get an answer within a few days. Please include steps to reproduce and the affected version.

## Supported versions

Only the latest release receives security fixes.

## Threat model

Clavium protects **credentials at rest** and **remote servers against unwanted AI actions**. It assumes the
Windows user account it runs in is not compromised: malware running as the same user can read memory, log
keystrokes or modify the program, and no desktop application can defend against that.

### Vault

- File: `%APPDATA%\Clavium\vault.json` (previous version kept as `vault.json.bak`).
- Key derivation: scrypt, N = 2¹⁷, r = 8, p = 1, 256-bit random salt. KDF parameters from the file are
  range-checked so a tampered file cannot force weak or absurdly expensive parameters.
- Encryption: AES-256-GCM with a fresh 96-bit IV for every save. The header (format, version, KDF
  parameters) is authenticated as additional data.
- The derived key is kept in memory only while unlocked and overwritten on lock. (JavaScript strings, e.g.
  decrypted passwords in use, cannot be wiped reliably — a known limitation of managed runtimes.)
- After 3 wrong master passwords, unlocking is throttled exponentially (up to 60 s).
- Auto-lock after inactivity (default 15 min) and on Windows lock / sleep. Locking disconnects all sessions.
- There is no recovery. A lost master password means lost data.

Non-secret preferences live in `settings.json`; the AI activity log in `audit.log`.

### Vault backup

- A backup is a copy of the vault file. It is encrypted exactly like the vault (scrypt + AES-256-GCM) and
  can only be opened with the master password it was made with.
- Restoring checks that the file is a vault, locks the app and closes all sessions. The vault that gets
  replaced is kept as `vault.json.replaced-<time>` in the data folder.

### SSH / SFTP

- Implementation: [`ssh2`](https://github.com/mscdex/ssh2) (pure JavaScript + Node.js crypto).
- Default algorithms: curve25519 / ECDH / DH group ≥ 14 with SHA-2, AES-GCM / AES-CTR (+ ChaCha20 where the
  runtime supports it), ETM SHA-2 MACs, host keys Ed25519 / ECDSA / RSA-SHA2. SHA-1 based algorithms and
  `ssh-rsa` only when enabled per host.
- Host keys are pinned on first use after the user compared the SHA-256 fingerprint. A changed key is shown
  as a prominent warning; for AI (MCP) sessions it is always refused.
- Agent forwarding is never requested. Port forwards bind to 127.0.0.1 only.
- File names received from a server are sanitised before writing to the local disk (no path traversal,
  no reserved Windows names).

### File transfers, drag and drop, clipboard

- Moving and copying on the server never replaces an existing item; an upload that would replace something
  asks first. Moves, renames and copies can be undone while the app is running.
- Dragging items out of the window: Windows does not tell an application where a dragged item was dropped.
  Clavium therefore drags a small marker file with a random name and watches the local drives for the
  moment Windows copies it; the folder it appears in is the download target. The marker is deleted again
  only after its content (a random 256-bit value) has been checked, so no other file can be removed. The
  drives are watched only while a drag is in progress, and nothing about other files is stored.
- Copying server files to the Windows clipboard, and copying between two servers, needs the files on this
  computer for a moment. They are kept in `transfer-tmp` inside Clavium's data folder (not in a shared
  temp folder), limited to 200 MB per copy for the clipboard, and removed with the next copy, when the vault
  is locked, when the app quits and at every start.
- Every transfer runs on a channel (SFTP) or connection (FTP) of its own. Cancelling closes only that one;
  a download that did not finish is deleted, and so is an upload that the user stopped while it was running.
- The Windows clipboard is accessed through the PowerShell that ships with Windows, started by its full
  path; file names are passed in an environment variable and never become part of the command text.

### FTP / FTPS

- FTPS requires TLS 1.2+. The server certificate is verified **before** credentials are sent. Untrusted
  (e.g. self-signed) certificates are only accepted after the user pinned the certificate fingerprint.
- Paths containing CR/LF/NUL are rejected (FTP command injection).
- Plain FTP is supported for legacy servers and clearly labelled as unencrypted.

### MCP server

- Disabled by default. When enabled it listens on `127.0.0.1` only (default port 47821).
- Authentication: random 256-bit bearer token (`clv_…`), compared in constant time; failed attempts are rate
  limited. The token is stored in the vault; `settings.json` holds only its SHA-256 hash.
- Requests with an `Origin` header (i.e. from a web browser) or with a `Host` header other than
  `127.0.0.1/localhost:<port>` are rejected to prevent CSRF and DNS-rebinding attacks.
- Hosts are invisible to the AI unless shared; access level *read* never allows command execution.
- By default every command and every modification requires an explicit click in the Clavium window; requests
  auto-deny after 120 s.
- The AI never receives passwords, keys or the vault. Tool output is size-limited.
- All requests, including denied ones, are written to the activity log.
- Editor tools follow the same rules: only files of shared hosts are listed, reading needs *read*, changing
  needs *full* access and approval. A change only alters the text in the editor window, is marked as made by
  an AI, and is never saved to the server by the AI.
- Prompt injection: an AI agent may be tricked by data it reads (files, command output). Approvals exist
  precisely for this. Do not set *Full* access without approval on production systems.

### `clavium-mcp.exe` (stdio bridge)

A ~20 KB C# program (`bridge/ClaviumMcpBridge.cs`) that forwards stdio JSON-RPC to the local HTTP endpoint.
It contains no secrets; the token is passed by the AI client via the `CLAVIUM_MCP_TOKEN` environment variable.

### Electron hardening

- `contextIsolation`, `sandbox`, no `nodeIntegration`, no `webview`, DevTools disabled in releases.
- Strict Content-Security-Policy (no remote content at all, no inline scripts).
- Preload exposes only an allow-list of IPC channels; every IPC call is validated with zod and accepted only
  from the app's own window.
- Navigation and `window.open` are blocked, all permission requests are denied.
- Electron fuses: `RunAsNode`, `NODE_OPTIONS` and `--inspect` disabled; cookie encryption, embedded ASAR
  integrity validation and "only load app from ASAR" enabled.

### Updates

The installed (NSIS) build can update itself from the project's GitHub releases.

- Each release contains `update-manifest.json` (version, installer file name, size, SHA-512) and
  `update-manifest.json.sig`, an Ed25519 signature over the exact manifest bytes.
- The public key is compiled into the app (`UPDATE_PUBLIC_KEY` in `src/main/core/update.ts`). The app
  verifies the signature **before** it downloads the installer, checks the downloaded file against the
  signed size and SHA-512, and hashes it once more immediately before running it.
- The signed version must equal the offered version and be strictly newer than the installed one, so an
  old signed installer cannot be replayed as a "new" update (downgrade protection). Pre-releases are ignored.
- Manifest and signature are fetched over HTTPS from `github.com` only; redirects to any host other than
  GitHub's release storage are rejected. The check does not rely on TLS or on GitHub for integrity: a
  tampered download fails the signature check.
- Nothing is downloaded or installed without a click. There is no silent background installation.
- The update check sends an ordinary HTTPS request to GitHub (which sees your IP address) and nothing else.
  It can be turned off in Settings.

**The signing key.** Whoever holds the private key can publish updates that installed copies accept, so it
is the most sensitive secret of the project. It is not in the repository. Releases are signed in the
release workflow from the `UPDATE_SIGNING_KEY` repository secret, which only the signing step can read.
This means a compromise of the GitHub account or of the release workflow would also compromise updates.
Maintainers who want to rule that out can keep the key offline and sign locally instead
(`node scripts/sign-update.mjs --key <file>`), then upload the two manifest files to the release by hand.
If the key is lost, existing installations can no longer be updated in place and users must install a
new version manually. Forks must generate their own key (`scripts/generate-update-key.mjs`).

Limits: updates are not Authenticode-signed, and the update check itself (is there a newer version?) is
not signed, so an attacker who controls the connection or the release page could hide an update, but not
install one.

### Releases

Releases are built only by GitHub Actions from a tagged commit, published with SHA-256 checksums and a
[build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations).
They are not Authenticode-signed (no paid certificate); see the README for how to verify a download.
