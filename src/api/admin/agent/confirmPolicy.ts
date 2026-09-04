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
  // update_allowed_originsとは異なりmediumではなくlow: サーバ側の認可判定には
  // 一切関与しない(クライアントサイドでウィジェットをマウントしないだけ)。
  // 0件=「除外なし・全ページ表示」が安全な既定状態であり、allowed_originsのような
  // fail-open/closedの非対称も無い。単一の設定値・元に戻せば完全に元の状態へ戻る。
  update_excluded_page_patterns: 'low',
  // 顧客には表示されない、店主自身のFAQ登録フォームの入力支援文言。set_ga4_id/set_posthog
  // と同じ性質(単一の設定値、元の値を入れ直せば完全に戻る、外部送出も課金も無い)。
  set_faq_hints: 'low',
  activate_avatar: 'low',
  // 同じ is_active フラグを倒すだけで、activate_avatar で元に戻せる。
  // 顧客の画面からアバターが消えるが、コンテンツは失われないため activate と同じ階層。
  deactivate_avatar: 'low',
  // activate_avatar と同じくフラグ(tenants.features.avatar)を倒すだけで、
  // 再度trueにすれば元に戻せる。
  set_avatar_feature: 'low',
  // 社内向け分析レコードのステータス変更のみ。顧客影響なし・再度拾い直せる。
  dismiss_knowledge_gap: 'low',
  // recommendation_statusの承認状態を倒すだけで、FAQは作らない・顧客への露出も
  // 発生しない(dismiss_knowledge_gapと同じくrecommendation_status列の変更のみ)。
  // 再度dismissすれば戻せる。
  approve_gap_recommendation: 'low',

  // --- medium: 永続コンテンツの作成・変更 ---
  add_faq: 'medium',
  update_faq: 'medium',
  // 承認済みギャップからFAQを作成し is_published=true で公開する。add_faqと同じ
  // 「永続コンテンツをそのまま公開する」操作(delete_faqのような不可逆ではなく、
  // 作成後は他のFAQと同様にupdate_faq/delete_faqで訂正・削除できる)。
  add_knowledge_from_gap: 'medium',
  // 既定見本の自テナントへの複製。is_active=false で作るため公開はされないが、
  // 永続レコードを作成する点は add_faq と同じ階層。
  adopt_avatar_preset: 'medium',
  // ゼロからの新規作成。is_active=false で作るため公開はされないが、永続レコードを
  // 作成する点はadopt_avatar_presetと同じ階層。
  create_avatar_config: 'medium',
  // 名前・性格・話し方という顧客が接する内容そのものの変更。update_faq と同じ階層。
  update_avatar_profile: 'medium',
  // 既定値への戻しは1操作で完結し、対象も既定の見本に限られるが、顧客が接する
  // 内容（名前・声・性格）を書き換える点は update_avatar_profile と同じ階層。
  reset_avatar_to_default: 'medium',
  save_faq: 'medium',
  commit_faq_import: 'medium',
  import_industry_faq_templates: 'medium',
  // 公開は is_published=false に戻せるため high ではなく medium。
  // ただし顧客の目に触れる内容を公開する操作のため low ではない。
  publish_faq_drafts: 'medium',
  // 顧客の目に触れる内容の公開状態を変える点で publish_faq_drafts と同じ階層。
  // is_published を戻せば元に戻る(delete_faq のような不可逆ではない)。
  set_faq_published: 'medium',
  // set_faq_publishedの複数件版。同じ理由(is_publishedを戻せば元に戻る)でmedium。
  bulk_unpublish_faqs: 'medium',
  // 追加・削除いずれも1件戻せば元に戻る点はlowの定義を満たすが、Widget埋め込みの
  // セキュリティ境界(CORS/オリジン許可)を直接変える操作であり、かつ最後の1件を
  // 削除すると fail-open(全ドメイン許可)に倒れる非対称性がある(originCheck.ts)。
  // set_faq_published と同じ「reversibleだが顧客への露出に影響する」理由でmedium。
  update_allowed_origins: 'medium',
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
  // 会話セッションの成果(コンバージョン結果)記録。永続コンテンツの変更だが、
  // 再記録すれば戻せるため medium。
  record_session_outcome: 'medium',
  // カテゴリ別ペルソナ(見た目・話し方・声)の保存。顧客が話題を変えた瞬間に
  // アバターの見た目が変わる、顧客が直接目にする永続コンテンツ。同じカテゴリで
  // 再保存すれば上書きで戻せるため save_tuning_rule と同じ medium。
  save_category_persona: 'medium',
  // 外部Hermes VPSへの生データ提供同意(単一フラグ)。set_avatar_feature と同じ
  // 「フラグを入れ直せば戻せる」形だが、OFFへ戻しても既に提供済みの過去データは
  // 取り消せない非対称性があり、low の定義(完全に元の状態へ戻る)を満たさない。
  // かつ社外(Hermes VPS)への継続的なデータ提供を開始させる操作のため、
  // high(不可逆な破棄・課金・外部送出)ほどではないが low より一段重い medium に置く。
  set_hermes_consent: 'medium',

  // --- high: 不可逆な破棄 / 課金 / 外部送出 ---
  delete_faq: 'high',
  // delete_faqの複数件版。同じ不可逆な破棄でhigh。
  bulk_delete_faqs: 'high',
  delete_tuning_rule: 'high',
  // アバター設定の完全削除。不可逆な破棄で delete_faq と同じ階層。稼働中(is_active)の
  // 設定は削除できない制約があるため、顧客画面からアバターが消える経路そのものは
  // このツール単体では発生しない(delete_avatar_config: 実行前チェックを参照)。
  delete_avatar_config: 'high',
  delete_engagement_rule: 'high',
  // 会話セッションの完全削除。不可逆な破棄(audit_logsに理由付きで残るのみ)。
  delete_chat_session: 'high',
  // 顧客の画面に有人返信として表示される（取り消し手段がない）。
  reply_to_escalation: 'high',
  // 返信待ちの顧客対応を打ち切りエスカレーション一覧から外す。状態変更ではあるが
  // 待たせている顧客が取りこぼされる影響が大きいため保守的に high。
  resolve_escalation: 'high',
  // 外部エージェント(Sai)へのタスク投入 + 従量課金が発生する。
  request_sai_task: 'high',
  // CP-3(GID 1218086647623729): 課金額が変わる操作(高階層の定義「課金が発生する」に該当)。
  // 降格時はfeaturesも失うため、request_sai_taskと同じhighに置く。
  change_my_plan: 'high',
  // CP-3: 直接課金は発生しないが、Stripe Checkoutという外部システムへユーザーを
  // 送出しカード情報の入力に進ませる操作(highの定義「外部システムへ何かを送出する」に該当)。
  start_billing_checkout: 'high',
};

// 書き込みを伴わないツール。DBへの書き込みも外部への副作用のある送出も行わない。
// （網羅性テストのために明示列挙する。新規ツールはここか上の表のどちらかへ必ず追加する）
export const NON_WRITE_TOOLS: readonly string[] = [
  // 誤答の是正: 層を判定して既存の save_faq / suggest_tuning_rule へ繋ぐだけ。
  // 自身は一切書き込まないため NON_WRITE。書き込みは繋いだ先の確認ゲートが守る。
  'suggest_answer_correction',
  'get_tenant_settings',
  'get_faq_list',
  'get_avatar_status',
  'get_avatar_list',
  'suggest_avatar_preset',
  'get_category_personas',
  'suggest_category_persona',
  'get_embed_code',
  // GID 1218167820775294 (L3-1a): 現在の設置位置を提示するだけで何も書き込まない。
  'get_widget_placement',
  'get_tuning_rules',
  'get_weekly_briefing',
  'get_knowledge_gaps',
  'get_engagement_rules',
  'get_chat_sessions',
  'get_chat_session_messages',
  'get_session_outcome',
  'get_conversation_evaluation',
  'get_escalations',
  'get_monitoring_summary',
  'get_sai_task_status',
  'get_legacy_ui_link',
  'get_analytics_summary',
  'get_analytics_trend',
  'get_conversion_summary',
  'get_ab_test_results',
  'get_knowledge_attribution',
  'get_billing_summary',
  'get_tuning_rule_effect',
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
