# CODE AUDIT 2026-04-19

R2C チャットウィジェット SaaS (Express + pgvector + Elasticsearch + React Admin UI) の定期コード監査レポート。前回 (`docs/CODE_HEALTH_REPORT.md`, 2026-04-10) からの差分と、P0-P3 の優先度付きアクションリストをまとめる。

---

## 1. エグゼクティブサマリー

### 1.1 全体健全性スコア

| 領域 | 前回 (2026-04-10) | 今回 (2026-04-19) | 評価 |
|---|---|---|---|
| 型安全性 (`@ts-ignore` / 循環依存 / console.*) | ✅ 全て 0 件 | ✅ 全て 0 件 | **維持** |
| `: any` / `as any` | 50 / 79 | 61 / 84 | △+11 / △+5（軽微） |
| テスト件数 | 99 files | 128 files | △+29（**改善**） |
| Admin UI 大型ファイル | 最大 2,210 行 | 最大 2,280 行 | △+70（悪化傾向） |
| production 脆弱性 (security-scan.sh) | 0 件 | 0 件 | **維持** |
| dev 脆弱性 (pnpm audit) | 未記録 | Critical 1 / High 17 (axios High 3件はPR #112で解消済み) | 新規可視化→一部対応済 |
| Dead exports | 21 件（正当理由あり） | 139 件→精査後 41 件（PR #113 対応済） | △+118→精査・削除済 |

### 1.2 トレンド総括

- **Positive**：テストカバレッジが +29 ファイル (99→128) と大幅増強。`@ts-ignore`、循環依存、`console.*`（非テスト）の「ゼロ維持」が 9 日間継続。
- **Neutral**：`: any` / `as any` の微増は Phase65-2 (Conversion Tracking) / avatar / tuning 等の新機能追加に比例した自然増。抑制可能な範囲内。
- **Negative**：Admin UI の巨大ファイル化が継続。`knowledge/[tenantId].tsx` 2,280 行、`tenants/[id].tsx` 1,957 行、`billing/index.tsx` 1,488 行は引き続き分割候補。`ts-unused-exports` 検出数が 21 → 139 に急増（false positive 含む可能性大、要精査）。

### 1.3 前回比較トレンド表（定量）

| メトリクス | 2026-04-10 | 2026-04-19 | 差分 | 備考 |
|---|---:|---:|---:|---|
| src/ TS files (incl. test) | 260 | ~ 366* | △+106* | *non-test 238 + test 128 の合算。一部テスト移動含む |
| src/ non-test TS files | — | 238 | — | 今回初計測 |
| src/ non-test lines | 40,521 | 37,068 | △-3,453 | テスト分離／リファクタ効果 |
| Admin UI files | 68 | 78 | △+10 | avatar / tuning / conversion UI 追加 |
| Test files | 99 | 128 | △+29 | **大幅改善** |
| Test suites / tests | — | 110 / 1,122 | — | 今回初計測 |
| `: any` | 50 | 61 | △+11 | 新 Phase 追加に伴う微増 |
| `as any` | 79 | 84 | △+5 | 新 Phase 追加に伴う微増 |
| `@ts-ignore` | 0 ✅ | 0 ✅ | 0 | **維持** |
| 循環依存 | 0 ✅ | 0 ✅ | 0 | **維持** |
| console.* (非テスト) | 0 ✅ | 0 ✅ | 0 | **維持** |
| TODO/FIXME/HACK | — | 6 | — | 要内容確認 |
| Dead exports | 21 | 139 | △+118 | 要精査 (FP 多数見込み) |
| SCRIPTS/ files | — | 72 | — | 今回初計測 |
| 環境変数参照数 | — | 104 | — | .env.example 0 漏れ維持 |

### 1.4 トリアージ件数サマリ

| 優先度 | 件数 | 代表項目 |
|---|---:|---|
| P0 | 0 | （緊急対応必須項目なし） |
| P1 | 1 | Admin UI 巨大ファイル（axios DoS 脆弱性・Dead exports は対応済） |
| P2 | 6 | devDeps 脆弱性群、widget.js 単一ファイル、TODO 6 件、等 |
| P3 | 4 | `: any`/`as any` 微増、文字列定数一元化、等 |

---

## 2. カテゴリ別 P0-P3 トリアージ

### 2.1 セキュリティ

| ID | 優先度 | 項目 | 現状 | 前回差分 |
|---|---|---|---|---|
| SEC-1 | ✅ **対応済** | axios の DoS 脆弱性 (high, wait-on@9.0.3 devDep 経由の推移的依存) | PR #112: wait-on@9.0.5 + pnpm.overrides["axios"]=">=1.15.0" で解消 (pnpm audit High -3) | 新規可視化→対応済 |
| SEC-2 | **P2** | devDependencies 経由の Critical/High 脆弱性群 | handlebars Critical×1 / tar・minimatch・picomatch・handlebars 等 High×20 | 新規可視化 |
| SEC-3 | **P2** | body-parser / qs の moderate 脆弱性 | production dep | 新規可視化 |
| SEC-4 | ✅ | security-scan.sh (production only) | High/Critical **0 件** | 維持 |
| SEC-5 | ✅ | 4 層セキュリティスタック (rateLimit → auth → tenantContext → securityPolicy) | 全ルート適用済 | 維持 |
| SEC-6 | ✅ | ルート未登録ミドルウェア | **0 件** | 維持 |
| SEC-7 | ✅ | apiKey 検証実装 | `src/agent/http/authMiddleware.ts` | 維持 |

**所見**：Gate 2 の `security-scan.sh` は production dep のみ対象で 0 件を維持しており、本番リスクは低い。`pnpm audit` で可視化された脆弱性の大半 (Critical/High 21 件) は langchain / langsmith 等のツールチェーン経由の devDependencies であり、本番バンドルには混入しない。axios の DoS 脆弱性は `wait-on@9.0.3` (devDep) 経由の推移的依存であり、production dep ではなかった。PR #112 (wait-on@9.0.5 + pnpm.overrides) にて **対応済** (High -3)。

### 2.2 保守性

| ID | 優先度 | 項目 | 現状 | 前回差分 |
|---|---|---|---|---|
| MNT-1 | **P1** | Admin UI 巨大ファイル継続成長 | `knowledge/[tenantId].tsx` 2,280 行 (+70) / `tenants/[id].tsx` 1,957 行 (+309) / `billing/index.tsx` 1,488 行 (+457) | 3 ファイル合計 +836 行 |
| MNT-2 | **P2** | widget.js 2,557 行の単一ファイル | Phase65-2 で `trackConversion` 追加済み | 行数増加傾向 |
| MNT-3 | **P2** | Admin UI 新規追加の中規模ファイル | `avatar/index.tsx` 955 行 / `TuningRuleModal.tsx` 916 行 / `AvatarWizard.tsx` 859 行 | 新規 3 件が 800+ 行で誕生 |
| MNT-4 | **P2** | `src/api/admin/analytics/routes.ts` 972 行 | +147 行 | 増加継続 |
| MNT-5 | **P3** | `src/api/admin/knowledge/routes.ts` 892 行 | +12 行 | 微増 |

**所見**：Admin UI の巨大ページが依然として分割されず、むしろ成長を続けている点が最大の保守性リスク。`tenants/[id].tsx` の +309 行、`billing/index.tsx` の +457 行は 1 Phase の追加としては大きい。タブ単位またはセクション単位でサブコンポーネントへ抽出する方針を検討すべき。

### 2.3 テスト品質

| ID | 優先度 | 項目 | 現状 | 前回差分 |
|---|---|---|---|---|
| TST-1 | ✅ | テストファイル数 | 128 files | **△+29（大幅改善）** |
| TST-2 | ✅ | テストスイート / ケース | 110 / 1,122 | 今回初計測 |
| TST-3 | **P3** | Admin UI テスト整備状況 | admin-ui Vitest 導入済 (58fbacc) | 継続整備中 |
| TST-4 | ✅ **対応済** | Dead exports 再精査 (ts-prune: src/ 真の未使用 47→41 件) | PR #113: crewSchemas.ts 削除・5 export 除去 | 対応済 |

**所見**：前回「99 files」から今回「128 files」へ 29% 増。Admin UI Vitest 導入 (PR #109) と Phase65 関連テストが効いている。Gate 1 が 1,122 ケース全通過しており、テスト文化は健全な方向にある。

Dead exports は `ts-prune` で再精査した結果、src/ 真の未使用は 47 件（139 件との差は型 alias / re-export / 意図的 public API による FP）。PR #113 で 2 ファイル削除 + 5 export 除去を実施し 41 件に削減。**対応済**。

### 2.4 アップグレード耐性

| ID | 優先度 | 項目 | 現状 | 前回差分 |
|---|---|---|---|---|
| UPG-1 | **P2** | langchain / langsmith ツールチェーン依存の脆弱性群 | handlebars / tar / minimatch / picomatch × 複数 | 今回初可視化 |
| UPG-2 | **P3** | `: any` / `as any` 微増 | 50→61 / 79→84 | Phase65-2 / avatar 追加に比例 |
| UPG-3 | ✅ | 循環依存 | **0 件** | 維持 |
| UPG-4 | ✅ | `@ts-ignore` | **0 件** | 維持 |

**所見**：TypeScript 厳格性の 3 大指標（`@ts-ignore` / 循環依存 / `console.*`）が 9 日間維持されており、将来のリファクタ・アップグレードに耐えられる基盤が保たれている。`: any` の微増は Phase 境界では自然だが、四半期ごとの棚卸しで再度 50 台に戻す方針を推奨。

### 2.5 運用リスク

| ID | 優先度 | 項目 | 現状 | 前回差分 |
|---|---|---|---|---|
| OPS-1 | ✅ | PM2 4 プロセス構成 | rajiuce-api / rajiuce-avatar / rajiuce-admin / slack-listener | 維持 |
| OPS-2 | ✅ | `deploy-vps.sh` 統一デプロイ | 禁止コマンド群を CLAUDE.md に明記 | 維持 |
| OPS-3 | ✅ | Gate 1-6 フロー | Test & Deploy Gate 継続遵守 | 維持 |
| OPS-4 | **P2** | widget.js の単一巨大ファイル運用 | CDN 配信時の cache 無効化リスク | 継続課題 |
| OPS-5 | **P3** | SCRIPTS/ 72 ファイル | 棚卸し未実施 | 今回初計測 |

**所見**：デプロイと運用規律は堅牢。`mainへの直接コミット禁止` ルール (1dab677) がドキュメント化されたことで、Codex review Gate 2.5 が機能する運用に定着した。SCRIPTS/ の 72 ファイルは Phase ごとの shell/python スクリプトが累積している可能性があり、棚卸しを推奨。

### 2.6 技術負債

| ID | 優先度 | 項目 | 現状 | 前回差分 |
|---|---|---|---|---|
| DBT-1 | **P2** | TODO/FIXME/HACK コメント 6 件 | 内容未確認 | 今回初計測 |
| DBT-2 | **P2** | Admin API 18 モジュール化 | Phase 増加に伴い横広化 | 構造化の余地あり |
| DBT-3 | **P3** | Admin UI 大型コンポーネントの重複パターン | モーダル / ウィザード系で類似構造 | 共通 hooks 化の余地 |
| DBT-4 | **P3** | 文字列定数（エラーメッセージ等）の一元化 | 散在 | 軽微 |

---

## 3. 前回監査 (CODE_HEALTH_REPORT.md) との差分明示

### 3.1 改善した点

1. **テストファイル +29**：99 → 128。admin-ui Vitest 導入 (PR #109) により Frontend 側カバレッジが拡張。
2. **src/ non-test 行数 -3,453 行**：40,521 → 37,068。テストコードの分離とリファクタによる良性減少。
3. **deploy-vps.sh 統一ルールの明文化**：CLAUDE.md 内で禁止コマンドと正規フローを厳格化。
4. **`mainへの直接コミット禁止` ルール策定** (1dab677)：feature branch + PR + Codex review の強制化。
5. **Pythonキャッシュの Git 追跡解除** (b6a21cc)：`.gitignore` 整備によりリポジトリノイズ削減。
6. **conversion tracking guide 追加** (`docs/CONVERSION_TRACKING_GUIDE.md`)：Phase65-2 の導入ガイドドキュメント化。

### 3.2 維持された健全指標

- `@ts-ignore` 0 件
- 循環依存 0 件
- `console.*`（非テスト）0 件
- ルート未登録ミドルウェア 0 件
- security-scan.sh production 脆弱性 High/Critical 0 件

### 3.3 悪化または要再確認の点

| 項目 | 前回 | 今回 | 評価 |
|---|---|---|---|
| Admin UI 最大行数 | 2,210 行 | 2,280 行 | 微増（+70）、分割未着手 |
| `tenants/[id].tsx` | 1,648 行 | 1,957 行 | **+309 行**、分割強く推奨 |
| `billing/index.tsx` | 1,031 行 | 1,488 行 | **+457 行**、分割強く推奨 |
| `: any` | 50 | 61 | △+11、四半期棚卸し推奨 |
| `as any` | 79 | 84 | △+5、同上 |
| Dead exports | 21 (正当) | 139 (要精査) | 検出ロジック差異の可能性、再確認必要 |

### 3.4 新規可視化された指標

- `pnpm audit` 総計：Critical 1 / High 20 / Moderate 16 / Low 3（ただし大半 devDeps）
- TODO/FIXME/HACK：6 件
- 環境変数参照数：104 個
- Test suites / tests：110 / 1,122
- SCRIPTS/ 累積：72 files

---

## 4. アクションリスト

### 4.1 P0（今すぐ対応）

**なし**。本番障害リスクとなる緊急項目は検出されなかった。

### 4.2 P1（次 Phase で対応）

#### ~~P1-1. axios の DoS 脆弱性対応（SEC-1）~~ ✅ **対応済 (PR #112)**

- **誤分類訂正**：当初「production dep」と記載したが、実際は `wait-on@9.0.3` (devDep) 経由の推移的依存だった。
- **対応内容**：
  - `wait-on` を `^9.0.5`（axios 修正済みバージョンを同梱）へアップデート
  - `pnpm.overrides["axios"] = ">=1.15.0"` を追加してトランジティブ依存を強制固定
  - `pnpm audit` 結果: High **-3** 件（40 vuln → 37 vuln）
- **結果**：Gate 2 (security-scan.sh) は引き続き 0 件。本番リスクなし。

#### P1-2. Admin UI 巨大ファイル分割（MNT-1）

- **対象**：
  - `admin-ui/src/pages/admin/knowledge/[tenantId].tsx`（2,280 行）
  - `admin-ui/src/pages/admin/tenants/[id].tsx`（1,957 行）
  - `admin-ui/src/pages/admin/billing/index.tsx`（1,488 行）
- **手順（各ファイル共通）**：
  1. タブ / セクション境界を洗い出し、サブコンポーネントディレクトリへ抽出（例：`admin-ui/src/pages/admin/tenants/[id]/sections/`）
  2. 各サブコンポーネントは 300 行以内を目標
  3. 既存 props/state の依存をコンテキストまたは custom hooks に寄せる
  4. `pnpm --filter admin-ui test` で回帰確認
  5. feature branch → PR → Gate 1-3
- **目標**：各ファイルを 800 行以内に削減（`billing` は優先度最上）

#### ~~P1-3. Dead exports 139 件の再精査（TST-4）~~ ✅ **対応済 (PR #113)**

- **精査結果**：`ts-prune` で再計測した結果、src/ の真の未使用 export は **47 件**（ts-unused-exports の 139 件は型 alias / re-export / 意図的 public API による FP を多数含む）
- **対応内容**：
  - `src/agent/orchestrator/crew/crewSchemas.ts` 削除（`CrewOrchestratorRequest` / `CrewOrchestratorResponse`）
  - `src/auth/tokenBlacklist.ts` 削除（`TokenBlacklistEntry` / `BlacklistedToken`）
  - `export type TenantConfigResolver` / `export type ApiKeyTenantResolver` の export 除去（authMiddleware.ts）
  - `export type LoopType` の export 除去（loopDetector.ts）
  - `export const RAG_TOTAL_MAX_CHARS` の export 除去（ragLimits.ts）
  - `export class CrewAgent` → class export 除去（クラス自体は CrewOrchestrator.ts から使用継続）
- **結果**：src/ 真の未使用 47 → **41 件**（残 6 件は public API / 設計上の意図的 export）

### 4.3 P2（中優先・将来対応）

| ID | 項目 | メモ |
|---|---|---|
| SEC-2 | devDeps 経由 Critical/High 脆弱性群 | `pnpm up langchain langsmith` で推移確認。production には影響しないため緊急ではない |
| SEC-3 | body-parser / qs moderate 脆弱性 | Express 依存更新時に同時対応 |
| MNT-2 | widget.js 2,557 行の単一ファイル分割 | Rollup/esbuild によるモジュール化とバンドル検討 |
| MNT-3 | 新規 800+ 行コンポーネントの抑制 | 今後の Phase では PR 時点で 500 行超を警告するしきい値導入検討 |
| MNT-4 | analytics/routes.ts 972 行 | service 層への抽出 |
| DBT-1 | TODO/FIXME/HACK 6 件の棚卸し | ticket 化して Asana に登録 |
| DBT-2 | Admin API 18 モジュールの構造化 | ドメイン単位での再編成検討 |
| OPS-4 | widget.js CDN cache 戦略 | ファイル分割と content-hash 付与 |
| OPS-5 | SCRIPTS/ 72 ファイル棚卸し | Phase 別にアーカイブ |

### 4.4 P3（低優先・余力時に対応）

| ID | 項目 | メモ |
|---|---|---|
| UPG-2 | `: any` / `as any` 削減 | 四半期に 1 回、50/79 水準を目標に棚卸し |
| TST-3 | admin-ui テストの継続整備 | Vitest カバレッジを段階的に拡張 |
| DBT-3 | Admin UI 重複パターンの共通化 | モーダル・ウィザード系 hooks |
| DBT-4 | エラーメッセージ文字列の集約 | i18n 準備にもなる |

---

## 5. 総評

R2C プロジェクトは **型安全性・セキュリティ基盤（production）・デプロイ規律** の 3 本柱が健全性を維持しており、前回監査からの 9 日間で回帰なし。テストファイル数 +29 は特筆すべき改善。

一方、**Admin UI の巨大ファイル問題は確実に悪化している** 点が最大の懸念。`tenants/[id].tsx` +309 行、`billing/index.tsx` +457 行は 1 Phase の追加量として過剰であり、次 Phase 前にリファクタ枠を確保することを強く推奨する。

production 依存の脆弱性は Gate 2 の production-only スキャンで 0 件を維持。axios の脆弱性は wait-on (devDep) 経由の推移的依存であり production に直接影響しないが、PR #112 にて対応済み。devDeps 経由の残 18 件は本番影響なしとして P2 分類で問題ない。

P0 項目なし、P1 項目 **1 件**（Admin UI 巨大ファイル分割）に絞り込まれた。axios 脆弱性 (PR #112) と Dead exports (PR #113) は本監査期間中に対応済みのため、次 Phase は MNT-1 の分割リファクタを最優先課題とする。

---

*監査日: 2026-04-19 / 前回監査: 2026-04-10 (CODE_HEALTH_REPORT.md)*

---

## 6. 修正履歴

| 日付 | 修正内容 | 関連 PR |
|---|---|---|
| 2026-04-19 | 初版作成 | PR #111 |
| 2026-04-19 | SEC-1 分類訂正: 「production dep」→「wait-on@9.0.3 devDep 経由の推移的依存」に修正。対応済みステータス追記。 | PR #112 |
| 2026-04-19 | TST-4 / P1-3: ts-prune による再精査結果 (src/ 真の未使用 47→41 件) と対応済みステータスを追記。 | PR #113 |
| 2026-04-19 | P1 件数を 3→1 に更新（残存 P1 は MNT-1 Admin UI 巨大ファイルのみ）。 | — |
