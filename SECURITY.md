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

### Releases

Releases are built only by GitHub Actions from a tagged commit, published with SHA-256 checksums and a
[build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations).
They are not Authenticode-signed (no paid certificate); see the README for how to verify a download.
