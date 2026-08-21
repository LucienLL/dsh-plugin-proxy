# Release checklist (dsh-factory)

1. **Write** — plugin code from templates/plugin-skeleton (dsh.bundle + cordis.patch.yml + lib/index.js). ✅
2. **Verify** — node --check; node test (main-module mode); npm pack --dry-run. ✅ 23/23 tests; pnpm pack → 9 files.
3. **Publish npm** — `powershell -ExecutionPolicy Bypass -File scripts/publish-interactive.ps1` (security-key flow; npm 2FA is WebAuthn-only since 2026, no TOTP codes — npm CLI prints an auth URL to open in the browser and confirm with the passkey). ⏳ awaiting one interactive run.
4. **Topic** — add `dsh-plugin` to the GitHub repo topics (API or gh). ✅ `dsh-plugin, deepseek-harness, cordis, proxy, undici` on LucienLL/dsh-plugin-proxy.
5. **awesome PR** — data/plugins/<owner>__<repo>.yml + generate-readme.mjs; meet 1-day / 10-commit bar; re-run CI after 24h if needed.
   - ✅ 11 commits, fork `LucienLL/awesome-dsh-plugin` branch `add/dsh-plugin-proxy` pushed with entry + regenerated README.
   - ⏳ PR creation blocked: fine-grained PAT cannot open PRs on third-party repos — user clicks https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/compare/main...LucienLL:add/dsh-plugin-proxy (Create pull request).
   - ⏳ CI age gate: repo is < 1 day old — expect failure; push empty commit on the branch after 2026-08-22 to re-trigger.
