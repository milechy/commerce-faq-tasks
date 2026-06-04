# ClawMem 評価・採否判断 — 代替 vs .wolf/ 併存

> 作成: 2026-06-04
> Asana GID: 1214893471685562
> 分類: Tier B (docs only)
> 担当 Lane: lane-20-tier-b-docs-clawmem-or-wolf

---

## 1. 前提整理

### 1.1 ClawMem とは

**ClawMem** = Claude Code (v2.1.83+) のビルトイン auto-memory システム。

- ストレージ: `~/.claude-r2c-config/projects/<project-slug>/memory/`
- インデックス: `MEMORY.md`（200 行上限 — CLAUDE.md コンテキストに常時ロード）
- エントリ形式: frontmatter (`name`, `description`, `type`) 付き個別 `.md` ファイル
- 型分類: `user` / `feedback` / `project` / `reference`
- 有効化: `.claude/settings.json` の `"autoMemoryEnabled": true`

書き込みフィルタ（3 問）:

| 問 | 条件 |
|---|---|
| Q1 | コードを読めば分かる？ → Yes なら書かない |
| Q2 | 2 週間後も正しいか？ → No なら書かない |
| Q3 | 次の自分が罠を踏まずに済むか？ → Yes なら書く |

### 1.2 OpenWolf (.wolf/) とは

OpenWolf はトークン最適化ミドルウェア。`.wolf/` ディレクトリに以下を保持:

| ファイル | 役割 | 規模 |
|---|---|---|
| `anatomy.md` | プロジェクト全ファイルのインデックス（トークン見積・概要 2〜3 行） | 1139 ファイル追跡 |
| `cerebrum.md` | セッション間学習メモリ（Preferences / Key Learnings / Do-Not-Repeat / Decision Log） | 54 行 |
| `memory.md` | セッション内アクションログ（タイムスタンプ・操作・ファイル名・トークン数） | 3632 行 |
| `buglog.json` | バグ修正ログ（error_message / root_cause / fix / tags） | 6359 行 |
| `token-ledger.json` | トークン使用量・anatomy ヒット率の計測 | — |
| `config.json` / `cron-*.json` | OpenWolf 設定・cron スケジュール状態 | — |
| `OPENWOLF.md` | OpenWolf 操作プロトコル（セッション毎に参照） | — |

---

## 2. 実績データ（2026-06-04 時点）

`.wolf/token-ledger.json` より:

| 指標 | 値 |
|---|---|
| 累計推定トークン | 17,406,757 tok |
| 総セッション数 | 227 sessions |
| anatomy ヒット | 3,696 回 |
| anatomy ミス | 3,165 回 |
| anatomy ヒット率 | **54%** |
| 繰り返し読み込みブロック数 | 3,544 回 |
| bare CLI 比推定削減 | **16,726,698 tok** |

anatomy.md によるトークン削減は 16.7M tok (full-file read 回避)。
ClawMem には anatomy.md に相当する機能が**存在しない**。

---

## 3. 機能比較マトリクス

| 機能領域 | ClawMem | .wolf/ | 重複度 | 備考 |
|---|---|---|---|---|
| クロスセッション preference 記憶 | ✅ feedback 型 | ✅ cerebrum.md §Preferences | **高** | 実質的に同じ |
| クロスセッション key learnings | ✅ feedback/project 型 | ✅ cerebrum.md §Key Learnings | **高** | 実質的に同じ |
| Do-Not-Repeat（過去の罠リスト） | ✅ feedback 型（3 問フィルタ） | ✅ cerebrum.md §Do-Not-Repeat | **高** | 実質的に同じ |
| ファイルインデックス（token 見積り） | ❌ 未対応 | ✅ anatomy.md | **なし** | ClawMem で代替不可 |
| 構造化バグログ | ❌ 未対応 | ✅ buglog.json | **なし** | ClawMem で代替不可 |
| セッション内アクションログ | ❌ クロスセッションのみ | ✅ memory.md | 低 | memory.md は超肥大（3632 行）、S/N 低下中 |
| トークン計測・レジャー | ❌ 未対応 | ✅ token-ledger.json | **なし** | — |
| ユーザーロール記憶 | ✅ user 型 | ❌ 対応外 | なし | ClawMem にしかない |
| 外部リソース参照先 | ✅ reference 型 | ❌ 対応外 | なし | ClawMem にしかない |
| プロジェクト横断（複数リポ） | ✅ プロジェクト別 path | ❌ リポ固有 | なし | ClawMem の強み |

---

## 4. 現状の問題点

24h 自走モード導入後、以下の矛盾が発生している（CLAUDE.md「学習セクション」より）:

```
.wolf/cerebrum.md / .wolf/memory.md = Read-Only (24h自走中)
MEMORY.md (auto-memory) = 唯一の書き込み可能領域
```

つまり **ClawMem への書き込みは既に実施中** だが、.wolf/ との役割境界が未定義のため:

1. cerebrum.md と ClawMem feedback 型に**二重書き**されるリスクがある
2. 新 Lane が OPENWOLF.md を参照 → `cerebrum.md` を更新しようとして失敗 → Do-Not-Repeat ログが消失する
3. `.wolf/memory.md` が 3632 行まで肥大 → S/N が低く実用価値が低下

---

## 5. 採否判断

### 結論: **役割分担型併存（Selective Coexistence）**

ClawMem を**主（Primary）**、.wolf/ を**補完（Supplementary）**とする分業体制に移行する。

| .wolf/ コンポーネント | 判断 | 理由 |
|---|---|---|
| `anatomy.md` | ✅ **維持** | 16.7M tok 削減実績。ClawMem に代替機能なし |
| `buglog.json` | ✅ **維持** | 構造化バグ追跡 (6359 行)。ClawMem の flat 型では代替困難 |
| `token-ledger.json` | ✅ **維持** | トークン計測。OpenWolf が自動管理 |
| `cerebrum.md` | ⚠️ **READ-ONLY 固定** | ClawMem feedback/project 型が同機能を担う。既存データは参照専用として残す |
| `memory.md` | 🔴 **段階廃止** | S/N 低・肥大 (3632 行)・ClawMem が cross-session 価値を吸収。新規書き込み停止 |
| `config.json` / `cron-*.json` | ✅ **維持** | OpenWolf 自動管理の設定ファイル。触らない |
| `OPENWOLF.md` | ⚠️ **修正対応** | memory.md 書き込み停止・cerebrum.md READ-ONLY を反映した更新が必要 |

---

## 6. 役割境界（確定版）

```
ClawMem (主)
├── 新規 feedback/preference/key learnings → feedback 型で ClawMem に書く
├── プロジェクト状態・禁止事項の理由 → project 型で ClawMem に書く
├── 外部リソース参照先 → reference 型で ClawMem に書く
└── ユーザープロファイル → user 型で ClawMem に書く

.wolf/ (補完)
├── anatomy.md → 維持（ファイルインデックス・トークン最適化）
├── buglog.json → 維持（構造化バグ追跡）
├── token-ledger.json → 維持（自動計測）
├── cerebrum.md → READ-ONLY（既存データの参照のみ可）
└── memory.md → 新規書き込み停止（既存ログは参照可）
```

---

## 7. CLAUDE.md 更新差分（推奨）

CLAUDE.md の「OpenWolf（トークン最適化ミドルウェア）」セクションに以下を追記:

```diff
+## OpenWolf (.wolf/) と ClawMem の役割境界（2026-06-04 確定）
+
+| コンポーネント | 用途 | 状態 |
+|---|---|---|
+| anatomy.md | ファイルインデックス・読み込み前参照 | **維持（読み書き可）** |
+| buglog.json | バグ修正ログ | **維持（読み書き可）** |
+| cerebrum.md | 過去セッション学習（旧形式） | **READ-ONLY（新規書き込み禁止）** |
+| memory.md | セッションアクションログ（旧形式） | **廃止（新規書き込み禁止）** |
+
+新規の preference / key learnings / do-not-repeat は ClawMem (MEMORY.md) に書くこと。
+ClawMem の書き込みフィルタ（Q1〜Q3）を必ず適用する。
```

---

## 8. 移行手順（今後の作業）

### 即時対応（このタスクで完結）

- [x] 本ドキュメント作成（評価・役割境界の文書化）

### 次 Phase 対応（別タスクで起票推奨）

- [ ] CLAUDE.md に §7 の差分を追記（Tier B docs タスク）
- [ ] OPENWOLF.md の更新: memory.md 書き込み停止・cerebrum.md READ-ONLY を反映
- [ ] `.wolf/memory.md` の新規書き込みを OpenWolf に止めさせる（config.json の書き込みフラグ確認）

---

## 9. まとめ

ClawMem は cerebrum.md と memory.md（クロスセッション部分）を**完全に代替できる**。
一方、anatomy.md（ファイルインデックス + 16.7M tok 削減実績）と buglog.json（6359 行の構造化バグ DB）は ClawMem に代替手段がなく、**廃止によるコスト増・品質低下が計測済み**。

よって「完全置換」は不採用。**役割分担型の併存**が最適解:

- ClawMem = 知識・選好・禁止事項の主メモリ
- .wolf/anatomy.md + buglog.json = トークン最適化・バグ追跡の補完ツール
