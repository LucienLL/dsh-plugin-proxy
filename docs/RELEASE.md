# Release checklist (dsh-factory)

1. **Write** — plugin code from templates/plugin-skeleton (dsh.bundle + cordis.patch.yml + lib/index.js). ✅
2. **Verify** — node --check; node test (main-module mode); npm pack --dry-run. ✅ 23/23 tests; pnpm pack → 9 files.
3. **Publish npm** — ✅ `dsh-plugin-proxy@0.1.0` 已上线（2026-08-21）。方式：官方 npm CLI 安全密钥流程（`scripts/publish-interactive.ps1` → 浏览器打开 auth URL → 通行密钥确认）。npm 2FA 自 2026 起为 WebAuthn-only，无 TOTP 验证码。
4. **Topic** — add `dsh-plugin` to the GitHub repo topics (API or gh). ✅ `dsh-plugin, deepseek-harness, cordis, proxy, undici` on LucienLL/dsh-plugin-proxy.
5. **awesome PR** — data/plugins/<owner>__<repo>.yml + generate-readme.mjs; meet 1-day / 10-commit bar; re-run CI after 24h if needed.
   - ✅ 11 commits, fork `LucienLL/awesome-dsh-plugin` branch `add/dsh-plugin-proxy` pushed with entry + regenerated README.
   - ✅ **PR #2614 已创建（2026-08-22）且 CI 全绿**（Submission gate + check 均 success，首次运行即通过）：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/2614
   - ⏳ 待维护者 review/merge（若提意见按反馈修改后推分支即可）。
