# n8n 連携ガイド (Phase6)

⚠️ **[A2A-1a] 訂正 (2026-09-02)**: 本ガイドが前提とする `agent.search.completed` /
`agent.search.error` イベント送信（`WebhookNotifier`）は、`src/agent/http/agentSearchRoute.ts`
から実配線されていない死コードだったため削除した（`webhookNotifier?: WebhookNotifier`
は型としてのみ import され、`index.ts` 含めどこからもインスタンス化されていなかった）。
現状 `N8N_WEBHOOK_URL` を設定しても `/agent.search` からは何も送信されない。
本ワークフローを再度使う場合は、送信元の再実装が別途必要。

## 1. 前提

- `commerce-faq-tasks` が起動している
- n8n インスタンスがある（ローカルでもクラウドでも可）
- Slack / Notion など、後段の連携先の Credential が n8n 側で設定済み

## 2. Webhook URL の設定

1. n8n 上で **Agent Events Webhook** ワークフローをインポートする

   - `docs/n8n/workflows/agent-events-slack-alert.json`
   - メニュー: `Workflows -> Import from File`
   - ⚠️ **PR-10 訂正 (2026-08-23)**: `docs/n8n/workflows/agent-dialog-slack-alert.json`
     は `/agent.dialog` エンドポイント専用の旧ワークフローだが、そのエンドポイント
     一式（AgentDialogOrchestrator等）は本番未配線の死コードと判明し PR-10 で
     削除済み（`agent.dialog.fallback` / `agent.dialog.error` イベントは
     コード上どこからも送信されていなかった）。インポートしないこと。

2. Webhook ノードを開き、Production URL を確認する

   - 例: `http://localhost:5678/webhook/agent-events`

3. `commerce-faq-tasks` 側の `.env` に設定する

   ```env
   N8N_WEBHOOK_URL=http://localhost:5678/webhook/agent-events
   N8N_WEBHOOK_AUTH_HEADER=x-api-key: n8n-secret
   N8N_WEBHOOK_TIMEOUT_MS=2000
   ```
