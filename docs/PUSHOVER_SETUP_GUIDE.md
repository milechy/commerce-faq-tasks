# Pushover セットアップガイド — R2C 24h Loop

> **対応 Asana**: GID `1214888719608975`（[Tier B] docs: 24hループ secrets 配備手順）
> **作成**: 2026-05-18
> **対象読者**: hkobayashi（手動セットアップ実施者）
> **前提**: Tier S アカウント分離（2026-05-19 06:05）完了後に実施

---

## 概要

Pushover は iOS/Android プッシュ通知サービス（$5 one-time + 7 日無料トライアル）。
`SCRIPTS/r2c-pushover.sh` が 24h ループの Lane 完了・失敗・緊急アラートを
hkobayashi の iPhone に送信する。

---

## Step 1: Pushover アカウント作成

1. **ブラウザで** [https://pushover.net/](https://pushover.net/) を開く
2. 右上「Sign Up」をクリック
3. 登録フォーム:
   - **Name**: hkobayashi（任意）
   - **Email**: hkobayashi@mooores.com
   - **Password**: 任意（強度の高いものを使用）
4. 登録完了メールを確認 → メール内リンクをクリックして認証
5. ログイン後、ダッシュボードの **User Key** をメモする（30 文字の英数字）
   - 例: `uQiRzpo4DXghDmr9QzzfQu` → これが `PUSHOVER_USER`

---

## Step 2: iOS アプリのインストールと User Key 確認

1. App Store で「Pushover」を検索してインストール
2. アプリを開き、Step 1 で作成したアカウントでログイン
3. 設定 → Your Devices: デバイス名が登録されることを確認
   - デバイス名（例: `iphone`）は `PUSHOVER_DEVICE` に設定可能（任意）
4. アプリ内でも User Key を確認可能: 設定 → アカウント → User Key

---

## Step 3: R2C 専用 Application の作成

1. ブラウザで [https://pushover.net/apps/build](https://pushover.net/apps/build) を開く
2. 以下を入力:

   | フィールド | 値 |
   |---|---|
   | **Name** | R2C 24h Loop |
   | **Type** | Application |
   | **Description** | R2C autonomous development loop notifications |
   | **URL** | https://api.r2c.biz |
   | **Icon** | （オプション、R2C ロゴ画像をアップロード） |

3. Agree to Terms of Service にチェック
4. 「Create Application」をクリック
5. 次のページに **API Token / Key** が表示される（30 文字の英数字）
   - 例: `azGDORePK8gMaC0QOYAMyEEuzJnyUi` → これが `PUSHOVER_TOKEN`

---

## Step 4: Secrets ファイルへの記入

`docs/24H_LOOP_SECRETS_TEMPLATE.md` の手順に従い、以下を記入:

```bash
export PUSHOVER_TOKEN=<Step 3 の API Token>
export PUSHOVER_USER=<Step 1 の User Key>
# export PUSHOVER_DEVICE=<Step 2 のデバイス名（任意）>
```

---

## Step 5: テスト送信（疎通確認）

secrets ファイルを作成した後、以下で動作確認:

### curl での直接テスト

```bash
# secrets を読み込む
source ~/.claude-r2c-config/secrets/r2c-loop.env

# テスト送信
curl -s \
    --form-string "token=${PUSHOVER_TOKEN}" \
    --form-string "user=${PUSHOVER_USER}" \
    --form-string "title=R2C Test" \
    --form-string "message=Pushover setup successful! 🎉" \
    --form-string "priority=0" \
    https://api.pushover.net/1/messages.json
```

期待レスポンス:

```json
{"status":1,"request":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}
```

`status: 1` = 送信成功。iPhone に通知が届くことを確認。

### r2c-pushover.sh での疎通確認

```bash
# dry-run（実際には送信しない）
bash SCRIPTS/r2c-pushover.sh --dry-run --priority 0 \
    --title "R2C Test" \
    --message "Smoke test from r2c-pushover.sh"

# 実際に送信
bash SCRIPTS/r2c-pushover.sh --priority 0 \
    --title "R2C Test" \
    --message "Real send test from r2c-pushover.sh"
```

---

## Step 6: Priority 別 iOS 通知の見え方確認

`docs/24H_LOOP_RETRY_AND_NOTIFICATION_SPEC.md` Section 2 より:

| Priority | 値 | iOS での見え方 | 用途 |
|---|---|---|---|
| Lowest | `-2` | バナーなし（通知センターのみ）| morning-report サマリ |
| Low | `-1` | 通知音なし | Lane 完了（正常） |
| Normal | `0` | 通常通知音 | 警告・要注意 |
| High | `1` | 通知音 + バイブ（サイレント無視）| Lane 失敗 2 回目 |
| Emergency | `2` | 30 秒ごとに繰り返し + 確認必須 | Tier S 失敗・Critical アラート |

各 priority で送信して iOS の挙動を確認:

```bash
source ~/.claude-r2c-config/secrets/r2c-loop.env

# -2: サイレント（朝レポート相当）
bash SCRIPTS/r2c-pushover.sh --priority -2 \
    --title "R2C [-2] Lowest" --message "サイレント通知テスト"

# -1: 低優先（Lane 完了相当）
bash SCRIPTS/r2c-pushover.sh --priority -1 \
    --title "R2C [-1] Low" --message "Lane 完了通知テスト"

# 0: 通常（警告相当）
bash SCRIPTS/r2c-pushover.sh --priority 0 \
    --title "R2C [0] Normal" --message "通常通知テスト"

# 1: 高優先（Lane 失敗相当）—— サイレントモード中も鳴る
bash SCRIPTS/r2c-pushover.sh --priority 1 \
    --title "R2C [1] High" --message "Lane 失敗通知テスト"

# 2: 緊急（Critical アラート相当）—— 確認するまで繰り返す
# ※ 確認後は Pushover アプリ内で「Acknowledge」を押すこと
bash SCRIPTS/r2c-pushover.sh --priority 2 \
    --title "R2C [2] Emergency" --message "緊急アラートテスト（要確認）"
```

---

## 料金

| 項目 | 費用 |
|---|---|
| Pushover iOS アプリ | $5.00 (one-time、7 日無料トライアル後) |
| API 使用料 | 無料（月 10,000 メッセージまで） |
| Emergency priority (priority=2) | 無料枠内 |

---

## トラブルシューティング

### 通知が届かない

1. `curl` でのテスト送信で `status: 1` を確認
2. iPhone の設定 → 通知 → Pushover → 許可されていることを確認
3. `PUSHOVER_DEVICE` を指定している場合はデバイス名のスペルを確認
4. `PUSHOVER_TOKEN` が Application Token（`xxxxxxxx` 形式）であることを確認（User Key と混同しない）

### curl エラー: invalid token

```
{"token":"invalid","status":0,"errors":["application token is invalid"]}
```

→ `PUSHOVER_TOKEN` が誤り。pushover.net → Apps → R2C 24h Loop → API Token を再確認。

### priority 2 の Emergency が止まらない

Pushover アプリを開き、通知をタップ → 「Acknowledge」ボタンを押す。
または curl で confirm:

```bash
# RECEIPT は priority 2 の送信レスポンスに含まれる
curl -s "https://api.pushover.net/1/receipts/${RECEIPT}/acknowledge.json" \
    --form-string "token=${PUSHOVER_TOKEN}"
```

---

## 関連ドキュメント

- `docs/24H_LOOP_SECRETS_TEMPLATE.md` — secrets テンプレート全体
- `docs/24H_LOOP_RETRY_AND_NOTIFICATION_SPEC.md` — Pushover priority 仕様（正本）
- `docs/24H_AUTOMATION_RUNBOOK_R2C.md` — 24h ループ全体仕様
- `SCRIPTS/r2c-pushover.sh` — 実装スクリプト
