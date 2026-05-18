# 24H ループ Retry & Notification Spec

> **Phase 1 Teammate 4 (T4) 担当** — Asana GID 1214893461631827
>
> 本ドキュメントは **spec のみ** であり、実装は別 Phase で行う (Phase 2-4)。
> 関連: `docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md` §3 (構造化通知) / §16 (Pushover policy) / §20 (Slack 投稿)、`docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md` §1-#9 (priority mapping)。

---

## Scope

24 時間自動化ループ (Asana → CLI Lane → Gate → PR → auto-merge → Cloudflare deploy → morning report) における以下を規定する。

1. Lane 失敗時の retry 戦略 (遅延・通知・自動再開判定)
2. Pushover priority (-2 〜 +2) の R2C 固有トリガー完全列挙
3. 通知本文の構造化 JSON ルール (PII / 書籍内容を含めない)
4. morning-report Slack Block Kit JSON schema
5. 実装ファイルの Phase 別マッピング

---

## Section 1: Lane 失敗 retry 戦略

Lane (= CLI が 1 つの Asana タスクを処理するワーカープロセス) が exit code 非 0 で落ちた場合の retry ポリシー。

### 1.1 retry テーブル

| 試行回数 | 遅延 | Pushover priority | Slack 通知 | 自動再開 | 備考 |
|---|---|---|---|---|---|
| 1 回目失敗 (= 初回失敗) | 5 分後 | (通知なし、ログのみ) | (なし) | 自動 retry | 一時的なネットワーク / lock 競合の想定 |
| 2 回目失敗 | 30 分後 | 0 (Normal) | 投稿 (構造化 JSON) | 自動 retry | hkobayashi の朝プロトコル枠で気づく |
| 3 回目失敗 | (停止) | 1 (High) | 投稿 + DM | 手動再開待ち | Lane を pause、Tier S 朝承認 (06:15) で原因究明 |

### 1.2 判定ルール

- Lane プロセスの **exit code が 0 以外** = 失敗。
- **Gate 1-3 (typecheck / lint / test / security-scan / build) で fail した場合は修正試行は CLI 内で完結**。Lane プロセス自体が落ちなければ retry カウントは加算しない。retry カウントは「Lane プロセス全体の落ち」のみ加算する。
- 同一 Asana タスクに対する retry 上限は **3 回** (3 回目で手動レビュー待ち、Lane は pause)。
- 5 分 / 30 分の遅延は cron / sleep ベースで実装。Phase 2 の `scripts/24h-loop/lane-retry.sh` で正式実装。
- retry 回数は Asana タスクの custom field または `.wolf/lane-state.json` に永続化 (Phase 2 で確定)。Lane プロセス再起動・マシン再起動を跨いでも消えないこと。
- Lane が pause 状態 (= 3 回失敗後) は hkobayashi が朝プロトコル (06:10-15) で対応する。Tier S 承認に類似の手順で「pause 解除 → retry リセット → 再開」を明示的に承認する。

### 1.3 Gate 失敗との区別

| 種別 | retry 対象 | 加算 |
|---|---|---|
| Gate 1 (typecheck/lint/test) fail | CLI 内で `@gate-runner` → 修正 → 再実行 | retry カウント加算なし |
| Gate 2 (security-scan) High/Critical | CLI 内で修正 → 再実行 | retry カウント加算なし |
| Gate 2.5 (Codex review) Critical/High | CLI 内で修正 → 再実行 | retry カウント加算なし |
| Gate 3 (build) fail | CLI 内で修正 → 再実行 | retry カウント加算なし |
| **Lane プロセス自体が exit code 非 0 で落ちた** | Section 1.1 表に従う | **加算** |
| CLI が無限ループ / タイムアウト (60min 超) | watchdog が SIGKILL → 失敗扱い | **加算** |

### 1.4 Pseudocode (Phase 2 で正式実装)

```bash
# scripts/24h-loop/lane-retry.sh (案、Phase 2 で正式実装)
# Usage: lane-retry.sh <retry_count> <asana_gid>

RETRY=$1
GID=$2

case $RETRY in
  1)
    sleep 300                                       # 5 min
    ;;
  2)
    sleep 1800                                      # 30 min
    pushover_notify --priority 0 --json "$(build_notify_json normal "Lane 2 回目失敗" $GID)"
    slack_post --channel "#r2c" --json "$(build_slack_json $GID)"
    ;;
  3)
    pushover_notify --priority 1 --json "$(build_notify_json high "Lane 3 回連続失敗、pause" $GID)"
    slack_post --channel "#r2c" --json "$(build_slack_json $GID)"
    slack_dm --user "hkobayashi" --json "$(build_slack_dm_json $GID)"
    update_lane_state "$GID" "paused"               # 手動再開待ち
    exit 99
    ;;
  *)
    echo "ERROR: invalid retry count $RETRY" >&2
    exit 1
    ;;
esac
```

---

## Section 2: Pushover priority 完全列挙

`docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md` §16 と完全整合させる。

### 2.1 priority マッピング表

| Priority | 名称 | トリガー例 (R2C 固有) | レスポンス期待 | 通知方法 |
|---|---|---|---|---|
| **2** | Critical / Emergency | 本番 `/health` 5 分連続 503 / VPS PM2 全プロセス落ち / Supabase RLS bypass 検知 / 本番テナント間データ漏洩疑い / DB migration apply 失敗 (Tier S 中) | 即時介入 (睡眠中も起こす) | Pushover priority 2 (emergency, retry 60s / expire 3600s) + Slack `#r2c` 投稿 |
| **1** | High | Tier S 承認待ち / Lane 3 回連続失敗 / Codex Critical 指摘 / Cloudflare Pages デプロイ失敗 | 当日中対応 | Pushover priority 1 + Slack `#r2c` 投稿 |
| **0** | Normal | Tier A 承認待ち / Lane 1-2 回失敗 / Gate 2.5 Major 指摘 / morning-report 異常検知 | 朝プロトコル 06:10-15 枠 | Pushover priority 0 + Slack 投稿 |
| **-1** | Low | Tier B auto-merge 成功 / Cloudflare Pages auto-deploy 成功 | 集計のみ | Slack 投稿のみ (Pushover 抑制) |
| **-2** | Lowest | daily morning report (06:00) / 週次 KPI サマリ | 朝のメイン情報源 | Slack 投稿のみ (Pushover 抑制) |

### 2.2 priority 2 (Emergency) のガード条件

priority 2 は睡眠中も鳴らすため、誤検知 1 回で信頼を失う。以下の **全条件 AND** を満たす場合のみ priority 2 を発火する。

- 検知元が 2 系統以上 (例: `/health` 503 + PM2 status DOWN)
- 直近 5 分以内に同一 incident で priority 2 を発火していない (dedup)
- メンテナンス window (`.wolf/maintenance.json` で明示宣言) に該当しない

### 2.3 priority マッピングの変更フロー

priority 2 / 1 の追加・削除は **Tier S 承認必須**。priority 0 以下は Tier A 承認で変更可能。本ドキュメントと指示文 §16 を同時に更新すること。

---

## Section 3: 通知本文ルール (構造化 JSON)

`docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md` §3 (構造化通知) / §20 (Slack 投稿) と完全整合。

### 3.1 必須ルール

- **全通知は構造化 JSON で生成する**。フリーテキスト禁止。
- **PII / 書籍内容 (RAG コンテンツ) / API キー / tenantId 値を含めない** (Anti-Slop, `CLAUDE.md`)。
  - PII = メールアドレス / 電話番号 / 氏名 / 住所
  - 書籍内容 = `ragExcerpt` / `chunk_text` / `answer` 本文
  - API キー = `AGENT_API_KEY`, `GROQ_API_KEY` 等の値 (キー名は OK)
  - tenantId = UUID 値 (短縮ハッシュは OK)
- summary は **30 文字以内** (Pushover の通知ペインで折り返さない長さ)。
- 詳細 URL は Asana タスク / GitHub PR / Grafana ダッシュボードへの 1 本 (複数なら配列)。

### 3.2 サンプル (Pushover 経由)

```json
{
  "priority": 1,
  "summary": "Tier S 承認待ち: 1 件",
  "details": [
    {
      "type": "tier_s_pending",
      "task_gid": "1214891864857305",
      "task_name_short": "alias-runbook",
      "url": "https://app.asana.com/0/1213607637045514/1214891864857305"
    }
  ],
  "timestamp": "2026-05-19T06:10:00+09:00"
}
```

### 3.3 サンプル (Lane 2 回目失敗、priority 0)

```json
{
  "priority": 0,
  "summary": "Lane 2 回目失敗、30min retry",
  "details": [
    {
      "type": "lane_retry",
      "retry_count": 2,
      "task_gid": "1214893461631827",
      "task_name_short": "retry-pushover-spec",
      "url": "https://app.asana.com/0/1213607637045514/1214893461631827",
      "next_retry_at": "2026-05-19T06:40:00+09:00"
    }
  ],
  "timestamp": "2026-05-19T06:10:00+09:00"
}
```

### 3.4 禁止例 (Anti-Slop 違反)

```json
{
  "priority": 0,
  "summary": "RAG エラー: '東京都渋谷区...' で検索失敗",   // ❌ PII 漏洩
  "details": [
    {
      "ragExcerpt": "第3章 ...",                          // ❌ 書籍内容
      "tenantId": "550e8400-e29b-41d4-a716-446655440000", // ❌ tenantId 値
      "apiKey": "sk-..."                                   // ❌ API キー値
    }
  ]
}
```

---

## Section 4: morning-report Slack Block Kit JSON schema

`scripts/24h-loop/morning-report.ts` (Phase 4 実装予定) が 06:00 JST に `#r2c` チャンネル (channel id: `C0AG07HFJTB`) に投稿する Slack Block Kit メッセージの schema。

### 4.1 セクション省略可否

| セクション | 省略条件 |
|---|---|
| header | **必須** (常に表示) |
| L1-L6 メトリクス | **必須** (値が取れない場合は `N/A` 文字列) |
| 承認待ち (Tier S / Tier A) | 両方 0 件なら省略可 (代わりに `*✅ 承認待ち: 0 件*` を 1 行表示) |
| Lane 失敗 (24h) | 0 件なら省略可 |
| Tier 2 (Critical) インシデント | 0 件なら省略可 (priority 2 ガード強化のため通常は表示しない) |
| footer (生成時刻 + 次回実行時刻) | **必須** |

### 4.2 完全な schema サンプル

```json
{
  "channel": "C0AG07HFJTB",
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "🌅 R2C Morning Report — 2026-MM-DD" }
    },
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*L1 /health 稼働率 (7d)*: 99.7%" },
        { "type": "mrkdwn", "text": "*L2 PM2 再起動 (24h)*: 0 回" },
        { "type": "mrkdwn", "text": "*L3 Codex Gate 2.5 通過率 (7d)*: 92%" },
        { "type": "mrkdwn", "text": "*L4 Asana 期限遵守率*: 85%" },
        { "type": "mrkdwn", "text": "*L5 Admin UI ログイン成功率 (24h)*: 100%" },
        { "type": "mrkdwn", "text": "*L6 Tier 2 通知 (7d)*: 0 件" }
      ]
    },
    {
      "type": "divider"
    },
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*📋 承認待ち*" }
    },
    {
      "type": "section",
      "fields": [
        { "type": "mrkdwn", "text": "*Tier S*: 1 件\n• <https://app.asana.com/0/.../GID|tier-s-task-name>" },
        { "type": "mrkdwn", "text": "*Tier A*: 3 件\n• <https://app.asana.com/0/.../GID|task-a1>\n• <https://app.asana.com/0/.../GID|task-a2>\n• <https://app.asana.com/0/.../GID|task-a3>" }
      ]
    },
    {
      "type": "divider"
    },
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*🚧 Lane 失敗 (24h)*" }
    },
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "• Lane 3 (1 回目失敗、5min retry 中): <https://github.com/milechy/commerce-faq-tasks/pull/XXX|PR #XXX>" }
    },
    {
      "type": "divider"
    },
    {
      "type": "context",
      "elements": [
        { "type": "mrkdwn", "text": "生成: 2026-MM-DD 06:00 JST | 次回: 2026-MM-DD+1 06:00 JST | source: `scripts/24h-loop/morning-report.ts`" }
      ]
    }
  ]
}
```

### 4.3 L1-L6 メトリクス定義

| ID | 名称 | 集計元 | 期間 |
|---|---|---|---|
| L1 | `/health` 稼働率 | Prometheus `up{job="api"}` | 7 日 |
| L2 | PM2 再起動回数 | `pm2 jlist` の `restart_time` 差分 | 24 時間 |
| L3 | Codex Gate 2.5 通過率 | `/codex:result` ログ集計 | 7 日 |
| L4 | Asana 期限遵守率 | Asana MCP `get_tasks_for_project` の `due_on` vs `completed_at` | 過去 30 日完了タスク |
| L5 | Admin UI ログイン成功率 | `/v1/admin/auth/login` 200 / total | 24 時間 |
| L6 | Tier 2 (priority 2) 通知件数 | Pushover ログ / `.wolf/notify-log.json` | 7 日 |

### 4.4 Anti-Slop 適用

- L4 で「期限超過タスク」を列挙する場合、タスク名のみ表示し PII / RAG / tenantId を含めない。
- Lane 失敗セクションでは PR URL とブランチ名のみ表示。エラーログ本文は転載せず Grafana / GitHub Actions へのリンクで誘導する。

---

## Section 5: 関連実装 (Phase 2-4 で実装予定の参照)

本ドキュメントは spec のみ。実装は別 Phase で行う。

| 実装ファイル | Phase | 役割 |
|---|---|---|
| `scripts/24h-loop/lane-retry.sh` | Phase 2 | retry 遅延 (5min / 30min / 停止) + 試行回数管理 (`.wolf/lane-state.json`) |
| `scripts/24h-loop/notify.ts` | Phase 3 | Pushover priority マッピング (-2 〜 +2) + Slack 投稿 + dedup |
| `scripts/24h-loop/morning-report.ts` | Phase 4 | L1-L6 集計 + Slack Block Kit JSON 生成 + 06:00 JST cron |

### 5.1 環境変数 (Phase 3 で `.env` に追加予定)

```bash
# Pushover
PUSHOVER_TOKEN=<app token>
PUSHOVER_USER=<user key>
PUSHOVER_DEVICE=<optional, 特定デバイスのみ>

# Slack
SLACK_BOT_TOKEN=<xoxb-...>
SLACK_CHANNEL_R2C=C0AG07HFJTB

# Notify dedup
NOTIFY_DEDUP_WINDOW_SECONDS=300       # priority 2 重複抑制 (5 分)
NOTIFY_LOG_PATH=.wolf/notify-log.json
```

### 5.2 テスト方針 (Phase 2-4 で実装)

- retry スクリプト: bats でユニットテスト (`scripts/24h-loop/__tests__/lane-retry.bats`)
- notify.ts: Pushover / Slack API は **常にモック** (`docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md` §3 のテストルール遵守)
- morning-report.ts: Block Kit JSON snapshot test (`scripts/24h-loop/__tests__/morning-report.test.ts`)

---

## References

- `docs/R2C_CLAUDE_AI_INSTRUCTIONS_V1.md` §3 (構造化通知) / §16 (Pushover policy) / §20 (Slack 投稿)
- `docs/24H_AUTOMATION_R2C_GAP_ANALYSIS.md` §1-#9 (priority mapping)
- `CLAUDE.md` Anti-Slop (PII / 書籍内容 / API キー / tenantId をメトリクスラベル・アラートメッセージに含めない)
- `docs/R2C_DEVELOPMENT_PLAYBOOK.md` (Gate 1-3 / Tier S/A/B 定義)

---

_Phase 1 T4 spec, Asana GID 1214893461631827. 実装は Phase 2-4 で行う。_
