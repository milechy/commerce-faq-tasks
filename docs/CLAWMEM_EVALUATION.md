# ClawMem 評価・採否判断 — DoD 完全版

> 作成: 2026-06-05
> Asana GID: 1214893471685562
> 分類: Tier B (docs only)
> 前提調査: docs/CLAWMEM_VS_WOLF_EVALUATION.md (2026-06-04)

---

## Section 1: 現状の .wolf/ と ClawMem の機能比較

### 1.1 評価対象の確定

タスク作成時（2026-05）は第三者パッケージ `yoloshii/ClawMem`（TypeScript on Bun, MIT）の評価が目的だった。
その後の調査（2026-06-04 CLAWMEM_VS_WOLF_EVALUATION.md）で以下が確認された:

- Claude Code v2.1.83+ のビルトイン auto-memory システムが `yoloshii/ClawMem` の主要機能（preference 記憶・cross-session 学習・プロジェクト別ストレージ）を**標準搭載**している
- R2C プロジェクトはすでに `.claude/settings.json: "autoMemoryEnabled": true` でビルトイン auto-memory を稼働中
- 追加インストール不要のため、外部パッケージ導入リスクは**消滅**

本ドキュメントでは以後「ClawMem」をビルトイン auto-memory（`~/.claude-r2c-config/projects/…/memory/`）として扱う。

### 1.2 機能比較マトリクス

| 機能領域 | ClawMem (builtin) | .wolf/ | 重複度 | 備考 |
|---|---|---|---|---|
| クロスセッション preference 記憶 | ✅ feedback 型 | ✅ cerebrum.md §Preferences | **高** | 同機能 |
| クロスセッション key learnings | ✅ feedback/project 型 | ✅ cerebrum.md §Key Learnings | **高** | 同機能 |
| Do-Not-Repeat（罠リスト） | ✅ feedback 型（3 問フィルタ） | ✅ cerebrum.md §Do-Not-Repeat | **高** | 同機能 |
| ファイルインデックス（token 見積り） | ❌ 未対応 | ✅ anatomy.md | **なし** | 代替不可 |
| 構造化バグログ | ❌ 未対応 | ✅ buglog.json | **なし** | 代替不可 |
| セッション内アクションログ | ❌ クロスセッション保管のみ | ✅ memory.md | 低 | memory.md は 3800+ 行で S/N 低下中 |
| トークン計測・レジャー | ❌ 未対応 | ✅ token-ledger.json | **なし** | — |
| ユーザーロール記憶 | ✅ user 型 | ❌ 対応外 | なし | ClawMem のみ |
| 外部リソース参照先 | ✅ reference 型 | ❌ 対応外 | なし | ClawMem のみ |
| プロジェクト横断（複数リポ） | ✅ プロジェクト別 path | ❌ リポ固有 | なし | ClawMem の強み |

**anatomy.md 実績**: 累計 16.7M tok 削減（54% ヒット率）。ClawMem は anatomy.md を代替できない。

---

## Section 2: セキュリティレビュー

### 2.1 第三者パッケージ (yoloshii/ClawMem) の supply chain リスク

| リスク項目 | 評価 | 詳細 |
|---|---|---|
| CVE（2026-06-05 時点） | **N/A** | npm に公開されていない（GitHub リポのみ）→ npm audit 対象外 |
| supply chain attack | **除外理由あり** | R2C はビルトインを採用 → インストールしないため無関係 |
| Bun runtime 追加 | **不要** | ビルトイン採用のため追加 runtime 不要 |
| コード実行権限 | **N/A** | ビルトイン = Anthropic 提供の Claude Code 本体の一部 |

### 2.2 ビルトイン auto-memory のセキュリティ評価

| チェック項目 | 結果 |
|---|---|
| ストレージ場所 | `~/.claude-r2c-config/projects/…/memory/` — ローカルのみ、ネットワーク通信なし |
| データ外部送信 | `.claude/settings.json` の `autoMemoryEnabled` フラグで制御。クラウド同期なし |
| 書き込み対象 | preference / project / user / reference 型のみ。RAG コンテンツ・PII 直書き禁止（3 問フィルタ） |
| git 追跡 | `.gitignore` 登録済み（メモリファイルはリポジトリに含まれない） |
| Anti-Slop 整合 | RAG excerpt や書籍内容をメモリに書かないことは 3 問フィルタ (Q1: コードを読めば分かる？) で自動排除 |

**結論**: ビルトイン auto-memory はセキュリティリスクなし。第三者パッケージは採用しないため供給チェーンリスクは存在しない。

---

## Section 3: 独立安証試験

### 3.1 試験方法

ビルトイン auto-memory はすでに R2C 本番で稼働中（`autoMemoryEnabled: true`、2026-05 以降）。
新規インストールは不要であり「sandbox 試行」の代わりに**稼働実績の観測**で代替する。

### 3.2 稼働確認（2026-06-05 時点）

| 確認項目 | 結果 |
|---|---|
| MEMORY.md 存在 | `~/.claude-r2c-config/projects/-Users-hkobayashi-projects-commerce-faq-tasks/memory/MEMORY.md` — 存在 ✅ |
| エントリ数 | 12 エントリ（feedback / trap / project 型）— 正常書き込み済み ✅ |
| 3 問フィルタ適用 | 各エントリが frontmatter + body 構造を満たす ✅ |
| 24h ループ中の動作 | `.wolf/cerebrum.md` を READ-ONLY にしても `MEMORY.md` 書き込みが正常動作 ✅ |
| Lane 間引き継ぎ | MEMORY.md をセッション開始時にコンテキストとして取得できる ✅ |

### 3.3 第三者 yoloshii/ClawMem の試行非実施理由

- ビルトイン代替が判明した時点で追加試験の価値がない
- Bun runtime の VPS 追加は明示的に「一切しないこと」リストに含まれる
- npm audit 対象外のパッケージを本番環境に導入するリスクに見合う利益なし

---

## Section 4: R2C SECURITY_SCAN_POLICY.md との整合

### 4.1 現行ポリシーとの照合

| ポリシー項目 | ClawMem (builtin) | 整合 |
|---|---|---|
| 外部パッケージの脆弱性スキャン (`npm audit`) | インストールなし → 対象外 | ✅ |
| シークレット漏洩（gitleaks） | memory/ は `.gitignore` 登録 → スキャン対象外 | ✅ |
| High/Critical でデプロイブロック | auto-memory にデプロイ影響なし | ✅ |
| `SECURITY_SCAN_ALLOWLIST.md` への記載 | 第三者インストールなし → 追記不要 | ✅ |

### 4.2 Aikido Security Plugin との関係

Aikido Security Plugin（GID 1214725672243006、PR 済み）は Node.js 依存の CVE スキャンを担当。
ビルトイン auto-memory はファイルシステム上の `.md` ファイルのみで構成されており、Aikido のスキャン対象（npm パッケージ）に含まれない。競合・干渉なし。

### 4.3 SECURITY_SCAN_POLICY.md への追記

不要。ビルトイン auto-memory は外部依存を持たず、既存ポリシーのスコープ外で完結する。

---

## Section 5: 採否判断

### 5.1 オプション評価

| オプション | 内容 | 評価 |
|---|---|---|
| **Option A**: 代替 | .wolf/ そのものを ClawMem に移行 | ❌ anatomy.md・buglog.json の代替なし → 16.7M tok 増・バグ追跡消失 |
| **Option B**: 併存 | .wolf/ は Step 0、ClawMem は Lane 間メモリ共有 | ✅ **採用** — ただし役割を明確に分離 |
| **Option C**: 見送り | Auto Memory + Auto Dream で十分、.wolf/ 継続 | △ 現状は既に ClawMem (builtin) が稼働中。見送りは実態と矛盾 |

### 5.2 採択: **役割分担型併存（Selective Coexistence）**

```
ClawMem (builtin) — 主メモリ
├── feedback 型: preference・key learnings・do-not-repeat（新規書き込みはここ）
├── project 型:  プロジェクト状態・禁止事項の理由
├── reference 型: 外部リソース参照先
└── user 型:     ユーザープロファイル・役割

.wolf/ — 補完ツール
├── anatomy.md:      維持（ファイルインデックス・16.7M tok 削減実績）
├── buglog.json:     維持（構造化バグ追跡 6000+ 行）
├── token-ledger.json: 維持（自動計測、OpenWolf 管理）
├── cerebrum.md:     READ-ONLY（既存参照のみ。新規書き込み禁止）
└── memory.md:       廃止（新規書き込み停止。既存は参照可）
```

### 5.3 推奨案の根拠

1. **ゼロコスト移行**: ビルトイン auto-memory は既稼働。追加 install・runtime・設定変更なし
2. **セキュリティリスクなし**: 外部パッケージを採用しないため supply chain リスクゼロ
3. **anatomy.md は代替不可**: 削減実績 16.7M tok は測定済み。廃止コストが大きい
4. **役割の重複を解消**: cerebrum.md と ClawMem feedback 型の二重書き問題を根絶
5. **24h ループ整合**: READ-ONLY 制約（cerebrum.md / memory.md）はすでに CLAUDE.md に記載済み

---

## 関連ドキュメント

- `docs/CLAWMEM_VS_WOLF_EVALUATION.md` — 2026-06-04 前提調査・機能分析
- `docs/SECURITY_SCAN_POLICY.md` — R2C セキュリティスキャンポリシー
- `docs/SECURITY_SCAN_ALLOWLIST.md` — 許可済み CVE リスト
- CLAUDE.md §「auto-memory (MEMORY.md) 運用ルール」 — 書き込みフィルタ 3 問・役割分担
