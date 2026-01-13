

# TODO — Phase13（高速化・Notion連携開始）

## A. Fast-path & RAG 高速化
- RAG topKを 8→6→4 にABテスト
- HYBRID_TIMEOUT_MS の短縮（1500→1000）
- CE rerank の skip条件追加
- Answer prompt の短文化

---

## B. Notion DB 4種作成
- FAQ
- Products（教材）
- LP Points
- TuningTemplates（Clarify/Propose/Recommend/Close/Objection）

---

## C. AaaSとの同期（n8n）
- Notion → AaaS 設定JSONの生成
- Notion変更検知 → AaaSリフレッシュ
- Products / FAQ / LPPoints を pgvectorへ投入

---

## D. Planner拡張（英会話向け）
- level_diagnosis
- goal_setting
- compare_course

---

## E. Clarify Log + webhook連携
- dialog.clarify_needed → Notion DB に保存
- dialog.completed → SalesFunnel 記録

---

## F. 英会話テンプレの初期投入
- パートナーの心理学・営業テンプレを Notionへ
- CTA文言（無料体験）

---

Phase13では「英会話教材版AaaSの基礎」を構築する。