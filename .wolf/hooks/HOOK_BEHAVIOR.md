# .wolf/hooks Behavior Specification

## stop.js — Worktree Detection (Option B採用)

### 目的
24h ループで複数 worktree が並列実行されると、各 worktree の stop.js が同一 `.wolf/hooks/_session.json` / `.wolf/token-ledger.json` を書き換える race condition が発生し EPERM/EEXIST エラーを散発させる。

### 採用方針
docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md §3 Option B:
worktree (`git rev-parse --git-dir` が `.git/worktrees/...` を返す環境) では stop.js 冒頭で `process.exit(0)` し、`.wolf/*` への書き込みを行わない。

### 影響
- **ベースリポ** (`~/Documents/GitHub/commerce-faq-tasks/`): 通常動作 (token-ledger / session / cerebrum.md 更新)
- **worktree** (`.claude/worktrees/...`): no-op (`.wolf/*` 書き込みなし)
- **学習史**: ベース Lane でのみ更新されるため Cerebrum 等の履歴がクリーン
- **トレードオフ**: worktree 内のトークン消費は記録されない (claude agents ダッシュボード側で代替計測)

### 動作確認手順
1. ベース: `node .wolf/hooks/stop.js` → 正常完了 (exit 0、token-ledger 更新)
2. worktree: `cd .claude/worktrees/<lane>/ && node .wolf/hooks/stop.js` → 即時 exit 0 (no-op、token-ledger 変更なし)

### 実装確認ログ (Phase 1 T2)
- worktree (`phase1-t2-wolf-hooks`) で `git rev-parse --git-dir` →
  `/Users/hkobayashi/Documents/GitHub/commerce-faq-tasks/.git/worktrees/phase1-t2-wolf-hooks`
  (`.git/worktrees/` を含む → 検知ロジック発火 → exit 0 で no-op)
- ベースリポでは `git rev-parse --git-dir` → `.git` (検知ロジック非該当 → 通常 main() フロー継続)

### 関連
- docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md §3 (採用判断)
- docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md §19 (worktree 戦略)
