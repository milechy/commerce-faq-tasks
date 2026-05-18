# Phase 1: Claude Code アカウント分離 移行手順書

> **実行者**: hkobayashi が手動実行（CLI は実行しない）
> **実行日時**: 2026-05-19 06:05 JST（朝プロトコル 06:00 の Slack DM 確認直後）
> **所要時間**: 最大 5 分（タイムボックス厳守）
> **タイムアウト**: 06:10 までに完了しなければ中断 → ロールバック
>
> **対応 Asana**: GID `1214891864857305`（[Tier S] prod_change）
> **根拠ドキュメント**:
> - `docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md` §15
> - `docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md` §8

---

## 目的

24h ループで起動する Lane (claude agents) の設定・secrets・Cerebrum (.wolf/cerebrum.md) が、
他プロジェクト（UATa / DIA1000 等）の `~/.claude/` default 設定と混線しないようにする。

```
移行前:
  claude         → ~/.claude/          (R2C / DIA / UATa が混在)

移行後:
  claude-r2c     → ~/.claude-r2c-config/   (R2C 専用)
  claude         → ~/.claude/              (既存のまま残す、削除しない)
```

---

## 前夜準備（5/18 夜、実行前日）

- [ ] **全 Claude Code セッションを終了する**
  - ターミナルで起動中の `claude` / `claude-r2c` プロセスがないことを確認
  - `claude agents` ダッシュボードが起動していないことを確認
  - `pgrep -l claude` で残存プロセスがないことを確認（残っていれば `killall claude.exe`）
- [ ] **この手順書を通し読みしてから就寝する**
- [ ] **翌朝 06:05 にターミナルを 1 ウィンドウだけ開く**（複数ウィンドウ禁止）

---

## 06:05 実行ブロック（タイムボックス: 5 分）

> ⚠️ **手順を一切省略しない。コマンドをコピーして実行すること。**
> ⚠️ **エラーが出たら即停止 → §ロールバック へ。**

### Step 1: 実行前チェック（30 秒）

```bash
# Claude Code セッションが存在しないことを確認
pgrep -l "claude" && echo "⚠️ claude プロセスが残っています → killall claude.exe してから再開" || echo "✅ クリア"

# 現在の config dir を確認（空 = ~/.claude/ がデフォルト）
echo "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-<未設定、~/.claude/ を使用>}"

# ~/.claude/ が存在することを確認
ls -la ~/.claude/ | head -5 && echo "✅ ~/.claude/ 存在確認"

# ~/.claude-r2c-config/ が存在しないことを確認（上書き事故防止）
[ -d ~/.claude-r2c-config ] && echo "⚠️ ~/.claude-r2c-config/ が既に存在します → 手順書 §補足 を確認" || echo "✅ 未存在、コピー可"
```

### Step 2: バックアップ作成（30 秒）

```bash
# 念のため ~/.claude/ 自体のバックアップを作成（後で消して良い）
cp -a ~/.claude ~/.claude-backup-$(date +%Y%m%d_%H%M%S)
echo "✅ バックアップ作成: ~/.claude-backup-$(date +%Y%m%d)"
```

### Step 3: R2C 専用 config-dir 作成（1 分）

```bash
# ~/.claude/ を R2C 専用にコピー（mv ではなく cp で元を保護）
cp -a ~/.claude ~/.claude-r2c-config
echo "✅ コピー完了"

# パーミッション確定
chmod 700 ~/.claude-r2c-config
echo "✅ mode 700 設定"

# secrets ディレクトリ作成（将来の API キー等を格納）
mkdir -p ~/.claude-r2c-config/secrets
chmod 700 ~/.claude-r2c-config/secrets
echo "✅ secrets/ 作成 (mode 700)"
```

### Step 4: alias 永続化（1 分）

```bash
# alias が既に .zshrc にないことを確認
grep -q "claude-r2c" ~/.zshrc && echo "⚠️ 既に alias が存在します → 追記をスキップ" || {
  echo '' >> ~/.zshrc
  echo '# R2C Claude Code (分離 config)' >> ~/.zshrc
  echo 'alias claude-r2c="CLAUDE_CONFIG_DIR=~/.claude-r2c-config claude"' >> ~/.zshrc
  echo "✅ alias を .zshrc に追記しました"
}

# 反映
source ~/.zshrc
echo "✅ source ~/.zshrc 完了"
```

### Step 5: 起動確認（1 分）

```bash
# alias が読めることを確認
type claude-r2c && echo "✅ alias 有効"

# バージョン確認（--print モードで即終了）
CLAUDE_CONFIG_DIR=~/.claude-r2c-config claude --version && echo "✅ claude-r2c 起動確認"
```

### Step 6: 検証スクリプト実行（1 分）

```bash
# 検証スクリプトを実行して独立性を確認
bash scripts/verify-account-isolation.sh
# → 全項目 PASS であることを確認
```

### ✅ 完了チェックリスト

- [ ] `~/.claude-r2c-config/` が存在し mode `700`
- [ ] `~/.claude-r2c-config/secrets/` が存在し mode `700`
- [ ] `~/.zshrc` に `alias claude-r2c="CLAUDE_CONFIG_DIR=~/.claude-r2c-config claude"` がある
- [ ] `source ~/.zshrc` 後に `type claude-r2c` が `alias` と出力される
- [ ] `claude --version` が動く（既存 `~/.claude/` は壊れていない）
- [ ] `bash scripts/verify-account-isolation.sh` が全項目 PASS
- [ ] `~/.claude/` が削除されていない（元のまま残っている）

全チェックが通ったら **06:10 朝プロトコル通常業務へ**。

---

## ロールバック手順（何かあった時）

> エラーが出たら即停止し、以下を上から順に実行する。

```bash
# 1. ~/.claude-r2c-config/ を削除（不完全なコピーを除去）
rm -rf ~/.claude-r2c-config
echo "✅ ~/.claude-r2c-config 削除"

# 2. alias を .zshrc から削除（もし追記済みなら）
grep -n "claude-r2c" ~/.zshrc  # 行番号を確認
# → vim や nano で該当行を手動削除

# 3. バックアップから ~/.claude/ を復元（Step 2 を実行した場合のみ）
# コピーが必要なら:
# cp -a ~/.claude-backup-YYYYMMDD_HHMMSS ~/.claude

# 4. 確認
ls ~/.claude/ | head -5 && echo "✅ ~/.claude/ 正常"
echo "ロールバック完了。翌朝に再挑戦するか Claude.ai に相談すること。"
```

---

## 補足: ~/.claude-r2c-config/ が既に存在する場合

```bash
# 既存の内容を確認
ls -la ~/.claude-r2c-config/ | head -10

# 更新日時が今日より古い場合 → 以前の試行の残り
# rm -rf ~/.claude-r2c-config && echo "削除してから Step 2 に戻る"

# 更新日時が今日の場合 → 既に移行完了している可能性
# bash scripts/verify-account-isolation.sh で確認してから判断
```

---

## 移行後の日常運用

### R2C 作業を始める時

```bash
claude-r2c  # ~/.claude-r2c-config/ を使う
# または
CLAUDE_CONFIG_DIR=~/.claude-r2c-config claude
```

### 既存のその他プロジェクト（DIA 等）

```bash
claude  # ~/.claude/ (デフォルト) を使う（変更なし）
```

### 独立性の確認（いつでも実行可）

```bash
bash scripts/verify-account-isolation.sh
```

---

## 関連ドキュメント

- `docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md` §15 — R2C アカウント設定の正本
- `docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md` §8 — 移行リスク評価
- `scripts/verify-account-isolation.sh` — 独立性検証スクリプト
- `docs/R2C_DEVELOPMENT_PLAYBOOK.md` — 「アカウント分離手順」セクション参照
