## データソース

- FAQ（Notion, CSV, API）
- HP/LP（sitemap + HTML crawl）
- キャンペーン / クーポン
- 商品データ（SKU・variant など）
- Web Search（補完目的）

---

# 📦 6. Web ページ取り込み（Site Ingestion Pipeline）

n8n or Local crawler:

1. sitemap.xml 取得
2. 新規・更新 URL 抽出
3. HTML 取得
4. JS 除去 → 正規化テキスト抽出
5. embedding 生成（Groq Embedding）
6. pgvector + ES に upsert
7. Slack に「差分通知」

---

# 📈 7. Monitoring / Logging

## 送信先

- n8n（Slack・Notion 連携）
- Datadog or Prometheus
- Stripe (usage logs)
- Cloudflare Logs

## モニタリングカテゴリ

- latency（p50/p95）
- error 率
- RAG 検索 ms
- Groq API latency
- fallback 率
- 各商品 CTA クリック / conversion

---

# 💸 8. Billing（Stripe + usage_logs）

### 設計

- /agent.dialog・/agent.search の実行ごとに
  - tokens_in / tokens_out
  - model_used
  - latency
  - tenant_id

を `usage_logs` に insert。

n8n が nightly で Stripe → Invoice draft 作成。

---

# 🛡 9. Auth & Security

- API Key（X-API-Key）
- Basic Auth（Integrations）
- Cloudflare ZeroTrust（IP allowlist）
- Request signing
- Log redaction（PII 削除）
- robots.txt 準拠 crawl

---

# 🧩 10. 開発の変更ポイントガイド

## 1. プロンプト変更したい → `src/agent/orchestrator/nodes/*`

## 2. 検索精度改善したい → `src/agent/rag/*`

## 3. Groq モデル切り替え → `src/agent/llm/*`

## 4. Webhook 出力を変えたい → `src/agent/events/*`

## 5. Slack/Notion 通知ロジック変更 → n8n 側

## 6. 課金まわり → `billing/*`

## 7. HP/LP クロール強化 → `rag/crawler`（将来追加予定）

---

# 🚀 11. Phase7–8 で拡張する領域（予告）

| 領域                 | 内容                               |
| -------------------- | ---------------------------------- |
| CrewAI Integration   | Issue 自動分類 & 修正 PR 生成      |
| Auto-Crawling        | sitemaps + RSS 増分                |
| Conversion Analytics | 商品誘導の行動ログ連携             |
| PromoBrain           | AIMD 式 販促テンプレート自動最適化 |
| A/B Testing          | Widget 挙動の多変量テスト          |

---

# 📌 12. 最後に

この文書は **開発者の「全体の地図」** です。  
各 Phase（6〜9）で実装する内容は、このマップのどこを触っているかを必ず確認してください。
