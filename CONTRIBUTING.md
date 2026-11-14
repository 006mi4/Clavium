# Contributing to Clavium

Thanks for helping! Bug reports, ideas and pull requests are welcome.

## Development

```bash
npm ci
npm run dev        # app with hot reload
npm run typecheck
npm test           # fast tests, no external servers needed
npm run test:e2e   # builds and drives the real app (Windows)
```

## Guidelines

- Keep protocol and security logic in `src/main/core/` free of Electron imports so it stays unit-testable.
- Every new IPC channel must be added to `src/shared/ipc.ts` and validated with zod in `src/main/ipc.ts`.
- Secrets (passwords, private keys, tokens) never go to the renderer or to MCP clients.
- New MCP tools must go through `McpService.guarded()` (access level, approval, audit log).
- Add or update tests for behaviour changes. Security-relevant changes need a test that shows the attack fails.
- Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).

## Releasing (maintainers)

0. Once: add the Ed25519 update signing key as repository secret `UPDATE_SIGNING_KEY`
   (Settings → Secrets and variables → Actions). Without it the release workflow fails on purpose.
1. Bump `version` in `package.json`, commit.
2. `git tag v<version> && git push --tags`
3. The *Release* workflow builds, tests and publishes the installer, portable exe, the signed update manifest,
   checksums and attestation.
