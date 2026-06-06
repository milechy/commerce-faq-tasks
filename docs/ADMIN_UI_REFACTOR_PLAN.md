# Admin UI 巨大ファイルリファクタ — PR 分割計画

**Asana:** [Phase2-P1-2] Admin UI 巨大ファイルリファクタ (機能変更禁止、段階的PR) — GID `1214120401966111` (due 2026-06-15)
**前提ゲート:** Phase69 (GID `1214250035223767`) サブタスク 3/3 完了済 → 着手ゲート充足 (2026-06-06 確認)
**位置づけ:** タスク notes が要求する「**着手前の PR 分割計画の事前検討**」の成果物。本計画の承認後に実装 PR を開始する。
**原則:** **機能変更禁止 (no behavior change)** / **段階的 PR** / 1 PR = 1 ファイル群 = レビュー可能サイズ。

---

## 0. 進捗 (PR1–3 完了分)

| PR | 内容 | 状態 |
|---|---|---|
| #310 | SettingsTab: PostHogIntegrationTab・Ga4IntegrationTab を別ファイル分離 | MERGED |
| #311 | SettingsTab: ApiKeysTab・EmbedCodeTab 分離 + 共有 `types.ts` 導入 | MERGED |
| #312 | SettingsTab: 残タブ 5 本を別ファイル分離 | MERGED |

→ **SettingsTab 系の分離は完了**。本計画は **残る巨大ページ/コンポーネント** を対象とする。

---

## 1. 対象ファイル インベントリ (2026-06-06 実測, admin-ui/src 配下 .tsx)

| # | ファイル | 行数 | 種別 | 優先 |
|---|---------|-----:|------|:---:|
| 1 | `pages/admin/knowledge/[tenantId].tsx` | 2355 | ページ (タブ容器 + 5 タブをローカル実装) | **P1** |
| 2 | `pages/admin/billing/index.tsx` | 1488 | ページ | P2 |
| 3 | `pages/admin/analytics/index.tsx` | 1265 | ページ | P2 |
| 4 | `pages/admin/chat-history/[sessionId].tsx` | 1169 | ページ | P3 |
| 5 | `pages/admin/tenants/[id].tsx` | 1148 | ページ | P3 |
| 6 | `pages/admin/avatar/studio.tsx` | 986 | ページ | P3 |
| 7 | `pages/admin/avatar/index.tsx` | 952 | ページ | P3 |
| 8 | `components/tuning/TuningRuleModal.tsx` | 916 | コンポーネント | P4 |
| 9 | `components/knowledge/KnowledgeListTab.tsx` | 878 | コンポーネント | ⚠️ #1 と要照合 |
| 10 | `components/avatar-wizard/AvatarWizard.tsx` | 859 | コンポーネント | P4 |
| 11 | `pages/admin/feedback/index.tsx` | 837 | ページ | P4 |
| 12 | `components/admin/AIReportTab.tsx` | 817 | コンポーネント | P4 |
| 13 | `pages/admin/engagement/index.tsx` | 800 | ページ | P4 |
| 14 | `pages/admin/chat-test/index.tsx` | 785 | ページ | P4 |

しきい値の目安: **>800 行を分割対象**、目標は 1 ファイル ≤ ~400 行。

---

## 2. ⚠️ 最重要: 重複/分岐の罠 (P1 着手前に必ず解消)

`pages/admin/knowledge/[tenantId].tsx` (2355 行) は以下のタブを **ファイル内ローカル関数として再実装**している:

| ローカル関数 (in [tenantId].tsx) | 行範囲 | `components/knowledge/` の既存同等品 | 状態 |
|---|---|---|---|
| `KnowledgeListTab` | 251–732 | `KnowledgeListTab.tsx` (878 行) | **重複/分岐** |
| `TextInputTab` | 733–1054 | `TextInputTab.tsx` (10KB) | **重複/分岐** |
| `ScrapeTab` | 1055–1417 | `UrlScrapeTab.tsx` (12KB) | **重複/分岐疑い** |
| `GlobalKnowledgeCheckbox` | 207–250 | `GlobalKnowledgeCheckbox.tsx` (1KB) | **重複/分岐** |
| `BookUploadsSection` / `PdfUploadTab` | 1449–2173 | `PdfUploadSection.tsx` (4.5KB) | **部分重複疑い** |
| `KnowledgeAttributionTab` | (import のみ) | `KnowledgeAttributionTab.tsx` | ✅ 共有版を使用 |

**事実:** ページは `KnowledgeAttributionTab` だけを `components/knowledge/` から import し、他タブは**ローカル版を使用**している (line 10 のみ import)。

**含意:** これは単純な cut-paste 抽出では解決しない。各タブについて **(a) ローカル版と component 版の差分を取り**、以下を判定する必要がある:

- **同一** → ローカル版を削除して既存 component を import (dead-copy 解消)
- **ローカル版が新しい** → component 版を更新 (or 置換) し import に切替
- **分岐して別物** → 命名を分けて両方を正式採用、または統合

→ **この照合作業 (PR1a) を抽出 (PR1b) より前に独立 PR 化する。** 照合なしの抽出は「機能変更禁止」を破る (どちらの実装が本番動作かを取り違える)。

---

## 3. PR 分割シーケンス (提案)

### Phase A — knowledge/[tenantId].tsx (最大・最優先)

| PR | スコープ | 想定差分 | 機能影響 |
|---|---|---|---|
| **A0** | 共有抽出: `getAccessToken`/`fetchWithAuth`/`formatDate`/`resolveKnowledgeGap` と スタイル定数 (`CARD_STYLE`/`BTN_*`/`TEXTAREA_STYLE`/`SELECT_STYLE`) を `components/knowledge/shared.ts` (既存) へ集約、interfaces を `types.ts` へ | helpers/styles のみ移動 | なし |
| **A1** | **重複照合レポート**: 各ローカルタブ vs `components/knowledge/*` の差分を `docs/` に記録し、タブごとに「採用元」を確定 (コード変更なし、判断 doc のみ) | docs のみ | なし |
| **A2** | `GlobalKnowledgeCheckbox` + `GapQuestionBanner` を component 化/共有版へ統一 | 小 | なし (要 A1 判定) |
| **A3** | `TextInputTab` をローカル削除→ component 版へ統一 (A1 で採用元確定後) | 中 | なし |
| **A4** | `ScrapeTab` → `UrlScrapeTab.tsx` へ統一 | 中 | なし |
| **A5** | `BookUploadsSection` + `PdfUploadTab` を `components/knowledge/PdfUploadTab.tsx` へ抽出 (508+185 行、最大) | 大 | なし |
| **A6** | `KnowledgeListTab` をローカル削除→ component 版へ統一 (878 行、要慎重照合) | 大 | なし |
| **A7** | 容器 `TenantKnowledgePage` を ≤200 行に圧縮 (タブ配線のみ残す) + 最終確認 | 小 | なし |

> A2–A6 は各タブ独立のため **並列 PR 化可** (24h ループの最大 3 並列ルールに従う)。ただし A0/A1 完了が前提。

### Phase B — 単一責務ページ (各 1 PR)

billing (1488) / analytics (1265) は「データ取得 hook + 表示セクション」に分離。各ページで:

- `usePageData()` カスタム hook に fetch ロジック集約
- 表示ブロックを `components/<page>/` 配下の section コンポーネントへ抽出

### Phase C — 残ページ/コンポーネント (P3/P4)

chat-history / tenants / avatar系 / TuningRuleModal / AvatarWizard / feedback / AIReportTab / engagement / chat-test を同パターンで順次。優先度低、Phase A/B のパターン確立後に機械的適用。

---

## 4. 各 PR 共通 DoD (機能変更禁止の担保)

1. `cd admin-ui && pnpm typecheck` → 0 errors
2. `cd admin-ui && pnpm build` → 成功 (バンドル生成)
3. **差分の性質確認**: `git diff` が「移動 + import 追加」のみで、ロジック行の変更が無いことを目視 + reviewer 確認
4. 抽出元と抽出先で **JSX 構造・props・state・effect が 1:1 対応**することをコメントで明示
5. E2E が存在するページは該当 Playwright シナリオを実行 (admin-ui の e2e 対象範囲を確認)
6. Gate 2.5 (Codex review): コンポーネント抽出は behavior-change の有無を重点確認。docs-only PR (A1) はスキップ可
7. 1 PR の差分行数目安 ≤ ~600 行 (レビュー可能性優先、超える場合は分割)

---

## 5. リスクと制御

| リスク | 制御 |
|---|---|
| ローカル版と component 版を取り違えて本番動作が変わる | **A1 照合 PR を必須前提化**。差分ゼロを確認してから統一 |
| 抽出時に state lift / props drilling で挙動変化 | state は容器に残し、タブは純粋 props 受け取りに統一。effect の依存配列を 1:1 維持 |
| 大量 PR で main が動く中での衝突 | 各 PR を origin/main から都度切る。Phase A 内は A0→A1 直列、A2–A6 並列だが同一ファイル編集の衝突に注意 (全て `[tenantId].tsx` を触るため**実際は直列推奨**) |
| Cloudflare Pages auto-deploy (main merge=即本番) | 機能変更禁止が崩れると即本番影響。各 PR merge 後に admin-ui の主要画面を目視確認 |
| 24h 自走中の自動 merge | リファクタ PR は**人間 merge 推奨** (機能等価性の最終判断が必要) |

---

## 6. 推奨実行順 (まとめ)

1. **A0** (helpers/styles/types 集約) — 低リスク・着手容易
2. **A1** (重複照合 docs) — **最重要ブロッカー解消**
3. A2 → A3 → A4 → A5 → A6 (同一ファイルを触るため直列) → A7 (容器圧縮)
4. Phase B (billing/analytics)
5. Phase C (残り)

> Phase A だけで `[tenantId].tsx` 2355 行 → 容器 ≤200 行 + 既存 component 統一 を達成し、最大の負債を解消する。Phase B/C は確立パターンの機械適用。

---

## A0 完了記録 (2026-06-06, PR #315 merged)

`getAccessToken` / `fetchWithAuth` / `formatDate` / `resolveKnowledgeGap` + 5 スタイル定数を `components/knowledge/shared.ts` へ統一 (バイト一致確認の純粋移動)。ページ −103 行。型 (`KnowledgeItem`/`Tab`/`CATEGORY_LABELS`) は分岐のため A1 送りで未着手。

## A1 照合結果 (2026-06-06 実機確認) — **方針確定**

### 決定的事実
- ルータ `/admin/knowledge/:tenantId` → `TenantKnowledgePage` (`[tenantId].tsx`) → **ローカル版タブをレンダリング** (line 2240 の `<KnowledgeListTab>` はローカル関数 line 148 を解決)。
- `components/knowledge/` の `KnowledgeListTab.tsx`(878)/`TextInputTab.tsx`/`UrlScrapeTab.tsx`/`GlobalKnowledgeCheckbox.tsx`/`BulkActionBar`/`ExcludeSearchToggle`/`Pagination`/`FaqSearchBar` は **どこからも import されていない = デッドコード**。生きているのは `shared.ts` と `KnowledgeAttributionTab` のみ。

### 結論 (A2 以降の抽出方針)
| 判定 | 内容 |
|---|---|
| **抽出元** | **ページのローカル版** (= 本番で動いている実装) |
| **デッド component の扱い** | 分岐しているため「ページを既存 component へ差し替え」は**機能変更**になり不可。参考に留め、ローカル版から新規抽出する。import が無いので**上書き/削除は安全** (他に consumer 無し)。ただし下記 ⚠️ の KnowledgeListTab は除外機能の検証完了まで保留 |

### ⚠️ 副次発見 (本リファクタの scope 外・別タスク候補)
component `KnowledgeListTab.tsx` は 2026-05-31 に「検索除外チェックボックス」(Phase69-2-B) を追加済だが、**生きているローカル版には除外 UI が存在しない** (`excluded` 参照ゼロ)。Phase69-2-B は「完了・本番稼働」。

→ **Phase69-2-B の『ナレッジ管理除外チェックボックス』UI がデッド component にのみ実装され本番未配線の疑い**。`import 無し = 穴` の早断は禁止 (テナント設定 `default_excluded_ids` 側での担保可能性あり) のため、実画面検証で確定させてから別 Asana タスク化を判断する。

### 改訂シーケンス (A1 結果反映)
- A2: `GapQuestionBanner` + `GlobalKnowledgeCheckbox` をローカルから component へ抽出 (デッド同名 component は上書き)
- A3: `TextInputTab` / A4: `ScrapeTab` / A5: `BookUploadsSection`+`PdfUploadTab` を同様に
- A6: `KnowledgeListTab` — **除外 UI 検証完了後**に着手 (上記 ⚠️)
- A7: 容器圧縮

---

## 7. 一切しないこと (スコープ遵守)

- 機能・挙動の変更 (UI 文言/レイアウト/API 呼び出し/state ロジックの変更)
- main への直接 push / 自動 merge (人間承認後)
- VPS・DB・.env への操作
- 本計画外のファイルへの波及 (1 PR = 宣言したスコープのみ)

---

*作成: 2026-06-06 / 24h 自走セッション。実装ファイル構造の実測 (行数・関数境界・重複) に基づく。本計画は hkobayashi 承認後に実装 PR (A0 から) を開始する。*
