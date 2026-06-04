---
name: r2c-24h-loop-spawn-pipeline-2026-05-28
description: 24hループの Lane spawn 経路に潜む罠 6 層 (OAuth daemon凍結 / --prompt-file廃止 / dispatch.sh export PATH / 短prompt正常exit解釈 / cron-wrapper env汚染 / launchd session/process group attribute) — PR #197/217/218/219/220/221 で全解消 (e2e #6 task 47 で launchd実起動経由40秒自走成功実証)
metadata:
  type: feedback
---

24h ループの Lane spawn 経路には 6 つの罠が直列に潜む。再発時は次の優先順で切り分けること。

## 最大教訓: **launchd 実起動経由で検証しないと罠を見逃す**

interactive shell 経由で動いても、launchd cron 実起動経由では動かないケースがある (罠5/6)。
PR 前のゲートとして「launchd cron 1分毎の自然拾いを 120 秒待ち、result file 生成を確認する」
を必須にすること。

**裏切られた検証パターン** (本日 2026-05-28 で実体験):
- 罠5 PR #220 (env -i): interactive shell から呼ぶと動く、しかし launchd 実起動でなお spawn 失敗 → 罠6 発見
- 罠6 PR #221 (setsid): PR 前ゲートで launchd 実起動経由 e2e (task 46) 30秒成功を実測してから PR 作成 → e2e #6 (task 47) で本番 main でも 40秒成功を再確認

## 罠 1: OAuth daemon 凍結 (解消 PR #197 警告経路)

**症状**: 全 Lane が突然 spawn 後 0byte log で消える。launchd/dispatch/supervisor は exit=0 で動き続ける。

**確認**:
```bash
cat ~/.claude/daemon-auth-status.json    # 存在 + status=auth_required なら確定
ls ~/.claude/daemon-auth-cooldown        # 存在も同根
tail ~/.claude/daemon.log | grep auth   # "headless daemon cannot complete OAuth"
```

**復旧手順**:
1. hkobayashi 手動で `claude /login` 実行 (headless 不可)
2. 完走しても daemon 側で auth-status.json が更新されない場合は **daemon 強制再起動**:
   ```bash
   # 別ターミナルで実行 (本セッション巻き添えリスクあり)
   pkill -f "claude.exe daemon"
   pkill -f "claude.exe --bg-spare"
   ```
3. `~/.claude/daemon-auth-status.json` ファイル消失で復旧完了 (valid 状態のシグナル)

**daemon-auth-status.json の仕様** (重要):
- `auth_required` 時のみ書かれるエラーフラグ。**通常状態では存在しない (削除される)**
- 内容: `{"status":"auth_required","since":<epoch_ms>}`
- 復旧後のファイル消失が valid 状態のシグナル

**Why**: daemon は OAuth proactive refresh 失敗で `auth_required` 凍結し、keychain polling を 30 秒毎に続けるが復旧不能。launchd 由来 cron-wrapper は env が独立で keychain にアクセスできない。

## 罠 2: `--prompt-file` フラグは存在しない (解消 PR #218)

**症状**: `claude --bg --prompt-file <path>` で spawn すると backgrounded バナーが出るが `(idle — send a prompt to start)` 状態で待機。45min stuck → rollback。

**確認**:
```bash
claude --help | grep -E "prompt-file|^Usage"
# Usage: claude [options] [command] [prompt]   ← positional only
```

**Why**: claude-code v2.1.152 で `--prompt-file` が silently 削除、unknown flag として無視。

**正しい渡し方** (PR #218):
```bash
cat '${prompt_path}' | claude --bg --name '...' --model '...' --permission-mode '...'
```

## 罠 3: `dispatch.sh` の `export PATH=` が stdin pipe を壊す (解消 PR #219)

**症状**: dispatch.sh の `nohup bash -c "...export PATH=...; cat | claude --bg..."` で cat の stdout が claude --bg に届かず idle 起動。

**Why**: 詳細メカニズム未解明。bash -c 内に `export PATH=...` を書くと後続の pipe の stdin が claude に届かない macOS 固有現象。冗長性は明確: cron-wrapper.sh:24 で既に PATH 設定済。

**How to apply**: dispatch.sh の bash -c 内に `export PATH=` を書かない。PATH は呼び出し元で設定済。

## 罠 4: lane-*.log の 0byte/223byte は「即死」ではなく「短 prompt の正常 exit」 (解釈)

**症状の解釈**: 0byte/223byte log だけで即死判定するのは早計。バナー `(idle — send a prompt to start)` の有無で判別:
- バナーあり → prompt 未到達 (罠 2/3/5/6 系)
- バナーなし、result file 生成 → 正常 exit
- agents --json で `status=busy` → 実行中
- agents --json で `status=idle` で result 未生成 → prompt 未到達

## 罠 5: `cron-wrapper.sh` の親 env 継承が stdin pipe を壊す (解消 PR #220)

**症状**: dispatch.sh 側で罠3 修正後も cron-wrapper.sh 経由起動で idle。

**Why**: cron-wrapper の親 env (interactive shell の TMUX/ITERM_*/BASH_*/SHELLOPTS や launchd の XPC_SERVICE_NAME 等) が継承されると同種の現象が cron-wrapper レイヤで再発。

**修正** (PR #220):
```bash
env -i \
    HOME="${HOME}" PATH="${PATH}" \
    R2C_ROOT="${R2C_ROOT}" R2C_CONFIG="${R2C_CONFIG}" \
    CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-${R2C_CONFIG}}" \
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS="${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-1}" \
    bash "SCRIPTS/${SCRIPT}" "${PASS_THROUGH[@]}" >> "${TARGET_LOG}" 2>&1
```

**注意**: env -i だけでは罠6 (launchd 実起動経由) で不十分。罠6 と組合せて初めて完成。

## 罠 6: launchd session/process group attribute 起因 (解消 PR #221)

**症状**: PR #220 (env -i) 適用後、interactive 経由は完全動作、しかし launchd 実起動経由のみ依然 0byte log / sid NULL。

**Why**: launchd domain で起動された cron-wrapper.sh の子プロセスツリーは launchd の session / process group attribute を継承。これが claude --bg の bg-spare daemon socket 接続を阻害。env では制御不能。

**修正** (PR #221):
```bash
SETSID_EXEC='import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])'
env -i ... \
    /usr/bin/python3 -c "${SETSID_EXEC}" \
        bash "SCRIPTS/${SCRIPT}" ... >> "${TARGET_LOG}" 2>&1
```

`setsid(2)` で新 session leader を作って launchd session attribute を断ち切る。
**macOS には `setsid(1)` コマンドが無い**ため `/usr/bin/python3` (macOS 標準) で `setsid(2)` を呼ぶ。

**実証**: e2e trap6-launchd task 46 (一時パッチ実機適用) で launchd 自然拾い 30秒成功。
PR merge 後 e2e #6 task 47 で本番 main の launchd 自然拾い 40秒成功を再確認。

## PR/コミット参照
- PR #197 ✅ merged: auth fail-fast 化 (罠1 警告経路)
- PR #217 ✅ merged: r2c-lane-session-resolver.sh (罠4 安全装置 + session_id 自動発見)
- PR #218 ✅ merged: --prompt-file → stdin pipe (罠2)
- PR #219 ✅ merged: dispatch.sh の export PATH 撤廃 (罠3)
- PR #220 ✅ merged: cron-wrapper の env -i 化 (罠5)
- PR #221 ✅ merged: cron-wrapper の setsid(2) Python wrap (罠6)
- ポストモーテム: `docs/postmortem/2026-05-28-oauth-fail/`

## 24h ループ完全自走確定 (2026-05-28 e2e #6)
- task 47 launchd 自然拾い、手動 dispatch 一切なし
- 30秒: state=running、auto/b-47 worktree+branch 作成
- 40秒: session_id=170dfc68... 取得 + lane-47.log.sid resolver 動作 + /tmp/r2c-e2e6-result.md "E2E6_OK" 生成

## 3 日試運転で観測すべきリスク (memory#27 残存事項)
- 並列実行 (MAX_SLOTS=3): bg-spare pool 競合
- 長時間 prompt (30分〜): OAuth refresh 跨ぎの安定性
- OAuth fail 再発時の検出と復旧自動化 (現状 hkobayashi 手動)
- claude-code バージョン更新時の breaking change 再発 (MONITOR 軸 B で検出設計)

## 関連メモリ
- [[r2c-24h-loop-architecture]]
- [[claude-bg-spawn-troubleshooting]]
- [[oauth-daemon-recovery-procedure]]
- [[dispatch-sh-architecture]]
- [[launchd-session-attribute]]
