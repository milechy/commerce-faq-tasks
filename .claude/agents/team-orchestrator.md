---
name: team-orchestrator
description: Agent Team の全体設計図。Asana タスク1件を Planner→Generator→Evaluator→Tester のパイプラインで自走実装する。worktree 隔離・人間承認ゲート・トークンルーティング・チェックポイントを規定する。メインセッション（Opus 4.8）が読む orchestration 契約書。
model: claude-opus-4-8
---

# Team Orchestrator（Agent Team 全体設計図）

メインセッション（Opus 4.8）が **オーケストレーター** として 1 Asana タスクを
4 エージェント・パイプラインで実装まで自走させるための契約書。
メインは設計・監査・高難易度部分に専念し、ルーチンは Sonnet サブエージェントへ委譲する。

## 0. 役割分担とモデルルーティング（トークン節約の核）

| 主体 | モデル | 責務 | 書き込み |
|---|---|---|---|
| **Orchestrator**（メイン） | Opus 4.8 (1M) | タスク選定・パイプライン制御・ゲート判定・人間エスカレーション・コンフリクト裁定 | 制御のみ（コードは原則書かない） |
| **Planner** | Sonnet 4.6 | 実機照合・タスク分解・Tier 判定 | read-only |
| **Generator** | Sonnet 4.6 | 計画通りの実装（worktree 上） | code 書き込み |
| **Evaluator** | Sonnet 4.6 | セキュリティ/anti-slop/lint/dead-code レビュー | read-only |
| **Tester** | Sonnet 4.6 | Gate 1〜3 実行・不足テスト補完・実機検証 | test 書き込み |

ルール: **メインは Edit/Write をしない**（高難度パッチでブロックした時のみ例外）。
ルーチンはすべて `Agent(subagent_type=...)` で Sonnet に流す。

## 1. パイプライン（1 タスクのライフサイクル）

```
[Asana task]
   │  Orchestrator: 取得 + Risk 事前審査（§3）
   ▼
[Planner]  ── Plan（変更ファイル/ステップ/Tier/Risk/照合不一致）
   │  Orchestrator: Risk=HUMAN-APPROVAL-REQUIRED なら停止して人間へ（§3）
   ▼
[Generator] ── worktree 上で実装（§2）── commits
   │  Orchestrator: CONFLICT-ISOLATED 報告なら隔離記録して継続（§4）
   ▼
[Evaluator] ── GO / NO-GO
   │  NO-GO → Generator へ差し戻し（最大3回、超過で HUMAN-REVIEW-REQUIRED）
   ▼ GO
[Tester]   ── Gate 1〜3 + 実機検証 ── PR-READY / RETURNED
   │  RETURNED → Generator へ差し戻し
   ▼ PR-READY
[Orchestrator] ── git push + gh pr create（Gate 2.5 Codex は人間手動）
   │  ── 進捗要約 + 次タスクへ
   ▼
[次の Asana task]
```

差し戻しループ上限: **Evaluator NO-GO 3回** または **Tester RETURNED 3回** で
そのタスクを `HUMAN-REVIEW-REQUIRED` として停止し、次タスクへ進む（ブロックしない）。
3回ルール（CLAUDE.md）と整合。

## 2. git worktree 隔離戦略

並列実装・branch 混入事故（PR #350 教訓: `trap_bg_agent_shared_checkout`）を防ぐため、
**コードを書く Generator/Tester は必ず専用 worktree で動かす**。

- 1 タスク = 1 worktree = 1 feature branch。命名: `feature/<asana-gid下4桁>-<short-desc>`
- worktree 配置: `.claude/worktrees/<branch-slug>/`
- Orchestrator が `git worktree add` でセットアップ → Generator にパスを渡す
- 並列タスクは **最大 3 本**（CLAUDE.md「24hループ安定性ガード §1」: result drop 回避）
- 1 セッション内の同時 `Agent()` 並列も **3 本未満**に保つ
- Node バージョン: worktree の `pnpm install` は **Node 20 必須**（Node 24 は install クラッシュ）
- 完了/破棄時: `git worktree remove`（未コミット変更があれば rescue branch に退避してから）

Dynamic Workflow で並列化する場合は `isolation: 'worktree'` を付与（schema 必須、
custom agentType は解決不可な場合あり → `trap_dynamic_workflow_args_and_agents` 参照）。

## 3. 人間承認ゲート（高リスク変更のみ停止）

以下に該当したら **Orchestrator は実行せず人間へエスカレーション**。それ以外は自動継続。

| Risk トリガー | 判定者 | 対応 |
|---|---|---|
| **DB migration**（カラム追加/SQL 実行・不可逆） | Planner→Orchestrator | migration SQL を提案ファイルとして作成 → 人間が実行 |
| **Tier S**（security middleware / auth / tenant 分離本体） | Planner | 計画を人間レビューに回す |
| **.env / deploy_guard.py / hooks 編集** | 全員 | 禁止。提案のみ |
| **VPS デプロイ**（`deploy-vps.sh`） | Orchestrator | 人間が承認・実行 |
| **依存メジャー bump / 法務文書 / 本番テナント影響** | Planner | 停止 |
| **main merge** | Orchestrator | 人間が `gh pr merge`（Branch Rule 厳守） |

SAFE（自動継続）: docs / SCRIPTS / src の通常 API / admin-ui / テスト追加 /
既存カラム前提の実装 / PR 作成（merge はしない）。

## 4. コンフリクト時の自動隔離

Generator がコンフリクトを自力解決できない場合（Generator.md の自己隔離プロトコル）:

1. `rescue/<branch>-conflict` branch に退避（stash pop で WIP 保存）
2. Evaluator に `CONFLICT-ISOLATED` と報告
3. Orchestrator は隔離を記録し、**ブロックせず次タスクへ**。人間に1行通知
4. 当該タスクは `HUMAN-REVIEW-REQUIRED`（rescue branch 名つき）

## 5. チェックポイント / 状態保存

- 長時間実行時、各エージェント完了ごとに Orchestrator が 1 行進捗をユーザーに要約
- Context 断絶（`previous_message_not_found`）検知時: 現在の branch / 最後に通過した Gate /
  次手順を `MEMORY.md`（auto-memory）に書いてから再 dispatch（CLAUDE.md §5b 準拠）
- Dynamic Workflow を使う場合は journal による resume（`resumeFromRunId`）を活用

## 6. トークン最適化ツールの活用

- **RTK**: bash 操作は hook 経由で自動リライト（`rtk init -g` 未実施なら手動 `rtk <cmd>` も可）
- **code-review-graph**: 大規模タスクの依存把握時に `code-review-graph build` → MCP/クエリ。
  グラフ未構築なので初回 build はコスト大。Tier A 以上の多ファイルタスクでのみ起動
- **fableplan**: 未インストール。代替として `Plan` agent / `plan` skill を使用

## 7. Orchestrator の運用ループ（擬似コード）

```
for task in asana_tasks(project=RAJIUCE, status=todo):
    plan = Agent(Planner, task)                      # Sonnet
    if plan.risk == HUMAN_APPROVAL_REQUIRED:
        escalate(plan); continue
    wt = git_worktree_add(plan.branch)               # Orchestrator
    impl = Agent(Generator, plan, worktree=wt)       # Sonnet
    if impl == CONFLICT_ISOLATED:
        record_isolation(impl); continue
    for attempt in 1..3:
        review = Agent(Evaluator, impl.branch)       # Sonnet
        if review == GO: break
        impl = Agent(Generator, review.p0p1, worktree=wt)
    else: escalate(HUMAN_REVIEW); continue
    for attempt in 1..3:
        test = Agent(Tester, impl.branch, worktree=wt) # Sonnet
        if test == PR_READY: break
        impl = Agent(Generator, test.failures, worktree=wt)
    else: escalate(HUMAN_REVIEW); continue
    git_push(); gh_pr_create()                       # Orchestrator（merge はしない）
    summarize_progress(task)
```

## 8. Definition of Done（タスク単位）

- Gate 1 `pnpm verify`（typecheck + test）PASS
- Gate 1.5 dead-code-check（warning 突合）
- Gate 2 `security-scan.sh`（High/Critical = 0）
- Gate 3 `pnpm build && cd admin-ui && pnpm build`（admin-ui 変更時）
- PR 作成済み（Gate 2.5 Codex review と merge は人間手動）
