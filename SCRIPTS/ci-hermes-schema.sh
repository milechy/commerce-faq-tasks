#!/usr/bin/env bash
# SCRIPTS/ci-hermes-schema.sh
#
# GET /v1/hermes-mcp/proposals の越境防止(shareConsentSqlPredicate)と、
# searchConversations の「発話ゼロセッションが limit を食い潰さない」挙動を
# 実 Postgres に対して検証するためのテーブルを、実際の migration ファイルを
# 適用して作る(SCRIPTS/ci-billing-schema.sh と同じ方針。手書きスキーマではなく
# 本物の migration を流すことで、CI のスキーマと本番の積み上げ履歴の乖離を防ぐ)。
#
# ★前提: このスクリプトは SCRIPTS/ci-billing-schema.sh の後に実行すること★
# tenants 本体は billing schema 側で既に作成済みの前提で、ここでは重複して
# 作らない(CI では同一 Postgres インスタンス・同一DBを使い回し、ジョブ全体の
# コストを増やさない)。単独で実行する場合は先に ci-billing-schema.sh を流すこと。
#
# ★ tenants.features は ci-billing-schema.sh の対象外★
# features(JSONB)は課金集計SQLが参照しないため billing schema には含まれて
# いない。shareConsentSqlPredicate() が読む列のため、ここで追加する。
#
# 対象テーブル: tenants.features / conversation_evaluations / tuning_rules /
# chat_sessions / chat_messages / conversion_attributions
# (chat_sessions・chat_messages は ci-billing-schema.sh が計上単位の変更で
# 既に作成済みのため、ここでは CREATE TABLE IF NOT EXISTS により冪等に
# 再適用されるだけで無害)。
#
# ★faq_embeddings / book_uploads もここに同居させている★
# 書籍チャンク編集の楽観ロック(content_updated_at)を実Postgresで検証する
# bookChunkOptimisticLockSqlIntegration.test.ts が使う。hermes-mcp固有の
# テーブルとは無関係だが、Gate 4 は使い捨てPostgres・同一DBをジョブ全体で
# 使い回す方針(billing-sql ジョブのコメント参照)のため、新しいサービス/
# 新しい環境変数を増やさずここに追加する。
#
# 使い方:
#   DATABASE_URL=postgres://... bash SCRIPTS/ci-billing-schema.sh
#   DATABASE_URL=postgres://... bash SCRIPTS/ci-hermes-schema.sh
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "❌ DATABASE_URL is not set" >&2
  exit 1
fi

FILES=(
  # tenants.features(JSONB)。shareConsentSqlPredicate() が読む列。
  # 課金集計SQLは参照しないため ci-billing-schema.sh には含まれていない。
  "src/api/admin/tenants/migration_tenant_features.sql"
  # conversation_evaluations ベーステーブル(tuning_rules の後続migrationがこの
  # テーブルへも ALTER するため、tuning_rules より先に存在させる必要がある)
  "src/agent/judge/migration_conversation_evaluations.sql"
  # tuning_rules ベーステーブル
  "src/api/admin/tuning/migration.sql"
  # tuning_rules.source / evidence / approved_at / rejected_at
  # (POST /v1/hermes-mcp/proposals が INSERT する列 + GET が読む列)
  "src/agent/judge/migration_tuning_rules_judge.sql"
  # tuning_rules.status(承認判断の記録。D8で is_active との不変条件を規定)。
  # 同ファイルが conversation_evaluations.outcome 系にも ALTER するため、
  # 上の conversation_evaluations ベーステーブルより後に置く。
  "src/api/admin/evaluations/migration_kpi_outcome.sql"
  # tuning_rules.dedup_key(Hermes提案の冪等キー。GET /proposals が読む)
  "src/api/hermes-mcp/migration_hermes_dedup_key.sql"
  # tuning_rules.approved_responses / original_text・edited_by・edited_at。
  # 単体では hermes-mcp の検証に不要だが、直後の phase75(重複行の DELETE)が
  # これらの列を ORDER BY に使うため、先に存在させる必要がある。
  "src/api/admin/tuning/migration_approved_responses.sql"
  "src/api/admin/tuning/migration_add_edit_tracking.sql"
  # uniq_tuning_rules_tenant_trigger (tenant_id, trigger_pattern)。
  # ★アップセル提案の 23505 経路がここでしか実証できない★ — POST /proposals の
  # ON CONFLICT は (tenant_id, dedup_key) しか見ないため、dedup_key が違って
  # trigger_pattern が同じだと一意制約違反が投げっぱなしになる。
  # モックDBでは「code:'23505' を投げたら duplicate を返す」までしか確認できず、
  # 実際にこの制約が張られているかは検証できない。
  "src/migrations/phase75_tuning_rules_unique.sql"
  # tuning_rules.proposal_type + D8-2 の CHECK 制約(upsell は is_active を立てられない)。
  # ★アップセル提案が本番プロンプトへ混入しないことの唯一の砦★
  # コード側3箇所(approve/reject/updateRule)の分岐が漏れても、この制約が
  # 23514 で弾く。その効き目は実 Postgres でしか確認できない。
  "src/api/admin/tuning/migration_proposal_type.sql"
  # chat_sessions / chat_messages(searchConversationsの候補セッション取得。
  # ci-billing-schema.sh で既に作成済みだが、本スクリプト単体実行時にも
  # 動く冪等な安全網として明示する)
  "src/api/admin/chat-history/migration.sql"
  # chat_sessions.visitor_id(searchConversationsのSELECT列。R12のページ行動結合に使う)
  "src/api/admin/chat-history/migration_visitor_id.sql"
  # chat_sessions.is_escalated(searchConversationsのSELECT列)
  "src/api/admin/chat-history/migration_escalation.sql"
  # chat_sessions.prompt_variant_id / prompt_variant_name(searchConversationsのSELECT列)
  "src/agent/ab-test/migration_prompt_variants.sql"
  # chat_sessions.outcome(searchConversationsのSELECT列)
  "src/api/admin/conversion/migration_conversion_types.sql"
  # conversion_attributions(searchConversationsが常に結合するテーブル。
  # ci-billing-schema.sh のコメントが明言するとおり billing 専用スコープ外の
  # ため、そちらには含まれていない)
  "src/api/conversion/migration_conversion_attributions.sql"
  # notifications: POST /v1/hermes-mcp/proposals が createNotification() 経由で
  # INSERT する(createNotification自体は失敗を握り潰すfire-and-forgetのため
  # 無くてもPOSTの成否には影響しないが、無いと毎回42P01のエラーログが出て
  # テスト出力を汚す。実配線に忠実にするためテーブルを用意する)。
  "src/api/admin/notifications/migration_notifications.sql"
  # faq_embeddings ベーステーブル(vector拡張の CREATE EXTENSION も含む)。
  # PUT /v1/admin/knowledge/book-pdf/chunks/:chunkId の楽観ロック(CASのUPDATE
  # WHERE句)を実Postgresで検証するために必要。
  "docs/sql/0002_faq_embeddings_pgvector.sql"
  # book_uploads ベーステーブル。PUTハンドラの
  # `JOIN book_uploads bu ON bu.id = (fe.metadata->>'book_id')::int` が要求する。
  # ★2つある book_uploads 作成migrationのうちこちらを採用★
  # src/migrations/phase44_book_uploads.sql という別バージョンも存在するが、
  # gitログ上こちらのファイル(2026-03-25)の方が phase44_book_uploads.sql
  # (2026-05-28)より先に追加されており、実際に本番へ最初に適用されたのは
  # こちら(CREATE TABLE IF NOT EXISTS のため、後追いの phase44版を流しても
  # 本番のテーブル定義は変わらない)。CIのスキーマを本番の積み上げ順に揃える。
  "src/api/admin/knowledge/migration_book_uploads.sql"
  # book_uploads.content_type 等(Phase50)。PUTハンドラ自体は参照しないが、
  # 本番の積み上げ順どおりに適用する。
  "src/api/admin/knowledge/migration_book_schema.sql"
)

for f in "${FILES[@]}"; do
  echo "=== applying ${f} ==="
  psql -v ON_ERROR_STOP=1 -1 "${DATABASE_URL}" -f "${f}"
done

# faq_embeddings.is_excluded_from_search(PUTハンドラのSELECTが読む列)。
# ci-billing-schema.sh の tenant_contact_email と同じ理由で、ファイル全体では
# なく列だけを個別に当てる: 実際の migration ファイル
# (src/migrations/phase69_2_excluded_ids.sql)は同じトランザクションで
# faq_docs・tenants にも ALTER するが、faq_docs はこのリポジトリに
# CREATE TABLE の migration ファイルが存在せず(本番では本スクリプトの
# 対象外の経路で作成済み)、ここに無い状態でファイル全体を流すと
# 42P01(relation "faq_docs" does not exist)で丸ごと失敗する。
echo "=== applying faq_embeddings.is_excluded_from_search (from phase69_2_excluded_ids.sql) ==="
psql -v ON_ERROR_STOP=1 -1 "${DATABASE_URL}" -c \
  "ALTER TABLE faq_embeddings ADD COLUMN IF NOT EXISTS is_excluded_from_search BOOLEAN DEFAULT FALSE;"
psql -v ON_ERROR_STOP=1 -1 "${DATABASE_URL}" -c \
  "CREATE INDEX IF NOT EXISTS idx_faq_embeddings_excluded ON faq_embeddings (tenant_id, is_excluded_from_search) WHERE is_excluded_from_search = true;"

echo "✅ hermes-mcp schema bootstrap complete"
