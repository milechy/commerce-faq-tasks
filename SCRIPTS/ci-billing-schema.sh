#!/usr/bin/env bash
# SCRIPTS/ci-billing-schema.sh
#
# 課金集計SQL(computeExpectedBilling)の実行に必要な最小限のテーブル
# (tenants / usage_logs / stripe_subscriptions / stripe_usage_reports)を、
# 使い捨てPostgresへ「実際のmigrationファイル」を順番に適用して作る。
#
# ★スコープを限定している理由★
# このリポジトリには74本超の migration*.sql があり、それらを「全部・正しい順序で」
# 適用する仕組みはこのリポジトリ自体に存在しない(本番は人間が個別に確認しながら
# 順次適用する運用。CLAUDE.md 禁止8)。依存関係が file 名のアルファベット順とは
# 一致しない箇所があり(例: CHECK制約を DROP+ADD で丸ごと置き換える migration が
# 複数あり、後から適用したものが常に「正」になる)、"全 migration を機械的に流す"
# 仕組みを急いで作ると「CIのスキーマは動くが本番の積み上げ履歴とは違う」という、
# このプロジェクトが繰り返し踏んできた事故(visitor_id・URL取得タブ・
# plan_multiplier)と同じ種類の誤った安心を生みかねない。
#
# そのため、ここでは「課金集計SQLが参照するテーブルだけ」を対象に絞り、
# 各ファイルの適用順序は git のコミット履歴(実際に本番へ適用されていった順序)を
# 手作業で確認して固定した。適用順の根拠は各行のコメントを参照。
# 全migration対応は将来の別課題とする。
#
# 使い方:
#   DATABASE_URL=postgres://... bash SCRIPTS/ci-billing-schema.sh
#
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "❌ DATABASE_URL is not set" >&2
  exit 1
fi

# 適用順序は `git log --diff-filter=A --format="%ai" -- <file>` で確認した
# 実際の追加日時の昇順。CHECK制約系(check_constraint / sai_agent_feature /
# admin_tooling_feature)は DROP+ADD で丸ごと置き換える設計のため、
# 最後に適用したものの内容が最終形になる。
FILES=(
  # tenants ベーステーブル(plan列を含む)
  "src/api/admin/tenants/migration.sql"
  # usage_logs / stripe_subscriptions / stripe_usage_reports ベーステーブル
  "src/lib/billing/migration.sql"
  # tenants.billing_enabled / billing_free_until
  "src/api/admin/tenants/migration_billing.sql"
  # tenants.billing_free_from(Phase39b。別ファイルで後追い追加されており、
  # 実際に流すまで見落としていた欠落。手書きスキーマではなく本物のmigration
  # ファイルを適用する方式にした価値そのもの)
  "src/api/admin/tenants/migration_billing_free_from.sql"
  # usage_logs.feature_used CHECK 制約(DROP+ADDで置き換わっていく。適用順は
  # 追加日時どおりで、最後の admin_tooling_feature.sql が最終形)
  "src/lib/billing/migration_check_constraint.sql"
  "src/lib/billing/migration_sai_agent_feature.sql"
  "src/lib/billing/migration_admin_tooling_feature.sql"
  # usage_logs.billable
  "src/lib/billing/migration_usage_logs_billable_flag.sql"
  # tenants.plan の CHECK 制約に free_ad を追加
  "src/api/admin/tenants/migration_free_ad_plan.sql"
  # usage_logs.plan / plan_multiplier(#920)
  "src/lib/billing/migration_usage_logs_plan_snapshot.sql"
  # stripe_usage_reports.billed_quantity(#936)
  "src/lib/billing/migration_stripe_usage_reports_billed_quantity.sql"
)

for f in "${FILES[@]}"; do
  echo "=== applying ${f} ==="
  psql -v ON_ERROR_STOP=1 -1 "${DATABASE_URL}" -f "${f}"
done

echo "✅ billing schema bootstrap complete"
