# 24H Loop — Secrets テンプレート

> **対応 Asana**: GID `1214888719608975`（[Tier B] docs: 24hループ secrets 配備手順）
> **作成**: 2026-05-18
> **対象**: `SCRIPTS/r2c-*.sh` 全 16 本が参照する `~/.claude-r2c-config/secrets/r2c-loop.env`

---

## 概要

`SCRIPTS/r2c-*.sh` は起動時に `~/.claude-r2c-config/secrets/r2c-loop.env` を
`source` して secrets を環境変数として読み込む。
このファイルは **git に含めない**（`.gitignore` 登録済み）。
実際のファイルは **2026-05-19 06:05 の Tier S アカウント分離完了後に hkobayashi が手動作成**する。

---

## テンプレート

以下の内容を `~/.claude-r2c-config/secrets/r2c-loop.env` として保存する。
**実値は各変数の説明を参照して記入すること。`xxx` のままでは動作しない。**

```bash
# ============================================================
# R2C 24h Loop — Secrets File
# Location: ~/.claude-r2c-config/secrets/r2c-loop.env
# Mode: 600 (chmod 600 により owner read-only)
# DO NOT COMMIT THIS FILE TO GIT
# ============================================================

# --- Asana ---
# 取得元: https://app.asana.com/0/my-apps → "Personal access token"
# 既存の .env.local の ASANA_ACCESS_TOKEN をコピー
export ASANA_ACCESS_TOKEN=xxx-your-asana-pat-here

# --- Pushover ---
# 取得元: docs/PUSHOVER_SETUP_GUIDE.md を参照
export PUSHOVER_TOKEN=xxx-your-app-token-here   # Application Token (30 chars)
export PUSHOVER_USER=xxx-your-user-key-here     # User Key (30 chars)
# export PUSHOVER_DEVICE=iphone                  # (オプション) デバイス名限定

# --- Slack ---
# 取得元: Slack App 管理 → "Incoming Webhooks" または "Bot Tokens"
# SLACK_WEBHOOK_URL を優先。なければ SLACK_BOT_TOKEN にフォールバック
export SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/xxx/xxx
# export SLACK_BOT_TOKEN=xoxb-xxx-your-bot-token  # (代替、Webhook 不可時のみ)

# --- Slack チャンネル ---
# r2c-slack-notify.sh が --channel 未指定時のデフォルト
export SLACK_CHANNEL_ID=C0AG07HFJTB

# --- R2C プロジェクト設定 ---
export R2C_REPO_PATH=/Users/hkobayashi/projects/commerce-faq-tasks
export R2C_ASANA_PROJECT_GID=1213607637045514
```

---

## 作成手順（hkobayashi 手動、Tier S 完了後）

```bash
# 1. ディレクトリ作成（既に存在する場合はスキップ）
mkdir -p ~/.claude-r2c-config/secrets

# 2. テンプレートをコピーして編集
cp docs/24H_LOOP_SECRETS_TEMPLATE.md /tmp/secrets-template.md
# エディタで実値を記入
nano ~/.claude-r2c-config/secrets/r2c-loop.env

# 3. パーミッション設定（必須）
chmod 600 ~/.claude-r2c-config/secrets/r2c-loop.env

# 4. 確認
ls -la ~/.claude-r2c-config/secrets/r2c-loop.env
# 期待出力: -rw------- 1 hkobayashi staff ...
```

---

## スクリプトからの読み込みパターン

`SCRIPTS/r2c-*.sh` は以下のパターンで読み込む（既実装済み）:

```bash
R2C_CONFIG="${CLAUDE_CONFIG_DIR:-${HOME}/.claude-r2c-config}"
SECRETS_FILE="${R2C_CONFIG}/secrets/r2c-loop.env"

if [[ -f "${SECRETS_FILE}" ]]; then
    # shellcheck source=/dev/null
    source "${SECRETS_FILE}"
else
    echo "WARNING: ${SECRETS_FILE} not found. Using environment variables." >&2
fi
```

---

## Smoke Test（Tier S 完了後 30 分以内に実施）

```bash
# secrets 読み込み確認
source ~/.claude-r2c-config/secrets/r2c-loop.env
echo "ASANA: ${ASANA_ACCESS_TOKEN:0:10}..."
echo "PUSHOVER_TOKEN: ${PUSHOVER_TOKEN:0:6}..."
echo "PUSHOVER_USER: ${PUSHOVER_USER:0:6}..."
echo "SLACK_WEBHOOK_URL: ${SLACK_WEBHOOK_URL:0:30}..."

# Pushover 疎通確認（dry-run）
bash SCRIPTS/r2c-pushover.sh --dry-run --priority 0 \
    --title "R2C Smoke Test" \
    --message "Secrets configured successfully"

# Asana 疎通確認
bash SCRIPTS/r2c-asana-poll.sh --dry-run

# Slack 疎通確認
bash SCRIPTS/r2c-slack-notify.sh --dry-run \
    --message "R2C smoke test: OK"

# Health check
bash SCRIPTS/r2c-health-check.sh
```

---

## Secrets ローテーション手順

| 変数 | ローテーション間隔 | 手順 |
|---|---|---|
| `ASANA_ACCESS_TOKEN` | 90 日ごと | app.asana.com → My Apps → revoke + 再発行 |
| `PUSHOVER_TOKEN` | 1 年ごと（または漏洩時） | pushover.net → App 管理 → Regenerate Token |
| `PUSHOVER_USER` | ローテーション不要（アカウント紐づき） | アカウント削除時のみ変更 |
| `SLACK_WEBHOOK_URL` | 漏洩時のみ | Slack App → Incoming Webhooks → Revoke + 再生成 |
| `SLACK_BOT_TOKEN` | 漏洩時のみ | Slack App → OAuth & Permissions → Reinstall |

### Aikido Plugin との連携

Aikido Security が `secrets/` ディレクトリをスキャンする場合、
`.gitignore` に `~/.claude-r2c-config/` が登録されているため **git リポジトリには含まれない**。
Aikido の対象はリポジトリ内ファイルのみなので、このファイルはスキャン対象外。

ローテーション実施後:
1. `~/.claude-r2c-config/secrets/r2c-loop.env` を更新
2. `chmod 600 ~/.claude-r2c-config/secrets/r2c-loop.env` を再実行
3. smoke test を再実行して疎通確認

---

## 関連ドキュメント

- `docs/PUSHOVER_SETUP_GUIDE.md` — Pushover アカウント作成 + Token 取得手順
- `docs/24H_AUTOMATION_RUNBOOK_R2C.md` — 24h ループ全体仕様
- `docs/24H_LOOP_RETRY_AND_NOTIFICATION_SPEC.md` — Pushover priority 仕様
- `docs/PHASE1_ACCOUNT_MIGRATION_RUNBOOK.md` — Tier S アカウント分離手順
