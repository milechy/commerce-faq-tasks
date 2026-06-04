# 24H ループ 学習機能統合設計

> 作成: 2026-05-18
> Asana GID: 1214891874822963
> 実装予定: Phase 1-G（別タスク GID:1214886037602478）
> 本書は **設計のみ**。実装は別タスクで行う。

---

## 公式仕様確認結果サマリー

> ⚠️ web_search + WebFetch（[memory](https://code.claude.com/docs/en/memory), [sub-agents](https://code.claude.com/docs/en/sub-agents)）で 2026-05-18 に確認。確認できなかった仕様は各所に「公式 doc 未確認」と明記。

| 機能 | 公式名称 | 確認状況 | 公式 URL |
|---|---|---|---|
| Auto Memory | `autoMemoryEnabled` / `~/.claude/projects/<proj>/memory/` | ✅ 確認済 | [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory) |
| Subagent Memory | `memory: user\|project\|local` (frontmatter フィールド) | ✅ 確認済 | [code.claude.com/docs/en/sub-agents](https://code.claude.com/docs/en/sub-agents) |
| Auto Dream | 該当機能なし（CLI の "auto dream" は公式未定義） | ❌ 公式 doc 未確認 | — |
| Dreaming (Managed Agents) | Managed Agents Research Preview、別製品 | ✅ 別製品として確認 | [Dreaming ウェイトリスト](https://claude.com/form/claude-managed-agents) |
| Session Memory | claude.ai の cross-session 機能（CLI とは別） | ⚠️ claude.ai 側のみ確認 | [support.anthropic.com](https://support.anthropic.com/en/articles/11817273-using-claude-s-chat-search-and-memory-to-build-on-previous-context) |
| `tengu_session_memory` flag | 内部フラグ名、公式ドキュメント非公開 | ❌ 公式 doc 未確認 | — |
| `/remember` コマンド | スラッシュコマンドとしては未確認。会話中「remember X」→ auto memory 保存 | ⚠️ 部分確認 | [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory) |
| CLAUDE.local.md | Personal project-specific、gitignore 対象 | ✅ 確認済 | [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory) |

---

## Section 1: メモリ 4 層の役割分担

### 1.1 全体構造

R2C の 24h ループにおけるメモリは 4 層で構成される。各層は作成者・スコープ・用途が異なり、互いに補完する。

| 層 | メカニズム | 作成者 | スコープ | R2C での応用 |
|---|---|---|---|---|
| **L1** | CLAUDE.md | 人間 (hkobayashi) | リポ全体（git 管理） | 不変ルール (Security Middleware Order, Git Branch Rule, `deploy-vps.sh` 単独デプロイ, Anti-Slop) |
| **L2** | Auto Memory (`MEMORY.md`) | CLI 自動 | git リポ単位（`~/.claude-r2c-config/projects/<hash>/memory/`） | Gate 失敗パターン、VPS quirks、Codex 指摘傾向、Lane ルーティング傾向 |
| **L3** | claude.ai Session Memory | claude.ai 自動 | セッション間（claude.ai 側） | morning-report へのコンテキスト継続、前日サマリ反映（※公式 doc 未確認部分あり） |
| **L4** | OpenWolf `.wolf/` | CLI hook (stop.js 等) | CLI 本体（ベースリポのみ） | セッション起動時の Step 0 生成（`cerebrum.md` / `memory.md` / `anatomy.md` / `buglog.json`） |

### 1.2 R2C 固有パス（`CLAUDE_CONFIG_DIR=~/.claude-r2c-config` 適用後）

```text
# Auto Memory（L2）
~/.claude-r2c-config/projects/<git-hash>/memory/
├── MEMORY.md          # index（先頭 200 行または 25KB がセッション先頭に自動ロード）
├── gate-patterns.md   # Gate 失敗パターン
├── vps-quirks.md      # VPS 固有の問題
└── codex-findings.md  # Codex review 傾向

# Lane Agent Memory（Section 2 参照）
.claude/agent-memory/lane-{N}/   # memory: project（git 管理）
.claude/agent-memory-local/lane-{N}/  # memory: local（gitignore、マシンローカル）
```

### 1.3 worktree での挙動（.wolf/hooks/HOOK_BEHAVIOR.md 記載）

- **ベースリポ** (`~/projects/commerce-faq-tasks/`): L2 Auto Memory 更新あり
- **worktree** (`.claude/worktrees/lane-{N}/`): `stop.js` が worktree 検知 → `.wolf/*` 書き込み no-op（L4 OpenWolf は更新されない）
- **Lane Agent Memory**: worktree からも `.claude/agent-memory/lane-{N}/` は更新可能（パスが worktree 外のため）

---

## Section 2: Lane 専用 subagent の Auto Memory 分離

### 2.1 公式 subagent memory フィールド

> **公式確認**: frontmatter フィールド名は `memory`（値: `user` / `project` / `local`）。  
> ユーザープロンプトで言及した `autoMemoryScope: subagent` は公式には存在しない。正式名称に修正。  
> 参照: [code.claude.com/docs/en/sub-agents](https://code.claude.com/docs/en/sub-agents)

```yaml
# .claude/agents/lane-2-api.md 例
---
name: lane-2-api
description: R2C API 変更 (src/, avatar-agent/) を担当する Lane 2 エージェント。Tier A 以上のタスクを処理。
model: claude-sonnet-4-6
memory: project  # .claude/agent-memory/lane-2-api/ に記憶を蓄積（git 管理）
---

あなたは R2C API 変更専門の Lane エージェントです。
作業前に agent memory を確認し、過去の Gate 失敗パターンや API 設計判断を参照してください。
作業後に memory を更新し、学んだパターンを記録してください。
```

### 2.2 Lane 5 本の役割・memory scope 設計

| Lane | ファイル | 担当領域 | memory scope | 学習領域 |
|---|---|---|---|---|
| lane-1-docs | `.claude/agents/lane-1-docs.md` | `docs/`, `.claude/lane-templates/` | `local` | docs パターン、markdownlint quirks、Section 構成の好み |
| lane-2-api | `.claude/agents/lane-2-api.md` | `src/`, `avatar-agent/` | `project` | API 設計判断、型エラーパターン、Groq 呼び出し quirks |
| lane-3-test | `.claude/agents/lane-3-test.md` | `src/**/__tests__/`, `admin-ui/**/__tests__/` | `project` | モック方針、テスト配置ルール、外部 API モック最小構成 |
| lane-4-ops | `.claude/agents/lane-4-ops.md` | `SCRIPTS/`, `ecosystem.config.cjs` | `local` | PM2 quirks、cron-wrapper 動作、deploy-vps.sh 除外リスト |
| lane-5-security | `.claude/agents/lane-5-security.md` | `src/middleware/`, `src/auth/` | `project` | Codex adversarial-review 指摘傾向、RLS bypass パターン |

> **scope 選択理由**: `project`（git 管理）はチームで共有可能なパターン（API 設計・テスト方針・セキュリティ知見）に使用。`local`（gitignore）はマシン固有の quirks（VPS 接続、個人の cron 設定）に使用。

### 2.3 各 Lane の memory ディレクトリパス

```text
# memory: project
.claude/agent-memory/lane-2-api/
├── MEMORY.md        # 先頭 200 行または 25KB がサブエージェント system prompt にロード
├── api-patterns.md  # API 設計で繰り返し現れたパターン
└── gate-history.md  # Gate 失敗と fix の記録

# memory: local（gitignore 対象）
.claude/agent-memory-local/lane-1-docs/
├── MEMORY.md
└── docs-quirks.md   # マシン固有の docs ビルド挙動
```

### 2.4 .claude/agents/ への追加方法（Phase 1-G で実施）

```yaml
# 最小構成テンプレート（Tier B docs lane 用）
---
name: lane-1-docs
description: R2C docs 変更 (docs/, .claude/lane-templates/) を担当する Lane 1 エージェント。Tier B タスクを処理。
model: claude-sonnet-4-6
memory: local
---

作業前: "Review your agent memory for docs patterns before starting."
作業後: "Update your agent memory with new learnings from this task."
```

---

## Section 3: Auto Dream 運用ルール

### 3.1 重要な前提確認（公式 doc 未確認部分を明記）

> ⚠️ **「Auto Dream（24h + 5 セッション）」は Claude Code CLI の公式ドキュメントに記載がない（2026-05-18 時点）。**  
> 以下の 2 つの機能を区別する：
>

| 機能 | 製品 | 状態 |
|---|---|---|
| Dreaming (Research Preview) | Managed Agents（API 経由、別製品）| ウェイトリスト申請済（PR #174）、承認待ち |
| claude.ai Session Memory | Claude.ai（Web / Desktop）| 24h ごとに会話要約更新（Pro/Max）|
| Auto Memory（CLI）| Claude Code CLI | セッション跨ぎ記憶、Claude が自動書き込み（確認済）|

### 3.2 Managed Agents Dreaming の R2C 統合計画

> 公式: [claude.com/form/claude-managed-agents](https://claude.com/form/claude-managed-agents)（ウェイトリスト申請済み）  
> Dreaming の実際の動作仕様は承認後に公式 doc で確認する（現時点で仕様非公開）。

| タイミング | アクション | 担当 |
|---|---|---|
| Dreaming 承認通知受信 | `docs/MANAGED_AGENTS_APPLICATION.md` に「承認結果」セクション追加 | hkobayashi |
| 公式 doc 確認後 | 本ドキュメント Section 3 を実際の仕様で更新 | CLI |
| Phase 2 以降 | Dreaming を `r2c-morning-report.sh` のレポートサイクルに統合 | 実装タスク別途 |

### 3.3 現時点で実施可能: Auto Memory 手動整理タイミング

CLI の Auto Memory（L2 層）については確認済みの機能として以下の運用ルールを定める：

| タイミング | アクション | 理由 |
|---|---|---|
| 大規模リファクタ後（例: Phase69-3 kill-switch 完了時）| `~/.claude-r2c-config/projects/<hash>/memory/MEMORY.md` を `/memory` で確認・不要エントリ削除 | 古い quirks がノイズになる |
| Phase 完了時（Phase 1/2/3 各完了後）| MEMORY.md に Phase 完了サマリを `gate-patterns.md` として切り出し | 次 Phase の CLI が参照しやすい形に整理 |
| Pushover priority 2 障害収束後 | lane-4-ops の memory に障害内容と対処を記録 | 同一障害の再発防止 |
| 毎週月曜 morning-report | MEMORY.md の古いエントリ（30 日以上未参照）を確認・アーカイブ | 200 行 cap を維持 |

### 3.4 `/memory` コマンド（CLI 確認済み機能）

```bash
# セッション内で実行
/memory
# → CLAUDE.md / CLAUDE.local.md / auto memory folder のリストを表示
# → auto memory の ON/OFF トグル可能
# → memory ファイルをエディタで開ける
```

---

## Section 4: /remember コマンドの運用

### 4.1 公式仕様確認結果

> **公式確認**: `/remember` はスラッシュコマンドとして公式ドキュメントに記載なし（2026-05-18 時点）。  
> 実際の動作は「会話中に Claude に "remember X" と伝える → Auto Memory に書き込まれる」。  
> 参照: [code.claude.com/docs/en/memory §View and edit with /memory](https://code.claude.com/docs/en/memory)

公式引用:
> "When you ask Claude to remember something, like 'always use pnpm, not npm' or 'remember that the API tests require a local Redis instance,' Claude saves it to auto memory. To add instructions to CLAUDE.md instead, ask Claude directly, like 'add this to CLAUDE.md,' or edit the file yourself via /memory."

### 4.2 R2C 運用ルール

```text
自然言語: "このパターンを覚えておいて: Groq 70B は正確に LLM_MODEL_70B env var で参照する"
  ↓
Claude が Auto Memory に保存
  ↓
~/.claude-r2c-config/projects/<hash>/memory/MEMORY.md に追記
```

**claude.ai が CLI に `/remember` 相当を指示するケース:**

- Lane で同じ fix を 3 回以上見た場合、claude.ai が次の CLI セッション冒頭で「以下をメモリに追加してください」と指示
- 対象: Gate 失敗の root cause、VPS の quirk、Anti-Slop 違反パターン

### 4.3 CLAUDE.local.md の活用（確認済み公式機能）

```text
CLAUDE.local.md  ← 個人専用、gitignore 対象、マシンローカル
```

| 用途 | 内容例 |
|---|---|
| 個人 sandbox URL | `VITE_API_BASE=http://localhost:3100`（本番と異なるローカル値） |
| 個人テストデータ | `carnation テナント用 API key（テスト用）: xxx`（プレースホルダー） |
| 個人 worktree パス | 現在作業中の worktree パス memo |

**将来チーム参加時の CLAUDE.local.md 共有方針:**

- 空白（Phase70+ で検討）
- 共有すべきものは CLAUDE.md または `.claude/rules/` へ移行する
- 共有不可の個人情報（ローカル認証情報等）は CLAUDE.local.md に残す

---

## Section 5: OpenWolf (.wolf/) との併存

### 5.1 役割分担の明確化

| コンポーネント | 配置 | 役割 | Phase 2 以降の方針 |
|---|---|---|---|
| `MEMORY.md` (L4 OpenWolf) | `.wolf/memory.md` | セッション操作ログ（HH:MM / file / outcome / tokens） | **移管対象**: Auto Memory L2 がより適切。Phase 2 で縮小 |
| `cerebrum.md` | `.wolf/cerebrum.md` | CLI セッション起動時の Step 0 生成（Do-Not-Repeat / Preferences / Decision Log） | **移管対象**: Auto Memory L2 の `MEMORY.md` に統合予定（Phase 2-3） |
| `anatomy.md` | `.wolf/anatomy.md` | リポ構造スナップショット（ファイル一覧 + token 見積もり） | **.wolf/ 保持**: Auto Memory に同等機能なし、静的スナップショットとして継続 |
| `buglog.json` | `.wolf/buglog.json` | 構造化バグ記録（error / root_cause / fix / tags） | **.wolf/ 保持**: 構造化データ形式は Auto Memory markdown に不向き |
| `token-ledger.json` | `.wolf/token-ledger.json` | セッション別トークン消費集計 | **.wolf/ 保持**: Auto Memory には集計機能なし |

### 5.2 worktree での書き込み競合回避（HOOK_BEHAVIOR.md 準拠）

```text
[ベースリポ]
.wolf/hooks/stop.js → 正常実行（cerebrum.md / memory.md / token-ledger.json 更新）
Auto Memory: ~/.claude-r2c-config/projects/<hash>/memory/ → 正常更新

[worktree: .claude/worktrees/lane-{N}/]
.wolf/hooks/stop.js → git rev-parse --git-dir = .git/worktrees/* → exit 0 (no-op)
Auto Memory: 更新なし（worktree は main Auto Memory を共有しない）
Lane Agent Memory: .claude/agent-memory/lane-{N}/ → 更新あり（worktree 外パス）
```

### 5.3 重複領域の解決ルール（Phase 1 現在）

- **重複発生時**: Auto Memory L2 を優先（公式機能、長期安定）
- **OpenWolf が独自**: `anatomy.md`, `buglog.json`, `token-ledger.json` は .wolf/ 保持
- **Phase 2 マイグレーション候補**: `cerebrum.md` → Auto Memory MEMORY.md + topic files

### 5.4 Phase 2 以降の縮小ロードマップ

| Phase | 変更 | 詳細 |
|---|---|---|
| Phase 2 | `.wolf/cerebrum.md` の役割縮小 | Do-Not-Repeat エントリを Auto Memory `MEMORY.md` へ定期エクスポート |
| Phase 3 | `.wolf/memory.md` を廃止候補に | セッションログは Auto Memory が代替 |
| Phase 4 | `.wolf/` を anatomy + buglog + token-ledger のみに | 軽量化完了 |
| Phase 70+ | OpenWolf → Claude Memory Tool 評価（別タスク `MEMORY_TOOL_EVALUATION.md` 参照）| |

---

## Section 6: 設定手順（Phase 1-G で実装適用予定）

> 実装タスク: GID:1214886037602478

### 6.1 Auto Memory パスの明示設定

```json
// ~/.claude-r2c-config/settings.json
{
  "autoMemoryEnabled": true,
  "autoMemoryDirectory": "~/.claude-r2c-config/projects-memory"
}
```

> **注意**: `autoMemoryDirectory` は user settings または `--settings` フラグのみ有効。project / local settings では無効（セキュリティ制約）。  
> 参照: [code.claude.com/docs/en/memory §Storage location](https://code.claude.com/docs/en/memory)

### 6.2 Lane Agent への memory フィールド追加

```yaml
# .claude/agents/lane-2-api.md （既存ファイル編集）
---
name: lane-2-api
description: "..."
model: claude-sonnet-4-6
memory: project   # ← 追加（公式フィールド）
---
```

追加後の確認:

```bash
# セッション内
@lane-2-api "あなたの agent memory を確認して"
# → .claude/agent-memory/lane-2-api/MEMORY.md が存在すれば記憶が返ってくる
```

### 6.3 Session Memory 確認（claude.ai 側）

> **公式 doc 未確認**: `tengu_session_memory` フラグは非公開のため、以下は公表情報に基づく推定。  
> Claude.ai Pro/Max では cross-session memory が有効（会話要約が 24h ごとに更新）。  
> 参照: [support.anthropic.com](https://support.anthropic.com/en/articles/11817273-using-claude-s-chat-search-and-memory-to-build-on-previous-context)

```text
確認手順（claude.ai 側）:
1. claude.ai Settings → Features → Memory: ON になっていることを確認
2. 前日の会話が新しいセッションに引き継がれているか確認
3. morning-report 内容が前日サマリを反映しているか目視確認
```

### 6.4 `/memory` コマンドで確認

```bash
# Claude Code CLI セッション内
/memory
# 期待する出力:
# ✅ CLAUDE.md: /path/to/CLAUDE.md
# ✅ Auto memory: ON  →  ~/.claude-r2c-config/projects/<hash>/memory/
# ✅ Lane agents: .claude/agent-memory/ 以下のエントリ
```

### 6.5 Dreaming 統合（Managed Agents 承認後）

> 現時点では未定（承認待ち）。承認後に以下を本 Section に追記する。

- [ ] Managed Agents Dreaming の R2C 統合 API 仕様確認
- [ ] `r2c-morning-report.sh` への dream サマリ出力統合
- [ ] `docs/MANAGED_AGENTS_APPLICATION.md §承認結果` に仕様リンク追記

---

## References

### 公式ドキュメント（確認済み）

- [How Claude remembers your project - Claude Code Docs](https://code.claude.com/docs/en/memory)
- [Create custom subagents - Claude Code Docs](https://code.claude.com/docs/en/sub-agents) — `memory: user|project|local` フィールド仕様
- [Using Claude's chat search and memory - Anthropic Help Center](https://support.anthropic.com/en/articles/11817273-using-claude-s-chat-search-and-memory-to-build-on-previous-context) — claude.ai Session Memory

### R2C 関連正本

- `docs/MANAGED_AGENTS_APPLICATION.md` — Dreaming ウェイトリスト状況（SENT: 2026-05-18）
- `docs/MEMORY_TOOL_EVALUATION.md` — Claude Memory Tool API 評価（Phase70+ 候補）
- `.wolf/hooks/HOOK_BEHAVIOR.md` — worktree での `.wolf/` 書き込み no-op 仕様
- `docs/PHASE1_PARALLEL_WORK_RULES.md` — File Ownership 規約

---

_設計のみ。実装は Asana GID:1214886037602478 で別タスク化済み。_
