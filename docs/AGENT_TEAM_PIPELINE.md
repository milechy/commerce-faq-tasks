# Agent Team Pipeline（Planner → Generator → Evaluator → Tester）

R2C の Asana タスクを 4 エージェント協調で自走処理する設計。`/goal` の Ralph-style loop または
24h ループ（`r2c-dispatch.sh`）のどちらからでも駆動できる。

## 全体フロー

```
Asana R2C (project=1213607637045514)
  │ 直 REST で未完了タスク取得（bg session は MCP 不達のため curl 固定）
  │ 優先度順: [P0]ラベル > due_on 昇順 > Stream セクション
  ▼
┌─ 1タスク = 1サイクル ──────────────────────────────────────┐
│ Planner   (read-only)  実機照合 → 計画 + Risk 判定          │
│   │ HUMAN-APPROVAL-REQUIRED → Slack 通知してスキップ、次へ   │
│   ▼ SAFE                                                    │
│ Generator (read-write) feature branch 上で計画通り実装       │
│   │ コンフリクト → stash/rebase、解決不能なら rescue/ branch │
│   ▼                                                         │
│ Evaluator (read-only)  diff レビュー + anti-slop + 機械check │
│   │ NO-GO → Generator 差し戻し（3回で HUMAN-REVIEW）         │
│   ▼ GO                                                      │
│ Tester    (read-write) 不足テスト作成 + Gate 1〜3 + 実打鍵   │
│   │ FAIL → Generator 差し戻し                                │
│   ▼ PR-READY                                                │
│ PR 作成 → gh pr merge --auto --squash --delete-branch       │
└──────────────────────────────────────────────────────────┘
  │ 完了 → Asana コメント追記 → 次タスクへ自動遷移
  ▼
次タスク（ループ継続）
```

## 呼び出し方法

メインセッション（Team Lead）が Agent tool で順次 spawn する:

| 段階 | subagent_type | isolation |
|---|---|---|
| Planner | `Planner`（不可なら `Plan` / `Explore` に Planner.md の指示文を付与） | なし |
| Generator | `Generator`（不可なら `general-purpose`） | `worktree`（並列時） |
| Evaluator | `Evaluator`（不可なら `Explore`） | なし |
| Tester | `Tester`（不可なら `test-writer`） | Generator と同じ worktree |

> 注: セッション開始後に追加した custom agent は同一セッションの Agent tool registry に
> 反映されないことがある（Dynamic Workflows の既知挙動）。その場合は fallback 列の
> 汎用エージェントに各 .md の本文をプロンプトとして渡す。

## worktree 並列実行

- 同時稼働は **最大 3 タスク**（`r2c-dispatch.sh` の `MAX_SLOTS=3` と同一根拠: result drop 回避）
- 並列時は Generator/Tester を `isolation: worktree` で起動し、branch 衝突を物理的に排除
- fresh worktree は node_modules 空 → コード系 Gate 前に `pnpm install`（**Node 20 必須**、Node 24 は install クラッシュ）
- 依存タスク（例: P1-A/P1-B は P0 merge 前提）は直列化し、先行 PR の merge を deadline ループ（20 分上限）で待つ

## 人間承認が必要な高リスク変更（ここだけ止まる）

1. Tier S（security middleware / auth / 安全装置配線）の本体修正
2. 24h mode ON 中の out-of-scope 11 項目（avatar-agent / 依存メジャー bump / DB migration / .env / main merge / VPS 接続 など）
3. Evaluator 3 回連続 NO-GO / 同系統ミス 3 回（3 回ルール）
4. `bash SCRIPTS/deploy-vps.sh`（本番デプロイは常に人間）

該当時は `bash SCRIPTS/notify-slack.sh "HUMAN-REVIEW-REQUIRED: <理由>" --color warning` を投げ、
タスクをスキップして次の SAFE タスクへ遷移する（ループは止めない）。

## コンフリクト / バグ隔離プロトコル

- rebase 必要時: `git stash push` → `git rebase origin/main` → 成功なら `stash pop`
- 解決不能: `rescue/<branch>-conflict` branch に隔離 → 状態を MEMORY.md に記録 → 次タスクへ
- Gate 失敗が環境起因（OOM / node_modules / Node version）の場合は環境修復を 1 回だけ試行し、再失敗で差し戻し

## 既存 24h ループとの関係

- 本パイプラインは **インタラクティブセッション内の自走**（/goal 駆動）を主用途とする
- launchd 駆動の 24h ループ（r2c-asana-poll → queue → r2c-dispatch → Lane 1-5）とは排他ではなく、
  queue DB が空のとき・人間がセッションを見ているときの高速レーンとして機能する
- 両者同時稼働時も合計同時 Lane 数 3 を超えないこと
