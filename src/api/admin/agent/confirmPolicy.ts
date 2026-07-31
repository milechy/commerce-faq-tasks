// src/api/admin/agent/confirmPolicy.ts
//
// 書き込み系ツールのリスク階層表（単一の情報源）。
//
// 【現時点での役割】
// このモジュールは「分類」だけを行い、確認（confirmed）ゲートの挙動は一切変えない。
// requiresConfirmation() は階層に関わらず常に true を返す。低リスクなら確認を省く、
// といった緩和はプロダクト判断が済んでいないため実装しない（将来の別タスク）。
//
// 【いま置く理由】
// 1. リスク階層の判断を1か所に集約し、レビュー可能な形で残す。
// 2. toolDefinitions.ts に新しいツールが追加されたのに未分類のまま、という
//    取りこぼしを confirmPolicy.test.ts が機械的に検出できるようにする。
//    （この表は「網羅」が価値なので、読み取り専用ツールも NON_WRITE_TOOLS に
//    明示列挙し、全ツールがどちらかに属することをテストで保証する）

export type RiskTier = 'low' | 'medium' | 'high';

// 階層の定義:
//   low    … 単一の設定値/フラグの切り替え。コンテンツの生成も破棄もせず、
//            元の値を入れ直せば完全に元の状態へ戻る。
//   medium … 永続コンテンツ（顧客が目にしうる実体）を作成・変更する。
//            原理的には戻せるが、内容を作り直す必要がある。
//   high   … 永続データを不可逆に破棄する / 課金が発生する /
//            エンドユーザーや外部システムへ何かを送出する。
export const WRITE_TOOL_RISK_TIERS: Record<string, RiskTier> = {
  // --- low: 設定値・フラグの切り替え ---
  set_ga4_id: 'low',
  set_posthog: 'low',
  set_widget_theme: 'low',
  activate_avatar: 'low',
  // 同じ is_active フラグを倒すだけで、activate_avatar で元に戻せる。
  // 顧客の画面からアバターが消えるが、コンテンツは失われないため activate と同じ階層。
  deactivate_avatar: 'low',
  // 社内向け分析レコードのステータス変更のみ。顧客影響なし・再度拾い直せる。
  dismiss_knowledge_gap: 'low',

  // --- medium: 永続コンテンツの作成・変更 ---
  add_faq: 'medium',
  update_faq: 'medium',
  // 既定見本の自テナントへの複製。is_active=false で作るため公開はされないが、
  // 永続レコードを作成する点は add_faq と同じ階層。
  adopt_avatar_preset: 'medium',
  save_faq: 'medium',
  commit_faq_import: 'medium',
  import_industry_faq_templates: 'medium',
  save_tuning_rule: 'medium',
  update_tuning_rule: 'medium',
  save_engagement_rule: 'medium',
  update_engagement_rule: 'medium',
  // 名前からは設定変更に見えるが、採用した文面はそのまま顧客への回答に使われる。
  // remove_approved_response で戻せるものの、文面の作り直しが必要なため medium。
  approve_tuning_rule_response: 'medium',
  // 採用済み文面の削除。対象は配列の1要素で approve_ し直せるが、
  // 元の文面自体は失われるため low ではなく medium に置く。
  remove_approved_response: 'medium',

  // --- high: 不可逆な破棄 / 課金 / 外部送出 ---
  delete_faq: 'high',
  delete_tuning_rule: 'high',
  delete_engagement_rule: 'high',
  // 顧客の画面に有人返信として表示される（取り消し手段がない）。
  reply_to_escalation: 'high',
  // 返信待ちの顧客対応を打ち切りエスカレーション一覧から外す。状態変更ではあるが
  // 待たせている顧客が取りこぼされる影響が大きいため保守的に high。
  resolve_escalation: 'high',
  // 外部エージェント(Sai)へのタスク投入 + 従量課金が発生する。
  request_sai_task: 'high',
};

// 書き込みを伴わないツール。DBへの書き込みも外部への副作用のある送出も行わない。
// （網羅性テストのために明示列挙する。新規ツールはここか上の表のどちらかへ必ず追加する）
export const NON_WRITE_TOOLS: readonly string[] = [
  'get_tenant_settings',
  'get_faq_list',
  'get_avatar_status',
  'get_avatar_list',
  'suggest_avatar_preset',
  'get_embed_code',
  'get_tuning_rules',
  'get_weekly_briefing',
  'get_knowledge_gaps',
  'get_engagement_rules',
  'get_chat_sessions',
  'get_chat_session_messages',
  'get_conversation_evaluation',
  'get_escalations',
  'get_monitoring_summary',
  'get_sai_task_status',
  'get_legacy_ui_link',
  'get_analytics_summary',
  'get_conversion_summary',
  // suggest_* / generate_* はLLMを呼ぶため課金は発生するが、永続化はしない下書き生成。
  'suggest_tuning_rule',
  'suggest_faq',
  'suggest_engagement_rule',
  'generate_tuning_rule_test_responses',
  // 一括取り込みのプレビュー。結果は knowledgeImportStaging のプロセス内Mapに
  // 一時保存されるだけで、DBへは commit_faq_import まで何も書かない。
  // from_urls は外部URLへGETするが、相手側を変更しない読み取りアクセス。
  'suggest_faq_import_from_text',
  'suggest_faq_import_from_urls',
  // 上記プレビューのプロセス内Mapを消すだけ（DBは触らない）。
  'discard_faq_import',
];

/**
 * このツールが確認（confirmed）ゲートの対象かどうか。
 *
 * 現時点では分類済みの書き込みツールすべてに対して階層を問わず true を返す
 * （挙動不変が本モジュール導入時の要件）。tier を参照した緩和は意図的に未実装。
 *
 * 未分類のツール名は黙って false に倒さず例外にする。これにより
 * 「新しい書き込みツールを追加したが分類し忘れた」を実行時・テスト時に検出できる。
 */
export function requiresConfirmation(toolName: string): boolean {
  if (!(toolName in WRITE_TOOL_RISK_TIERS)) {
    throw new Error(`Unclassified write tool: ${toolName}`);
  }
  return true;
}
