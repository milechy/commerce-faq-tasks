# Agent Teams 4th Teammate Bash 権限取得失敗バグ調査

> 作成: 2026-05-31
> 対象事案: 2026-05-18 Step E-D 事例 (Asana GID 1214886048341241)
> 状態: 調査完了・回避策実装済み

---

## S1: 2026-05-18 事例記録

### 事案概要

2026-05-18 に Agent Teams (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1) で 4 teammates を並列起動した際、4 つ目の general-purpose agent (Step E-D) が Bash ツール権限を取得できず、実装タスクが進行不能になった。Team Lead が代行実装して収束した。

### 観測された症状

- Step E-A / E-B / E-C は Bash 権限あり・正常稼働
- Step E-D のみ Bash tool への permission request が通らず、ファイル操作・コマンド実行ができない状態で停止
- Team Lead が E-D のタスクを引き受けて代行実装

### ログ保全状況

**ログ未保全。** 当時の lane-*.log ファイルは消失または上書き済み。事案は Asana タスク GID 1214886048341241 の notes と MANAGED_AGENTS_APPLICATION.md (docs/、作成 2026-05-18) の文脈から再構成した。詳細な CLI 出力・エラーメッセージは残存していない。

### 関連環境情報

- Claude Code バージョン (調査時実機): **2.1.158**
- 事案発生推定バージョン: 不明 (2026-05-18 時点の版)
- 並列稼働 Lane 数: 4 (E-A, E-B, E-C, E-D)
- MAX_SLOTS 設定 (当時): 不明。現在は `MAX_SLOTS=3` が r2c-dispatch.sh で適用中

---

## S2: 再現試験の設計

> 実際の Anthropic API spawn テストは実施しない（コスト・制約）。以下は設計のみ。

### テスト目的

「4 つ目の teammate が Bash 権限を得られない」事象を再現し、原因を同定する。

### 環境前提

- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` を設定した Claude Code CLI
- worktree 環境 (git worktree add 済み)
- `bypassPermissions` モードで起動する Tier B Lane を Team Lead として使用

### テストケース設計

| TC | 内容 | 期待結果 |
|---|---|---|
| TC-1 | teammates 1〜3 のみ並列起動 (MAX_SLOTS=3) | 全員 Bash 権限あり・正常 |
| TC-2 | teammates 4 を追加して起動 (MAX_SLOTS=4 に一時変更) | 4 つ目で Bash 権限失敗が再現するか確認 |
| TC-3 | TC-2 で失敗した場合、model を明示 (claude-sonnet-4-6) して再試行 | 権限取得の成否を確認 |
| TC-4 | ulimit -n を 256 (soft) に戻した状態で TC-2 を再実行 | ファイルディスクリプタ上限が影響するか確認 |
| TC-5 | launchd セッション外 (interactive shell) で TC-2 | 環境差異の影響を確認 |

### 観測ポイント

1. `claude agents --json` の出力で 4 つ目の agent が `tools` フィールドに `bash` を含むか確認
2. lane-*.log の先頭バナー `(idle — send a prompt to start)` の有無
3. `~/.claude/daemon-auth-status.json` の state (auth_required でないか)

### 前提制約

- TC 実行前に `launchctl limit maxfiles` と `ulimit -n` を記録
- 並列 tool call は 3 本未満を維持 (issue #39830 による result drop 回避)
- テスト後に MAX_SLOTS を元の 3 に戻す

---

## S3: 原因仮説

### 実機確認値

調査日 2026-05-31 に実機で確認した値:

```
ulimit -n (soft limit): 1048576
launchctl limit maxfiles: maxfiles    256    unlimited
```

**注**: `launchctl limit` の表示は `soft hard` 形式。soft=256, hard=unlimited。
interactive shell での `ulimit -n` が 1048576 を返しているのは、shell 起動時に soft limit が上書きされているため (Homebrew 等が設定)。launchd 経由セッションは soft=256 のままになりうる (Phase70 教訓: interactive shell 成功 ≠ launchd 成功)。

### 仮説 A: Claude Code issue #25037 — teammates が lead の制限 tool access を継承

Claude Code 公式 issue #25037 「Subagents in agent teams inherit the lead's restricted tool access」に対応する可能性が高い。

- Team Lead が plan モードや allowedTools に Bash を列挙していない場合、spawn された teammate は Bash 権限を持たずに起動する
- 1〜3 つ目は早期 spawn でキャッシュ済み権限を引き継いだ可能性がある
- 4 つ目は spawn タイミングがズレてリソース競合や権限引き継ぎの断絶が発生した可能性

**信頼度: 高**。症状 (特定 teammate のみ Bash 不可) と issue の説明が一致する。

### 仮説 B: ファイルディスクリプタ枯渇 (launchd soft=256)

- launchd セッション経由では soft maxfiles=256 が適用される
- 4 並列 Lane × 各セッションが stdio/socket/pipe を複数開く = FD 枯渇
- FD 枯渇時に Bash の subprocess fork が失敗し、tool として利用不可になる
- claude --bg の stdin pipe 方式 (PR #218 対応) も FD を消費する

**信頼度: 中**。launchd soft=256 は既知の問題だが、現在の interactive shell では ulimit=1048576 が上書きされているため、直接の原因かは不確定。

### 仮説 C: Claude Code バージョン起因のリグレッション

- 2.1.158 以前の版で agent spawn 時の権限継承ロジックにバグがあった可能性
- `--prompt-file` 廃止 (PR #218 で対応) のように、silent な API 変更が絡んでいる可能性

**信頼度: 低〜中**。バージョン追跡ログが残存していないため推測の域を出ない。

### 最有力仮説

**仮説 A (issue #25037) が主因、仮説 B が増悪因子**。Team Lead の `--permission-mode bypassPermissions` が teammates に正しく伝播しないバグ + リソース競合が重なって 4 つ目のみ失敗した。

---

## S4: 回避策4案と推奨

### Option A: 並列数を 3 以下に抑制 (sequential fallback)

**r2c-dispatch.sh の MAX_SLOTS=3 で実質達成済み。**

R2C は 2026-05-28 の Phase70 完了時点で `MAX_SLOTS=3` を採用しており、この問題の直接的な誘発条件 (4 並列以上) をシステムレベルで遮断している。UATa 3 日運用 (154 件の result drop) から導出された上限であり、issue #25037 の回避としても機能している。

- 追加コスト: ゼロ (実施済み)
- リスク: 3 本同時でも稀に発生しうるが、154 件 → ほぼ 0 件に減少
- 推奨度: **実施済み・継続維持**

### Option B: tmux 独立セッションで各 Lane を分離

各 Lane を `tmux new-session -d -s lane-N` で独立した terminal session として起動することで、FD・環境変数の親プロセス汚染を防ぐ。

- 実装コスト: 中。dispatch.sh の `nohup bash -c` を `tmux new-session` に置換が必要
- 副作用: tmux が未インストール環境や headless 環境での動作保証が必要
- Phase70 で採用した `python3 -c 'os.setsid(); execvp(...)'` (PR #221) が類似効果を提供済み
- 推奨度: **低 (PR #221 で代替済み)**

### Option C: model を明示 + launchd maxfiles チューニング

`--model claude-sonnet-4-6` を dispatch 時に明示 (現在も実施済み) し、launchd の soft maxfiles を 65536 以上に引き上げる。

チューニング手順:
```bash
# /Library/LaunchDaemons/limit.maxfiles.plist を作成 (hkobayashi 手動)
# soft=65536, hard=524288 推奨値
# launchctl load /Library/LaunchDaemons/limit.maxfiles.plist
```

- 実装コスト: 低。plist 作成は hkobayashi 手動 (launchctl 操作は CLI 禁止域)
- 効果: 仮説 B への対処として有効。interactive shell と launchd セッション間の soft limit 差異を解消
- 推奨度: **中 (補完的に実施を推奨)**

### Option D: Anthropic 報告

issue #25037 に対して R2C の実測事例 (2026-05-18、4 つ目の teammate のみ Bash 不可) を追記/新規報告。

- コスト: 低
- 効果: 根本修正がリリースされれば Option A の並列制限を緩和できる
- 推奨度: **中 (将来の並列数拡張のために実施推奨)**

### 推奨まとめ

| 優先度 | Option | 状態 |
|---|---|---|
| 1 (最優先) | A: MAX_SLOTS=3 継続 | **実施済み** |
| 2 | C: launchd maxfiles チューニング | hkobayashi 手動で実施推奨 |
| 3 | D: Anthropic issue #25037 へ事例報告 | 将来対応 |
| 4 | B: tmux 分離 | PR #221 で代替済み・不要 |

---

## S5: dispatch.sh への spawn 失敗検出 + retry 仕様

### 現状の問題

r2c-dispatch.sh の `dispatch_one()` は `nohup bash -c "... claude --bg ..." &` の成功/失敗をプロセス起動レベルでしか検出できない。`claude --bg` が起動しても idle バナー (`(idle — send a prompt to start)`) のまま止まる場合や、内部で agent spawn が失敗しても dispatch.sh はエラーを検知できず、タスクを `running` 状態のまま放置する。

### 設計仕様

#### spawn 失敗の定義

dispatch 後 60 秒以内に lane-N.log が下記のいずれかの状態であれば「spawn 失敗」とみなす:

- ファイルが 0 バイト (claude が全く起動していない)
- `(idle — send a prompt to start)` バナーのみ存在 (prompt 未受信)
- `auth_required` / `auth failed` を含む (OAuth 凍結)

#### retry 仕様

- 1 回目の spawn 失敗: 30 秒待機後に再 dispatch (最大 3 回)
- 3 回連続失敗: Slack 通知 + タスクを `failed` に遷移して次のタスクへ
- 4 本目 (MAX_SLOTS を超える spawn 試行): 発生しないが安全網として「3 並列 degraded 継続」を明示

#### 実装方針

`dispatch_one()` の末尾に非同期の spawn checker を起動する。checker は:

1. 60 秒 sleep 後に log_file の状態を確認
2. 失敗判定ならリトライ上限チェック → Slack 通知 or 再 dispatch
3. 全体の MAX_SLOTS を超えないよう DB の running 件数を再確認してから retry

詳細実装は `SCRIPTS/r2c-dispatch.sh` の spawn_check_and_retry 関数として追加済み (S5 実装 PR 参照)。

---

## 参考リンク

- Claude Code 公式 issue #25037: teammates inherit lead's restricted tool access
- Claude Code 公式 issue #39830: result drop when 3+ concurrent tool calls
- Phase70 6 罠解明: `docs/postmortem/2026-05-28-oauth-fail/MEMORY_27.md`
- dispatch.sh: `SCRIPTS/r2c-dispatch.sh`
- 24h ループ安定性ガード: `CLAUDE.md` §「24h ループ安定性ガード」
