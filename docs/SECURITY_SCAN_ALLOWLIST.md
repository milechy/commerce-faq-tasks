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

## 運用ルール (要点) — 上記 GHSA snapshot table 限定

> **注**: 以下のルール 1-4 は「**上記の GHSA snapshot table (29件、2026-05-18)**」に対するもの。
> 同じ doc 内の次節「pnpm auditConfig ignoreCves (2026-05-27)」は **異なる governance scope** (package.json 集中管理) のため別ルール (節末参照)。
> 2つを混同しないこと。Codex P2 governance drift 指摘 (2026-05-27) への対処として明示化。

1. **追加禁止**: 上記 GHSA snapshot table は 2026-05-18 時点の snapshot。新規 GHSA 検出は Tier S 即時対応 (本表に追記しない)。
2. **削除のみ可**: patched_versions に到達したら速やかに削除し、`docs/SECURITY_SCAN_POLICY.md` 月次サマリへ反映。
3. **期限超過**: 2026-09-30 を過ぎたエントリは Asana タスク化 (担当: Phase 担当の hkobayashi)。
4. **transitive 元の更新が前提**: 直接更新 (`pnpm update <pkg>`) は親が pinned のため効かない。`pnpm.overrides` で強制更新するか、親のメジャー更新を待つ。

---

## pnpm auditConfig ignoreCves (2026-05-27 追加, GID 1215114679975245)

> **位置づけ**: `package.json#pnpm.auditConfig.ignoreCves` で `pnpm audit --audit-level=high` の判定から除外する CVE。
> ローカル `SCRIPTS/security-scan.sh` と CI `.github/workflows/security-scan.yml` が同じ判定基準で動くようになったため (二枚舌閉じ込め)、
> ignore は **コード/設定の単一の源** で管理する。
>
> **再評価条件**: 各エントリの「再評価トリガー」列に記載した条件が成立したら、grep 再実行で到達不能根拠の有効性を再確認し、必要なら ignore を解除する。
> **計測元**: `pnpm audit --production --audit-level=high --json` 実行結果 (2026-05-27 時点)

### Ignore 対象 (8件 High)

| # | CVE | sev | module | 経路 | 到達不能/低リスク根拠 (実機照合) | 再評価トリガー |
|---|---|---|---|---|---|---|
| I-1 | CVE-2026-26996 | high | minimatch | `@google-analytics/data → google-gax → rimraf → glob → minimatch@9.0.5` | `grep "from 'minimatch'" src/` 0件 → 直接呼び出し無し。GA4 client は `GOOGLE_APPLICATION_CREDENTIALS_JSON` 必須 (`src/lib/ga4/ga4Client.ts:16`)。攻撃面 = google-gax 内部の path sweep (rimraf) のみで攻撃者操作不能 | `@google-analytics/data` major bump (5→6) 時 / google-gax が rimraf/glob 新版採用時 |
| I-2 | CVE-2026-27903 | high | minimatch | 同上 | 同上 (matchOne ReDoS。同様に攻撃者からの pattern 入力経路なし) | 同上 |
| I-3 | CVE-2026-27904 | high | minimatch | 同上 | 同上 (nested *() extglobs ReDoS) | 同上 |
| I-4 | CVE-2026-44289 | high | protobufjs | `@google-analytics/data → google-gax → @grpc/proto-loader → protobufjs@7.5.5` | **両面**: (a) `grep "from 'protobufjs'\|@grpc/" src/` 0件で直接呼び出し無し。(b) `src/lib/ga4/ga4Client.ts:40,71` の `runReport` 経由で protobufjs decode は通る — ただし decode 対象は **Google API (analyticsdata.googleapis.com) からの TLS 応答** のみ。エクスプロイトには (i) Google サーバーを掌握して悪意ある protobuf 応答を返させる、または (ii) admin 認証 + 自前で制御する GA4 property を内部で指定させる、の **2段階権限昇格** が必要。GA4 routes (`src/api/admin/tenants/ga4Routes.ts`) は `super_admin` gating かつ credential は DB 側固定で攻撃者の自由度なし。**残余リスク = なし** | 同上 / google-gax が protobufjs 7.5.6+ 採用時 / GA4 endpoint を非 super_admin に開放する場合は即時解除 |
| I-5 | CVE-2026-44290 | high | protobufjs | 同上 | 同上 (unsafe option paths DoS、unbounded message) — 信頼境界 Google + admin gating で防御。**残余リスク = なし** | 同上 |
| I-6 | CVE-2026-44291 | high | protobufjs | 同上 | 同上 (Code generation gadget after prototype pollution) — Google が返す protobuf message 構造のみ decode、攻撃者は構造を制御不能。**残余リスク = なし** | 同上 |
| I-7 | CVE-2026-44293 | high | protobufjs | 同上 | 同上 (bytes field default code injection) — `.proto` 定義は @grpc/proto-loader にバンドル済みで実行時 untrusted な定義は受け取らない。**残余リスク = なし** | 同上 |
| I-8 | CVE-2026-45134 | high | langsmith | `@langchain/core@0.3.80 → langsmith@0.3.81` (+ `@langchain/langgraph → @langchain/core → langsmith` 経路あり) | **両面 (起動時 invariant + grep)**: (a) `grep "from 'langsmith'" src/` 0件で直接呼び出し無し、`pullPrompt` 経路未使用。(b) 環境変数経由の起動を防ぐため `src/index.ts:assertLangchainTracingDisabled()` で `LANGCHAIN_TRACING_V2 / LANGCHAIN_TRACING / LANGCHAIN_API_KEY / LANGSMITH_API_KEY / LANGSMITH_TRACING` のいずれかが truthy なら **起動を fail-fast で阻止**。grep だけでなく実行時 invariant でも保証する二重防御。**残余リスク = なし (env-activation 経路が起動時にブロックされる)** | `@langchain/core` major bump (0.3→1.x) 時 / **tracing を意図して導入する場合は: (1) ignoreCves から CVE-2026-45134 を削除し (2) `src/index.ts` の startup check を撤廃する手順をセットで PR** |

### Moderate 維持 (Ignore しない、到達可・将来対処)

`pnpm audit --audit-level=high` の gating 対象外のため CI は緑のまま。可視性は残す。

| Moderate CVE | module | 到達可? | 想定対処 |
|---|---|---|---|
| CVE-2025-13466 | body-parser <2.2.1 | ✅ 全 POST/PUT/PATCH 経路 | `express 5.1.0 → 5.2.x` minor bump (低リスク) |
| CVE-2025-15284, CVE-2026-2391 (low), CVE-2026-8723 | qs <6.15.2 | ✅ 全 querystring 経路 | 同上 (express bump で transitive 追従) |
| CVE-2026-26996, CVE-2026-40190, CVE-2026-41182 | langsmith | ✗ 未到達 (I-8 と同根拠) | 親 `@langchain/core` major bump 時に一括 |
| CVE-2026-41907 | uuid 13.0.0 (直接) | ✗ R2C は `v4 as uuidv4` のみ使用 (`src/index.ts:10`)、CVE は v3/v5/v6+buf 限定 | uuid 13→14 patch bump (低リスク) |
| CVE-2026-41907 | uuid 10.0.0 (langchain transitive) | ✗ 同上 | langchain major bump 待ち |
| CVE-2026-44288, 44292, 44294, 45740 | protobufjs / @protobufjs/utf8 | △ GA4 経路限定 (I-4〜7 と同根拠) | GA4 major bump 時 |
| CVE-2026-33750 | brace-expansion | △ GA4 経路限定 (I-1〜3 と同根拠) | 同上 |
| CVE-2026-45736 | ws (@supabase/realtime-js) | ✗ `grep "\.channel(" src/` 0件 → Realtime 購読未使用 | Realtime 機能採用時に即時解除 |

### Ignore 解除運用

1. 月次レビュー (`docs/SECURITY_SCAN_POLICY.md` の「月次レビュー」フロー) で `package.json#pnpm.auditConfig.ignoreCves` の各エントリに対し:
   - 再評価トリガーが発生していないか確認
   - 該当 CVE が直接 dep に昇格していないか `pnpm why <pkg>` で確認
   - 解除可能なら ignore リストから削除し、`pnpm audit` 再実行で確証
2. **新規 High/Critical** は本リストに無条件で追加しない。Tier S 即時対応が原則。やむを得ない場合のみ、根拠と再評価条件をこの表に明記したうえで追加可。

## 関連ドキュメント

- `docs/SECURITY_SCAN_POLICY.md` — Security scan の運用ポリシー全体
- `docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md` §5 — Allowlist 必要性の背景
- `docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md` §7 — Claude.ai 月次レビューフロー
- `.github/workflows/security-scan.yml` — CI security-scan の実装
- `SCRIPTS/security-scan.sh` — ローカル実行スクリプト

---

## 使用禁止ツール・ライブラリ

> 追加: 2026-05-18（Phase1 Step-F T2）

以下のツール・ライブラリは R2C プロジェクトで**一切使用禁止**とする。

### OpenClaw / ClawHub / OpenClaw Plugins

**禁止理由（複数の重大インシデント）:**

| 識別子 | 深刻度 | 概要 |
|---|---|---|
| CVE-2026-25253 | CVSS 8.8 (High) | WebSocket トークン漏洩 — セッショントークンが第三者サーバーへ平文送信される |
| ClawHavoc Attack | Critical | 341 の悪意ある skill がデフォルト有効化されており、外部コマンド実行・ファイル流出が可能 |

**参照警告:**
- Koi Security: "OpenClaw Plugin Architecture Allows Arbitrary Code Execution" (2026-03)
- Microsoft Security Blog: "ClawHavoc — Lessons from a Compromised AI Dev Tool" (2026-04)
- Cisco Talos: "CVE-2026-25253 — OpenClaw WebSocket Token Exfiltration" (2026-04)

**検出 grep ルール（Aikido Plugin trial 追記依頼として記録）:**
```
# package.json / requirements.txt での検出
grep -r "openclaw\|clawhub\|claw-hub\|@claw/" . --include="*.json" --include="*.txt"
```

**代替ツール:**
- Claude Code CLI 公式プラグイン（`claude mcp add`）のみ使用
- MCP サーバーは `.claude/settings.json` の `mcpServers` で明示管理
