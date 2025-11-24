# n8n 連携ガイド (Phase6)

## 1. 前提

- `commerce-faq-tasks` が起動している
- n8n インスタンスがある（ローカルでもクラウドでも可）
- Slack / Notion など、後段の連携先の Credential が n8n 側で設定済み

## 2. Webhook URL の設定

1. n8n 上で **Agent Events Webhook** ワークフローをインポートする

   - `docs/n8n/workflows/agent-events-slack-alert.json`
   - メニュー: `Workflows -> Import from File`

2. Webhook ノードを開き、Production URL を確認する

   - 例: `http://localhost:5678/webhook/agent-events`

3. `commerce-faq-tasks` 側の `.env` に設定する

   ```env
   N8N_WEBHOOK_URL=http://localhost:5678/webhook/agent-events
   N8N_WEBHOOK_AUTH_HEADER=x-api-key: n8n-secret
   N8N_WEBHOOK_TIMEOUT_MS=2000
   ```
