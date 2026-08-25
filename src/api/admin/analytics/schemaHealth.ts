// src/api/admin/analytics/schemaHealth.ts
// 本番スキーマとコードのズレを検知する。
//
// なぜ measurementHealth.ts に入れないか:
//   measurementHealth は「計測データの健全性」(母数・結合率・記録率)を見るもので、
//   本ファイルは「スキーマの整合」を見る。混ぜると母数の話と配線の話が同じ関数に入る。
//   レスポンスは同じ measurement-health エンドポイントに合流させるが、算出は分ける。
//
// なぜ必要か (2026-08-24 の実例):
//   chat_sessions.visitor_id が本番未適用のまま、配備コードが無条件に INSERT していた。
//   saveMessage は fire-and-forget なので **客には答えが返り、記録だけが無言で落ちた**。
//   500 も出ずログにも残らないため、監査でしか見つからなかった。
//   同時に faq_docs.product_* の未適用で URL取得タブが1件も保存できていなかった。
//   既存のスキーマ↔コード整合テスト(evaluationAnalyzer.test.ts 等)は
//   **migration ファイルの文字列**を読むだけで、本番に適用されたかは見ていない。
//
// レジストリが腐らない理由:
//   REQUIRED_COLUMNS は手書きではなく、schemaHealth.test.ts が src/**/*.ts の
//   `INSERT INTO <table> (cols)` を走査して**完全一致**を強制する。
//   INSERT に列を足してレジストリを更新し忘れるとテストが落ちる。
//   これは confirmPolicy.test.ts と同じ流儀(手で守らせない)。
//   落ちたら「レジストリに足す」だけでなく、**その列の migration が存在し
//   DEPLOY_CHECKLIST.md に載っているか**を必ず確認すること。

import type { Pool } from "pg";

/** 既存の analytics 層と同じ最小インターフェース(measurementHealth.ts / summaryQueries.ts に倣う)。 */
type Db = Pick<Pool, "query">;

/** コードが INSERT で要求する列。schemaHealth.test.ts がソース走査で同期を強制する。 */
export const REQUIRED_COLUMNS: Record<string, readonly string[]> = {
  ab_experiments: ["min_sample_size", "name", "tenant_id", "traffic_split", "variant_a", "variant_b"],
  ab_results: ["converted", "experiment_id", "session_id", "variant"],
  admin_feedback: ["ai_answered", "ai_response", "category", "message", "parent_feedback_id", "priority", "tenant_id", "user_email"],
  audit_logs: ["action", "actor_email", "actor_role", "metadata", "target_id", "target_type", "tenant_id"],
  avatar_configs: ["agent_idle_prompt", "agent_prompt", "anam_avatar_id", "anam_llm_id", "anam_persona_id", "anam_voice_id", "avatar_provider", "behavior_description", "default_name", "default_personality_prompt", "default_template_id", "default_voice_id", "emotion_tags", "image_prompt", "image_url", "is_active", "is_default", "lemonslice_agent_id", "name", "personality_prompt", "tenant_id", "voice_description", "voice_id"],
  behavioral_events: ["event_data", "event_type", "page_url", "referrer", "session_id", "tenant_id", "visitor_id"],
  billing_adjustments: ["adjusted_by", "amount", "reason", "tenant_id"],
  book_pipeline_jobs: ["book_id", "enqueued_at", "status"],
  book_uploads: ["encryption_iv", "file_size_bytes", "original_filename", "storage_path", "tenant_id", "title", "uploaded_by"],
  chat_messages: ["content", "metadata", "rag_sources", "role", "session_id", "tenant_id"],
  chat_sessions: ["last_message_at", "message_count", "metadata", "prompt_variant_id", "prompt_variant_name", "session_id", "tenant_id", "visitor_id"],
  conversation_evaluations: ["customer_reaction_score", "effective_principles", "evaluation_axes", "failed_principles", "feedback", "judge_model", "message_count", "model_used", "notes", "psychology_fit_score", "score", "session_id", "stage_progress_score", "suggested_rules", "taboo_violation_score", "tenant_id", "used_principles"],
  conversation_flow_logs: ["from_state", "metadata", "session_id", "tenant_id", "to_state", "turn_index"],
  conversion_attributions: ["conversion_type", "conversion_value", "created_at", "deduplicated_at", "event_id", "event_type", "message_count", "psychology_principle_used", "sales_stage_at_conversion", "session_duration_sec", "session_id", "source", "temp_score_at_conversion", "tenant_id", "trigger_rule_id", "trigger_type"],
  faq_docs: ["answer", "category", "is_published", "product_cta_url", "product_image_url", "product_price", "question", "tags", "tenant_id"],
  faq_embeddings: ["embedding", "is_excluded_from_search", "metadata", "tenant_id", "text"],
  feedback_messages: ["content", "sender_email", "sender_role", "tenant_id"],
  knowledge_gaps: ["detection_source", "frequency", "last_detected_at", "message_id", "rag_hit_count", "rag_top_score", "recommendation_status", "session_id", "tenant_id", "user_question"],
  learned_memory: ["answer", "embedding", "judge_score", "metadata", "question", "source_session_id", "tenant_id"],
  // 月額固定費の按分課金・冪等性テーブル(migration_lemonslice_monthly.sql)。
  // 未適用のまま _chargeMonthlyFixedShare が動くと INSERT が失敗し、按分請求が送れない。
  lemonslice_monthly_charges: ["amount_jpy", "period_yyyymm", "tenant_count", "tenant_id"],
  // LiveKit(Shipプラン)月額固定費の按分・冪等性テーブル(migration_livekit_monthly.sql)。
  livekit_monthly_charges: ["amount_jpy", "period_yyyymm", "tenant_count", "tenant_id"],
  metrics_snapshots: ["labels", "metric_name", "tenant_id", "value"],
  notification_preferences: ["email_enabled", "in_app_enabled", "notification_type", "tenant_id", "threshold"],
  notifications: ["link", "message", "metadata", "recipient_role", "recipient_tenant_id", "title", "type"],
  objection_patterns: ["principle_used", "response_strategy", "sample_count", "source", "success_rate", "tenant_id", "trigger_phrase", "updated_at"],
  option_orders: ["chat_session_id", "description", "llm_estimate_amount", "status", "tenant_id", "type"],
  // プラットフォーム共通費(Supabase/Cloudflare/Hetzner/ES)の按分・冪等性テーブル
  // (migration_platform_monthly.sql)。
  platform_monthly_charges: ["amount_jpy", "period_yyyymm", "tenant_count", "tenant_id"],
  sai_task_rules: ["created_by", "evidence", "expected_behavior", "priority", "source", "tenant_id", "trigger_pattern"],
  sai_tasks: ["description", "order_id", "requested_by", "task_id", "tenant_id"],
  // billed_quantity は migration_stripe_usage_reports_billed_quantity.sql で追加。
  // 未適用のままだと INSERT が全滅し、月次請求が本番で一切送信できなくなる。
  stripe_usage_reports: ["billed_quantity", "idempotency_key", "period_yyyymm", "tenant_id", "total_cost_cents", "total_requests"],
  stripe_webhook_events: ["claimed_at", "event_id", "event_type"],
  tenant_api_keys: ["expires_at", "is_active", "key_hash", "key_prefix", "tenant_id"],
  tenant_settings_history: ["changed_by", "field_name", "new_value", "old_value", "tenant_id"],
  tenants: ["id", "is_active", "name", "plan"],
  trigger_rules: ["is_active", "message_template", "priority", "tenant_id", "trigger_config", "trigger_type"],
  tuning_rules: ["approved_at", "created_by", "dedup_key", "edited_at", "edited_by", "evidence", "expected_behavior", "is_active", "original_text", "priority", "source", "source_message_id", "status", "suggested_at", "tenant_id", "trigger_pattern"],
  // plan / plan_multiplier は migration_usage_logs_plan_snapshot.sql で追加。
  // 未適用のまま配備すると usage_logs への INSERT が全滅する（= 利用記録も請求も止まる）ため、
  // 計測ヘルスで欠落を検知できるようレジストリに載せる。
  usage_logs: ["anam_session_seconds", "avatar_credits", "avatar_session_ms", "billable", "cost_llm_cents", "cost_total_cents", "feature_used", "input_tokens", "model", "output_tokens", "plan", "plan_multiplier", "request_id", "tenant_id", "tts_text_bytes"],
};

export interface MissingColumn {
  table: string;
  /** 実行中のDBに存在しない列。テーブルごと欠落している場合は requiredColumns 全件。 */
  columns: string[];
  /** テーブル自体が存在しないか */
  tableMissing: boolean;
}

export interface SchemaHealthResponse {
  /** 欠落なしなら空配列。空であることが正常。 */
  missing: MissingColumn[];
  checkedTables: number;
  checkedColumns: number;
}

/**
 * 実DBの列一覧と要求列を突き合わせる純関数。
 * actual は「テーブル名 -> 列名の集合」。DB アクセスは呼び出し側が行う。
 */
export function findMissingColumns(
  actual: Map<string, Set<string>>,
  required: Record<string, readonly string[]> = REQUIRED_COLUMNS,
): MissingColumn[] {
  const missing: MissingColumn[] = [];
  for (const [table, cols] of Object.entries(required)) {
    const have = actual.get(table);
    if (!have) {
      missing.push({ table, columns: [...cols], tableMissing: true });
      continue;
    }
    const lacking = cols.filter((c) => !have.has(c));
    if (lacking.length > 0) {
      missing.push({ table, columns: lacking, tableMissing: false });
    }
  }
  return missing;
}

/** information_schema を1回引いて欠落列を返す。欠落なしが正常。 */
export async function fetchSchemaHealth(db: Db): Promise<SchemaHealthResponse> {
  const tables = Object.keys(REQUIRED_COLUMNS);
  const rows = await db.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [tables],
  );

  const actual = new Map<string, Set<string>>();
  for (const r of rows.rows) {
    const set = actual.get(r.table_name) ?? new Set<string>();
    set.add(r.column_name);
    actual.set(r.table_name, set);
  }

  return {
    missing: findMissingColumns(actual),
    checkedTables: tables.length,
    checkedColumns: Object.values(REQUIRED_COLUMNS).reduce((n, c) => n + c.length, 0),
  };
}
