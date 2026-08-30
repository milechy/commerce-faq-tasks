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
)

for f in "${FILES[@]}"; do
  echo "=== applying ${f} ==="
  psql -v ON_ERROR_STOP=1 -1 "${DATABASE_URL}" -f "${f}"
done

echo "✅ hermes-mcp schema bootstrap complete"
