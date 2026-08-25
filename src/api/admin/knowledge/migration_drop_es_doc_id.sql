-- ナレッジ配線是正 P4 (2026-08-25): faq_docs.es_doc_id は常にNULLで一度も
-- 埋まらない死列だった。DELETE /v1/admin/knowledge/:id が「この列が非NULLなら
-- ESドキュメントを削除する」というガードにしていたため、ESドキュメント削除が
-- 一度も実行されていなかった。ES doc id は faqEsDocId(tenantId, faqId)
-- (`${faqId}_${tenantId}`)の規約から決定的に導出する方式に統一済み
-- (src/lib/knowledge/faqIndexSync.ts)。
--
-- コードからの参照は本PRで全て除去済み(grep で0件)。
--
-- 適用は自動実行しない(CLAUDE.md 禁止8)。人間が運用作業として適用すること。
-- 適用前に、本番の faq_docs.es_doc_id が実際に全行NULLであることを
-- 確認すること(想定外の非NULL値がある場合は先に原因を調査する):
--   SELECT COUNT(*) FROM faq_docs WHERE es_doc_id IS NOT NULL;

ALTER TABLE faq_docs DROP COLUMN IF EXISTS es_doc_id;
