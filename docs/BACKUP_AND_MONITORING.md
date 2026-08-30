# オフサイトバックアップ と 外部死活監視

Phase 6（事業継続性）。2026-08 の監査で判明した2つの単一障害点への対処。

## なぜ必要か（監査所見）

1. **DBバックアップがオフサイトに無い。** `SCRIPTS/backup-postgres.sh` は良く出来ているが、
   保存先 `/backup` は本番 VPS と同一ホスト。VPS が全損（ディスク故障・誤操作・ランサム・
   アカウント凍結）すると、DB もバックアップも同時に失われる。**Postgres が事実上の単一障害点。**

2. **外部からの死活監視が無い。** 既存の監視（PM2・cron・`/health` を叩く gate スクリプト）は
   すべて **VPS 上**で動く。VPS が落ちると監視も通知経路も同時に死に、誰も気づけない。
   死活監視は必ず **監視対象の外側**から行う必要がある。

いずれも「認証情報を投入すれば動く」状態でスクリプト化した。実値はここには書かない
（`.env` / CI secrets に置く）。

---

## 大原則: 秘密はスクリプトに書かない

- R2 のキー、UptimeRobot の API キー、webhook URL は **`.env` もしくは CI secrets** に置く。
  スクリプト・リポジトリには**絶対にコミットしない**。`.env.example` はプレースホルダのみ。
- スクリプトは `.env` を **source しない**（プレースホルダ行がコマンドと解釈され秘密が漏れる
  過去事故があるため）。必要な変数だけ `sed` で1行取り出す。
- rclone / UptimeRobot へ秘密を渡すときは **環境変数**で渡し、コマンドライン引数にしない
  （引数は `ps` で他ユーザーから見える）。エラー出力も既知の秘密値をマスクしてから surface する。

---

## 1. オフサイトバックアップ（rclone → Cloudflare R2）

`SCRIPTS/backup-offsite.sh` が、`backup-postgres.sh` の出力 `/backup/pg_*.sql.gz` を
Cloudflare R2（S3 互換）へ複製する。

### 必要な環境変数

| 変数 | 必須 | 既定 | 説明 |
|---|---|---|---|
| `R2_ACCOUNT_ID` | ✓ | — | Cloudflare アカウントID。S3 エンドポイント導出に使用 |
| `R2_ACCESS_KEY_ID` | ✓ | — | R2 の S3 互換アクセスキーID |
| `R2_SECRET_ACCESS_KEY` | ✓ | — | R2 の S3 互換シークレット |
| `R2_BUCKET` | ✓ | — | アップロード先バケット名（例 `r2c-db-backups`） |
| `OFFSITE_RETENTION_DAYS` | | `30` | オフサイト保持日数（ローカル7日より長く） |
| `OFFSITE_PREFIX` | | `postgres` | バケット内プレフィックス |
| `BACKUP_DIR` | | `/backup` | ローカル元。`backup-postgres.sh` と一致 |
| `ENV_FILE` | | `/opt/rajiuce/.env` | 変数の取り出し元 |

### R2 バケット作成（一度きり・ユーザー作業）

1. Cloudflare ダッシュボード → R2 → **Create bucket**（例 `r2c-db-backups`）。ロケーションは任意。
2. R2 → **Manage R2 API Tokens** → **Create API Token**。
   - 権限: **Object Read & Write**
   - 対象バケット: 当該バケットに限定するのが望ましい（最小権限）
   - 発行される **Access Key ID** と **Secret Access Key** を控える（Secret は再表示不可）
3. 本番 VPS の `/opt/rajiuce/.env` に追記（値はコミットしない）:
   ```
   R2_ACCOUNT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   R2_ACCESS_KEY_ID=xxxxxxxxxxxxxxxxxxxx
   R2_SECRET_ACCESS_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   R2_BUCKET=r2c-db-backups
   ```
4. VPS に rclone を導入: `curl https://rclone.org/install.sh | sudo bash`
   （`jq` も入れておくと検証が厳密になる: `sudo apt-get install -y jq`）

### 使い方

```bash
bash SCRIPTS/backup-offsite.sh --dry-run   # 疎通と対象の確認（転送・削除しない）
bash SCRIPTS/backup-offsite.sh             # copy → 検証 → ローテーション
bash SCRIPTS/backup-offsite.sh --list      # オフサイトのオブジェクト一覧
```

- **copy（追加のみ）を使い、sync は使わない。** ローカル保持(7日)＜オフサイト保持(30日)なので、
  sync だとローカルから消えた古い世代をオフサイトからも消してしまう。オフサイトの
  ローテーションは `--min-age` による経過時間ベースの削除で別途行う（アップロード成功後）。
- **アップロード後に検証する**: 最新ファイルがオフサイトに、ローカルと同一サイズで在ることを
  確認する。「転送コマンドが 0 で返った」と「向こうに正しく在る」は別物。
- 認証情報が1つでも欠けていたら**実行せず**非ゼロ終了。rclone 未導入なら明確なメッセージ。
  失敗は非ゼロ終了 + Slack 通知（`notify-slack.sh`）。冪等・再実行安全。

### cron（VPS。`backup-postgres.sh` の直後）

```bash
# cron はサーバTZ(VPSはUTC)で動く。ローカルbackupを 0 17 UTC に取るなら、その後に:
30 17 * * * bash /opt/rajiuce/SCRIPTS/backup-offsite.sh >> /var/log/r2c-offsite.log 2>&1
```
既存 cron を壊さない追記形式:
```bash
crontab -l 2>/dev/null | grep -q backup-offsite || \
  (crontab -l 2>/dev/null; echo "30 17 * * * bash /opt/rajiuce/SCRIPTS/backup-offsite.sh >> /var/log/r2c-offsite.log 2>&1") | crontab -
```

### 復旧手順（R2 から取得して restore）

VPS を失った状態を想定し、**新しいホスト**で:

1. rclone を導入し、R2 の認証情報を env に設定（上記と同じ4変数）。
2. 最新のバックアップを R2 から取得:
   ```bash
   export RCLONE_S3_PROVIDER=Cloudflare
   export RCLONE_S3_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
   export RCLONE_S3_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
   export RCLONE_S3_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
   # 一覧して最新を確認
   rclone lsl ":s3:${R2_BUCKET}/postgres"
   # 取得（例）
   rclone copy ":s3:${R2_BUCKET}/postgres/pg_YYYYMMDD.sql.gz" /restore/
   ```
   （`backup-offsite.sh --list` でも一覧できる）
3. 健全性を確認: `gzip -t /restore/pg_YYYYMMDD.sql.gz`
4. 検証用DBへ戻して突き合わせる（本番を上書きしない検証）:
   ```bash
   BACKUP_DIR=/restore bash SCRIPTS/backup-postgres.sh --restore-test /restore/pg_YYYYMMDD.sql.gz
   ```
5. 実際に復旧する場合は、新しい Postgres に対して:
   ```bash
   gzip -dc /restore/pg_YYYYMMDD.sql.gz | psql "$NEW_DATABASE_URL" -v ON_ERROR_STOP=1
   ```

---

## 2. 外部死活監視

**必ず監視対象(VPS)の外側で動かす。** VPS 上で動かすと VPS 全損時に監視も死ぬ。
2通り用意した。**UptimeRobot（SaaS）を第一候補**とし、SaaS を使えない場合の
フォールバックとして `external-healthcheck.sh` を用意している。

### 2-A. UptimeRobot（推奨）— `SCRIPTS/setup-uptime-monitoring.sh`

第三者の SaaS が VPS の外から HTTP 監視する。落ちたら Slack/メール等へ通知。

| 変数 | 必須 | 既定 | 説明 |
|---|---|---|---|
| `UPTIMEROBOT_API_KEY` | ✓ | — | UptimeRobot の Main API Key |
| `UPTIMEROBOT_ALERT_CONTACT_ID` | | — | 通知先の alert contact id |
| `MONITOR_INTERVAL_SEC` | | `300` | 監視間隔秒（無料枠下限=5分） |
| `MONITOR_API_URL` | | `https://api.r2c.biz/health` | 公開 API の health（機微を含まない素の health） |
| `MONITOR_ADMIN_URL` | | `https://admin.r2c.biz` | 管理UI |
| `MONITOR_WIDGET_URL` | | （空） | 設定時のみ widget 監視を追加 |

セットアップ（ユーザー作業）:

1. https://uptimerobot.com にサインアップ（無料枠: 50 モニタ / 5分間隔）。
2. My Settings → API Settings → **Main API Key** を作成 → `UPTIMEROBOT_API_KEY` に設定。
3. （推奨）Alert Contacts で Slack / メール等の通知先を作成し、その id を
   `UPTIMEROBOT_ALERT_CONTACT_ID` に設定。**未設定だと落ちても通知されない。**
4. 実行:
   ```bash
   bash SCRIPTS/setup-uptime-monitoring.sh --dry-run   # 送信内容の確認（API 叩かない）
   bash SCRIPTS/setup-uptime-monitoring.sh             # 作成/更新（冪等）
   bash SCRIPTS/setup-uptime-monitoring.sh --list      # 既存モニタ一覧
   ```

- **冪等**: 同名モニタが在れば更新、無ければ作成。何度流しても重複しない
  （厳密な既存判定には `jq` が必要。無い環境では新規作成→重複エラーになりうる）。
- API キー未設定なら**実行せず**セットアップ手順を表示。API キーはログ・URL に出さない。

### 2-B. フォールバック（SaaS 不使用）— `SCRIPTS/external-healthcheck.sh`

UptimeRobot を使えない/使いたくない場合の dead-man's-switch。
**別ホスト / GitHub Actions / 自宅マシンの cron から回す**（VPS では動かさない）。
連続 `FAIL_THRESHOLD` 回失敗して初めて通知し、復旧したら1回だけ復旧通知する。

| 変数 | 既定 | 説明 |
|---|---|---|
| `HEALTHCHECK_URL` | `https://api.r2c.biz/health` | 監視 URL |
| `EXPECT_STATUS` | `200` | 期待 HTTP ステータス |
| `EXPECT_BODY` | （空） | 応答本文に含まれるべき文字列（任意） |
| `TIMEOUT_SEC` | `15` | 1回あたりタイムアウト秒 |
| `FAIL_THRESHOLD` | `3` | 連続何回失敗で通知するか |
| `ALERT_WEBHOOK_URL` | （空） | 失敗/復旧を送る webhook（Slack Incoming Webhook 等）。未設定なら stderr のみ |
| `STATE_FILE` | `/tmp/r2c-external-healthcheck.state` | 連続失敗回数の保存先 |
| `MONITOR_LABEL` | URL のホスト名 | 通知に付ける対象名 |

終了コード: `0`=対象は正常 / `2`=対象が異常（アラート条件）/ `1`=スクリプト自身の使用法エラー。

別ホストの cron 例（状態を持ち越せるので厳密な連続失敗判定が可能）:
```bash
*/5 * * * * ALERT_WEBHOOK_URL='https://hooks.slack.com/services/...' \
  bash /path/to/SCRIPTS/external-healthcheck.sh >> /var/log/r2c-ehc.log 2>&1
```

GitHub Actions 例（VPS と完全に独立。webhook は repo secrets へ）:
```yaml
# .github/workflows/external-healthcheck.yml
on:
  schedule:
    - cron: '*/5 * * * *'   # 5分毎（GHA cron はUTC・多少遅延あり）
jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - env:
          ALERT_WEBHOOK_URL: ${{ secrets.HEALTHCHECK_WEBHOOK_URL }}
          FAIL_THRESHOLD: '2'   # GHA は実行毎に状態リセット。閾値は小さめ推奨
        run: bash SCRIPTS/external-healthcheck.sh
```
> GHA は実行毎に `STATE_FILE` がリセットされる。厳密な連続失敗判定が要るなら
> 常駐ホストの cron + `STATE_FILE` 永続化を推奨。

---

## ユーザーが用意するもの（まとめ）

| # | もの | 用途 | 置き場所 |
|---|---|---|---|
| 1 | Cloudflare R2 バケット + S3互換 API トークン（Read&Write） | オフサイトバックアップ | 本番 `.env` |
| 2 | UptimeRobot アカウント + Main API Key（+ Alert Contact） | 外部死活監視（推奨） | `.env` / CI secrets |
| 3 | Slack Incoming Webhook 等（フォールバック監視を使う場合） | 死活アラートの通知先 | 監視を回す環境の env / CI secrets |

いずれも**実値はスクリプト・リポジトリに書かず、`.env` / CI secrets に置く**こと。
