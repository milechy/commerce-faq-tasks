# n8n Workflow: Agent Dialog Slack Alerts

このワークフローは、`commerce-faq-tasks` の `/agent.dialog` から送信される Webhook イベントを受信し、  
`agent.dialog.fallback` / `agent.dialog.error` のときに Slack に通知を送ります。

## 前提

- n8n が起動している
- Slack API 認証（Slack ノードの Credentials）が設定済み

## 手順

1. `docs/n8n/workflows/agent-dialog-slack-alert.json` を n8n にインポートする
   - n8n UI 上部メニュー → **Workflows → Import from File**
2. Webhook URL を確認する
   - `Agent Events Webhook` ノード → `Webhook URLs` → `Production URL` をコピー
3. `commerce-faq-tasks` 側の `.env` に設定する
   ```env
   N8N_WEBHOOK_URL=http://localhost:5678/webhook/agent-events
   N8N_WEBHOOK_AUTH_HEADER=x-api-key: n8n-secret
   N8N_WEBHOOK_TIMEOUT_MS=2000
   ```
