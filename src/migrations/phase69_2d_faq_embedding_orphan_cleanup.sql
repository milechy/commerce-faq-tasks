-- Phase69-2-D: faq_embedding orphan クリーンアップ + ON DELETE CASCADE 再発防止
-- 調査日: 2026-05-31
-- 実行担当: hkobayashi (VPS 手動実行)
-- 対象: VPS PostgreSQL (65.108.159.161)
--
-- 背景:
--   Phase69-2-A Round3 の VPS DB 調査で orphan faq_embedding 1件を検出。
--   faq_embeddings.metadata->>'faq_id' が指す faq_docs 行が存在しない。
--   根本原因: faq_embeddings に faq_docs.id への FOREIGN KEY (ON DELETE CASCADE) が無く、
--             さらに旧 API エンドポイント DELETE /admin/faqs/:id (faqAdminRoutes.ts) が
--             faq_docs を削除する際に faq_embeddings の連鎖削除をしていない。
--
-- このファイルの構成:
--   Step 1: orphan 検出 (確認用 SELECT)
--   Step 2: orphan クリーンアップ (BEGIN/COMMIT トランザクション)
--   Step 3: ON DELETE CASCADE 制約追加 (再発防止)
--   Step 4: 確認クエリ

-- ============================================================
-- Step 1: orphan 検出クエリ（実行前に必ず確認すること）
-- ============================================================
-- 実行して件数・内容を確認してから Step 2 に進むこと。
--
-- SELECT fe.id, fe.tenant_id, fe.metadata
-- FROM faq_embeddings fe
-- LEFT JOIN faq_docs fd ON fd.id = (fe.metadata->>'faq_id')::bigint
-- WHERE fe.metadata->>'faq_id' ~ '^[0-9]+$' AND fd.id IS NULL;
--
-- 期待値: 1件（Phase69-2-A Round3 調査結果）
-- 0件なら既に手動削除済みのため Step 2 はスキップしてよい。
-- 2件以上なら hkobayashi が内容を精査してから削除すること。

-- ============================================================
-- Step 2: orphan クリーンアップ
-- ============================================================
-- 前提: Step 1 の確認が完了していること。
-- バックアップ推奨:
--   psql $DATABASE_URL -c "COPY (SELECT * FROM faq_embeddings WHERE metadata->>'faq_id' ~ '^[0-9]+$') TO '/tmp/faq_embeddings_backup_$(date +%Y%m%d).csv' CSV HEADER;"

BEGIN;

-- orphan embedding を削除（faq_docs に対応行が存在しない faq_id 持ち embedding）
DELETE FROM faq_embeddings fe
WHERE fe.metadata->>'faq_id' ~ '^[0-9]+$'
  AND NOT EXISTS (
    SELECT 1 FROM faq_docs fd
    WHERE fd.id = (fe.metadata->>'faq_id')::bigint
  );

-- 削除件数確認（COMMIT 前に確認可能）
-- \echo 'Deleted rows:'
-- SELECT changes();  -- psql では ROW_COUNT を確認

COMMIT;

-- ============================================================
-- Step 3: ON DELETE CASCADE 制約追加（再発防止）
-- ============================================================
-- 注意:
--   現在の faq_embeddings テーブルは metadata JSONB 内に faq_id を格納しており、
--   物理的な FOREIGN KEY 列 (faq_id BIGINT) が存在しない。
--   そのため、通常の ALTER TABLE ... ADD FOREIGN KEY は追加できない。
--
--   対応方針: アプリ層連鎖削除（現状の新ルート）を正として、
--             旧ルート DELETE /admin/faqs/:id に欠落している連鎖削除を補完する。
--             DB制約としての FK 追加は将来マイグレーションで faq_id 列を追加する際に実施。
--
-- [将来対応用テンプレート - 今回は実行しない]
-- ALTER TABLE faq_embeddings
--   ADD COLUMN IF NOT EXISTS faq_doc_id BIGINT
--     REFERENCES faq_docs(id) ON DELETE CASCADE;
-- UPDATE faq_embeddings
--   SET faq_doc_id = (metadata->>'faq_id')::bigint
--   WHERE metadata->>'faq_id' ~ '^[0-9]+$';
-- -- faq_doc_id への INDEX
-- CREATE INDEX IF NOT EXISTS idx_faq_embeddings_faq_doc_id
--   ON faq_embeddings (faq_doc_id);

-- ============================================================
-- Step 4: 確認クエリ（クリーンアップ後に実行）
-- ============================================================
-- orphan が 0 件になっていることを確認:
--
-- SELECT COUNT(*) AS orphan_count
-- FROM faq_embeddings fe
-- LEFT JOIN faq_docs fd ON fd.id = (fe.metadata->>'faq_id')::bigint
-- WHERE fe.metadata->>'faq_id' ~ '^[0-9]+$' AND fd.id IS NULL;
--
-- 期待値: 0
