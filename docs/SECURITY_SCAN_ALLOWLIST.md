# Security Scan Allowlist (Existing Dependencies)

> **位置づけ**: 既存依存の High/Critical 脆弱性のうち、CI security-scan で許容するもの (`gh pr merge --admin` 運用および security-scan workflow 通過の根拠)。本表に列挙されたエントリは「既知・追跡中・期限内に解消予定」として扱う。
> **根拠**: `docs/SECURITY_SCAN_POLICY.md`, `docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md` §5, `docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md` §7
> **対応期限**: Q3 2026 (2026-09-30) までに全件解消を目指す
> **新規 High/Critical 検出時**: 本表に追加せず Tier S で即時対応 (allowlist 増殖禁止)
> **計測元**: `pnpm audit --audit-level high` 実行結果 (2026-05-18 時点)

## 月次レビュー

毎月第1金曜に Claude.ai が `pnpm audit --audit-level high` と本表を突き合わせ、以下を実施する。

1. patched_versions が実依存に反映され解消済みのエントリを削除
2. 新規 High/Critical が検出された場合は Tier S として即時 issue 起票 (本表へ追記しない)
3. 期限 2026-09-30 を過ぎても未解消のエントリは Asana で個別タスク化

## カテゴリ別サマリ

| カテゴリ | 件数 | 主因 |
|---|---|---|
| Test/Build only (dev) | 14 | jest / ts-jest / @types/jest / start-server-and-test / javascript-obfuscator / ts-node が古い transitive を引きずる |
| Runtime (prod) | 15 | onnxruntime-node / @google-analytics/data / @langchain/core / express がメジャー更新待ち |
| **合計** | **29** | (28 high + 1 critical) |

## Allowlist

| # | Package | Severity | CVE/Advisory | 経路 (transitive 元) | 理由 (なぜ即時更新できないか) | 期限 |
|---|---|---|---|---|---|---|
| 1 | handlebars | critical | GHSA-2w6w-674q-4c4q | `.>ts-jest>handlebars` | ts-jest が dev のみ、prod 配信に未含有。ts-jest メジャー更新が Jest 30 待ち | 2026-09-30 |
| 2 | handlebars | high | GHSA-3mfm-83xf-c92r | `.>ts-jest>handlebars` | 同上 (ts-jest dev only) | 2026-09-30 |
| 3 | handlebars | high | GHSA-xhpv-hc6g-r9c6 | `.>ts-jest>handlebars` | 同上 (ts-jest dev only) | 2026-09-30 |
| 4 | handlebars | high | GHSA-9cx6-37pm-9jff | `.>ts-jest>handlebars` | 同上 (ts-jest dev only) | 2026-09-30 |
| 5 | handlebars | high | GHSA-xjpj-3mr7-gcpf | `.>ts-jest>handlebars` | 同上 (ts-jest dev only、CLI Precompiler 経路は未使用) | 2026-09-30 |
| 6 | tar | high | GHSA-34x7-hfp2-rc4v | `.>onnxruntime-node>tar` | onnxruntime-node が tar<7 を bundled。upstream PR 待ち (Cross-encoder 互換性確認後に更新) | 2026-09-30 |
| 7 | tar | high | GHSA-8qq5-rm4j-mr97 | `.>onnxruntime-node>tar` | 同上 (onnxruntime-node bundled tar) | 2026-09-30 |
| 8 | tar | high | GHSA-83g3-92jg-28cx | `.>onnxruntime-node>tar` | 同上 (onnxruntime-node bundled tar) | 2026-09-30 |
| 9 | tar | high | GHSA-qffp-2rhf-9h96 | `.>onnxruntime-node>tar` | 同上 (Drive-Relative Linkpath は Windows ローカル攻撃、VPS Linux で影響限定) | 2026-09-30 |
| 10 | tar | high | GHSA-9ppj-qmqm-q256 | `.>onnxruntime-node>tar` | 同上 (Drive-Relative Linkpath、Linux で影響限定) | 2026-09-30 |
| 11 | tar | high | GHSA-r6q2-hw4h-h46w | `.>onnxruntime-node>tar` | macOS APFS 限定の Race Condition。VPS (Linux ext4) で影響なし | 2026-09-30 |
| 12 | minimatch | high | GHSA-3ppc-4f35-3m26 | `.>jest>@jest/core>@jest/reporters>glob>minimatch` | jest 内部の古い glob 経由。Jest 30 移行待ち (dev only) | 2026-09-30 |
| 13 | minimatch | high | GHSA-3ppc-4f35-3m26 | `.>javascript-obfuscator>multimatch>minimatch` | javascript-obfuscator が multimatch 経由で minimatch 9.x を pin。build 時のみ使用 | 2026-09-30 |
| 14 | minimatch | high | GHSA-7r86-cg39-jmmj | `.>jest>@jest/core>@jest/reporters>glob>minimatch` | Jest 30 移行待ち (dev only) | 2026-09-30 |
| 15 | minimatch | high | GHSA-7r86-cg39-jmmj | `.>javascript-obfuscator>multimatch>minimatch` | javascript-obfuscator pin (build time only) | 2026-09-30 |
| 16 | minimatch | high | GHSA-23c5-xmqv-rm74 | `.>jest>@jest/core>@jest/reporters>glob>minimatch` | Jest 30 移行待ち (dev only) | 2026-09-30 |
| 17 | minimatch | high | GHSA-23c5-xmqv-rm74 | `.>javascript-obfuscator>multimatch>minimatch` | javascript-obfuscator pin (build time only) | 2026-09-30 |
| 18 | picomatch | high | GHSA-c2c7-rcm5-vvqj | `.>@types/jest>expect>jest-message-util>micromatch>picomatch` | @types/jest が古い jest 系を bundled。Jest 30 移行で解消予定 (dev only) | 2026-09-30 |
| 19 | picomatch | high | GHSA-c2c7-rcm5-vvqj | `.>@types/jest>expect>jest-util>picomatch` | 同上 (@types/jest dev only) | 2026-09-30 |
| 20 | lodash | high | GHSA-r5fr-rjxr-66jc | `.>start-server-and-test>wait-on>lodash` | start-server-and-test (dev/E2E only) → wait-on → lodash<4.18.0。`_.template` 未使用 | 2026-09-30 |
| 21 | axios | high | GHSA-pmwg-cvhr-8vh7 | `.>start-server-and-test>wait-on>axios` | wait-on (dev/E2E only) が axios<1.15.1 を bundle。NO_PROXY bypass は VPS で未使用 | 2026-09-30 |
| 22 | axios | high | GHSA-pf86-5x62-jrwf | `.>start-server-and-test>wait-on>axios` | 同上 (dev only、prototype pollution は wait-on の health check ループのみ) | 2026-09-30 |
| 23 | axios | high | GHSA-6chq-wfr3-2hj9 | `.>start-server-and-test>wait-on>axios` | 同上 (dev only、Header Injection 経路未使用) | 2026-09-30 |
| 24 | axios | high | GHSA-q8qp-cvcw-x6jj | `.>start-server-and-test>wait-on>axios` | 同上 (dev only) | 2026-09-30 |
| 25 | protobufjs | high | GHSA-66ff-xgx4-vchm | `.>@google-analytics/data>google-gax>protobufjs` | google-gax が protobufjs<=7.5.5 を pin。GA4 集計のみで使用、生成コード経路未使用 | 2026-09-30 |
| 26 | protobufjs | high | GHSA-75px-5xx7-5xc7 | `.>@google-analytics/data>google-gax>protobufjs` | 同上 (google-gax pin) | 2026-09-30 |
| 27 | protobufjs | high | GHSA-jvwf-75h9-cwgg | `.>@google-analytics/data>google-gax>protobufjs` | 同上 (DoS via unsafe option paths、未使用 option 経路) | 2026-09-30 |
| 28 | protobufjs | high | GHSA-685m-2w69-288q | `.>@google-analytics/data>google-gax>protobufjs` | 同上 (unbounded recursion、信頼されたデータのみ) | 2026-09-30 |
| 29 | langsmith | high | GHSA-3644-q5cj-c5c7 | `.>@langchain/core>langsmith` | @langchain/core が langsmith<0.6.0 を pin。Public prompt pull (`pullPrompt`) 未使用 | 2026-09-30 |

## 運用ルール (要点)

1. **追加禁止**: 本表は 2026-05-18 時点の snapshot。新規検出は Tier S 即時対応。
2. **削除のみ可**: patched_versions に到達したら速やかに削除し、`docs/SECURITY_SCAN_POLICY.md` 月次サマリへ反映。
3. **期限超過**: 2026-09-30 を過ぎたエントリは Asana タスク化 (担当: Phase 担当の hkobayashi)。
4. **transitive 元の更新が前提**: 直接更新 (`pnpm update <pkg>`) は親が pinned のため効かない。`pnpm.overrides` で強制更新するか、親のメジャー更新を待つ。

## 関連ドキュメント

- `docs/SECURITY_SCAN_POLICY.md` — Security scan の運用ポリシー全体
- `docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md` §5 — Allowlist 必要性の背景
- `docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md` §7 — Claude.ai 月次レビューフロー
- `.github/workflows/security-scan.yml` — CI security-scan の実装
- `SCRIPTS/security-scan.sh` — ローカル実行スクリプト
