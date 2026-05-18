# Phase 1 並列作業ルール

> **期間**: 2026-05-18 〜 2026-05-26（Phase 1 完了まで）
> **目的**: T1〜T4 の並列 worktree 作業でファイル衝突を防ぐ所有権ルールを確定する。

---

## File Ownership（Phase 1 期間中）

| Owner | 編集可能ファイル | 他 worktree からは read-only |
|---|---|---|
| T1 SECURITY_SCAN_ALLOWLIST | `docs/SECURITY_SCAN_ALLOWLIST.md`（新規）| `SECURITY_SCAN_POLICY.md` は読むだけ |
| T2 .wolf/hooks worktree 検知 | `.wolf/hooks/stop.js`, `.wolf/hooks/HOOK_BEHAVIOR.md`（新規）| それ以外の `.wolf/` は触らない |
| T3 lane-templates | `.claude/lane-templates/*.md`（5 ファイル新規）| `.claude/agents/`, `.claude/skills/` は読むだけ |
| T4 retry + Pushover spec | `docs/24H_LOOP_RETRY_AND_NOTIFICATION_SPEC.md`（新規）| 既存仕様 docs は読むだけ |

---

## 全員 read-only（Step C で集約編集）

以下のファイルは T1〜T4 の各 worktree では **一切編集しない**。Step C 集約 PR で 1 回だけ更新する。

- `CLAUDE.md`
- `docs/R2C_DEVELOPMENT_PLAYBOOK.md`
- `docs/SECURITY_SCAN_POLICY.md`
- `docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md`
- `docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md`
- `.gitignore`（Step A で確定済）
- `package.json`, `package-lock.json`, `pnpm-lock.yaml`

---

## Merge 順序（rebase 連鎖回避）

**T1 → T2 → T3 → T4** の順で auto-merge する。

各 PR の merge 後、次の worktree は必ず:

```bash
git fetch origin
git rebase origin/main
```

を実行してから作業を継続する。順序を守らずに merge すると conflict が連鎖する。

---

## Worktree 命名規約

`.claude/worktrees/phase1-t{N}-{shortname}` で統一（`.gitignore` 登録済）:

| Lane | Worktree パス |
|---|---|
| T1 | `.claude/worktrees/phase1-t1-allowlist` |
| T2 | `.claude/worktrees/phase1-t2-wolf-hooks` |
| T3 | `.claude/worktrees/phase1-t3-lane-templates` |
| T4 | `.claude/worktrees/phase1-t4-retry-spec` |

```bash
# worktree 作成例（T1）
git worktree add .claude/worktrees/phase1-t1-allowlist -b feature/phase1-t1-allowlist
```

---

## Step C 集約 PR の役割

T1〜T4 が全て main に merge 完了した後、以下の **共有ドキュメントへの参照リンク追記** を 1 PR で実施する:

| ファイル | 追記内容 |
|---|---|
| `CLAUDE.md` | Phase 1 完了状態セクション追加 |
| `docs/R2C_DEVELOPMENT_PLAYBOOK.md §16` | `docs/24H_LOOP_RETRY_AND_NOTIFICATION_SPEC.md` へのリンク |
| `docs/SECURITY_SCAN_POLICY.md` | `docs/SECURITY_SCAN_ALLOWLIST.md` へのリンク |
| `docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md §9` | Phase 1 進捗追記 |

Step C の PR 作成は **T4 merge 確認後**に着手する。

---

## 衝突回避チェックリスト

各 Lane 着手前に確認:

- [ ] 自分の `File Ownership` 欄以外のファイルは編集しない
- [ ] `全員 read-only` リストのファイルは変更しない
- [ ] worktree 作成後に `git rebase origin/main` を実行した
- [ ] merge 前に前タスク（T{N-1}）の PR が main に入っていることを確認した
