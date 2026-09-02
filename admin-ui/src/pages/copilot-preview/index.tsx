// admin-ui/src/pages/copilot-preview/index.tsx
//
// 【プロトタイプ / 追加専用】テナント向けチャット・ファースト管理画面のUX検証用ページ。
// 既存の管理画面(App.tsx の認証ルート群)には一切影響しない、認証ゲート外の隔離ルート。
//   URL: /copilot-preview
// サイドバー・自由入力欄とも、全て実際の R2Cエージェント API
// (POST /v1/admin/agent/chat)に接続されている。モックの固定シナリオは廃止済み。
// ログイン済みセッション(同一ブラウザの Supabase セッション)が必要。未ログインならその旨を案内する。
// テーマは既存の CSS 変数に追従(light/dark両対応)。

import { useState, useRef, useEffect, useCallback } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useNavigate } from "react-router-dom";
import { LogOut } from "lucide-react";
import { authFetch, API_BASE } from "../../lib/api";
// GID 1217084040141851: authFetchはContent-Type: application/jsonを強制するためmultipart不可。
// StudioVoiceCloneSection.tsx / PdfUploadTabと同じfetchWithAuth（Content-Type未設定=boundary自動付与）を使う。
import { fetchWithAuth } from "../../components/knowledge/shared";
import { isChatFirstDefaultEnabled, setChatFirstDefaultEnabled } from "../../lib/chatFirstDefault";
import {
  CHAT_SESSION_SURFACE_FULLSCREEN,
  clearChatSession,
  restoreChatSession,
  saveChatSession,
} from "../../lib/chatSessionStore";
import { priorityToTier } from "../../lib/tuningPriority";
import { hasShownTuningRuleIntro, markTuningRuleIntroShown } from "../../lib/tuningRuleIntro";
import {
  AGENT_CHAT_AUTH_REQUIRED_MESSAGE,
  AGENT_CHAT_HISTORY_MAX_ENTRIES,
  useAgentChatTransport,
} from "../../lib/useAgentChatTransport";
import type { AnsweredFrom, WeeklySummaryAgentActionCard, RuleEffectAgentActionCard, AnalyticsTrendAgentActionCard, AbTestResultsAgentActionCard, KnowledgeAttributionAgentActionCard, BillingSummaryAgentActionCard, FaqImportPreviewAgentActionCard, PlanChangedAgentActionCard } from "../../lib/useAgentChatTransport";
// アバター画像候補のプロンプト組み立ては旧UIウィザードと同じ関数を使う(再実装しない)。
// チャットは選択肢を集めないため、固定の標準的な選択で呼ぶ。
import { buildAvatarPrompt, type AvatarPromptInput } from "../../lib/buildAvatarPrompt";
// 相談窓口(担当者への相談 → 返信 → 解決確認)のループ。ポーリング・既読化・相談投稿は
// パネル(Surface A)と同じ実装を共有し(lib/feedbackReplies.ts)、見せ方だけこの面の
// カード/メッセージの作法に合わせる。
import { submitConsultation, useFeedbackReplies, type FeedbackReply } from "../../lib/feedbackReplies";
import { shouldSubmitOnEnter } from "../../lib/utils";
// PDF取り込みの受付ルール(拡張子/MIME/サイズ上限)と送信は旧UIのPDFタブと同じ実装を共有する。
// 同じ操作が2面にある状態なので、片方だけ条件が緩む/厳しくなることを避けるため。
import {
  classifyUploadStatus,
  defaultBookTitle,
  uploadBookPdfWithProgress,
  validateBookPdfFile,
  type BookPdfRejection,
} from "../../lib/bookPdfUpload";
import { getAccessToken } from "../../components/knowledge/shared";
import { useAuth, type OnboardingStageFlags } from "../../auth/useAuth";
import { ONBOARDING_INDUSTRIES } from "../../components/onboarding/industryFaqTemplates";
import { nextIncompleteStage } from "../../lib/landingDecision";
import { PREVIEW_MODE_BANNER_HEIGHT, PREVIEW_BANNER_HEIGHT_CSS_VAR } from "../../components/PreviewModeBanner";
// 旧UI(AppSidebar)の共通シェル機能パリティ(残り4件)。既に独立コンポーネント化
// 済みのものはそのままimportし、テーマ切替だけ common/ThemeToggle として新規に
// 切り出した(旧UIとの共有コンポーネント。詳細は common/ThemeToggle.tsx 参照)。
import { NotificationBell } from "../../components/common/NotificationBell";
import { ThemeToggle } from "../../components/common/ThemeToggle";
import LangSwitcher from "../../components/LangSwitcher";
import AppSwitcher from "../../components/AppSwitcher";
import AgentMarkdown from "../../components/markdown/AgentMarkdown";

// ─── モデル ──────────────────────────────────────────────────────────────────

type Category =
  | { key: string; label: string; icon: string; dim?: boolean; badge?: RailBadgeKind };

// 左レールのバッジに出す「何件あるか」の種別。旧ダッシュボードのstatカードが担っていた
// 一目での「対応が必要な件数」の把握を、チャットUIに戻すためのもの。
// 自然な件数が存在しないカテゴリー(アシスタント/指示ルール/アバター等)には付けない。
type RailBadgeKind = "gaps" | "escalations";

type RailCounts = Partial<Record<RailBadgeKind, number>>;

const RAIL_BADGE_LABEL: Record<RailBadgeKind, string> = {
  gaps: "未回答質問",
  escalations: "対応中の会話",
};

// GET /v1/admin/tenants(既存・super_admin限定)のうち、テナント選択に使う項目だけ
interface TenantOption {
  id: string;
  name: string;
}

type Card =
  | { kind: "faq"; question: string; answer: string; category: string }
  // priorityはcard経由(D6)の場合のみ入る。正規表現フォールバック時は未設定のまま。
  | { kind: "rule"; trigger: string; behavior: string; priority?: number }
  | { kind: "engagement"; when: string; message: string }
  | { kind: "success"; text: string }
  | { kind: "link"; label: string; url: string; description: string }
  | { kind: "agentAction"; tool: string; result: string }
  | { kind: "avatarPreset"; presetId: string; name: string; imageUrl: string | null; description: string }
  // adopt_avatar_preset / create_avatar_config の採用・作成直後カード。configId は
  // 自テナント側の avatar_configs.id(presetIdとは別物)で、以降の画像候補生成・採用は
  // すべてこのidを使う。avatarType以下はcreate_avatar_config(W3-4)由来のときのみ埋まり、
  // generateAvatarCandidates/generatePremiumAvatarCandidateがbuildAvatarPromptへの
  // 入力として使う。
  | {
      kind: "avatarAdopted";
      configId: string;
      name: string;
      imageUrl: string | null;
      description: string;
      avatarType?: "human" | "anime" | "3d" | "animal" | "robot";
      gender?: "male" | "female";
      age?: "20s" | "30s" | "40s" | "50s+";
      outfit?: "business_suit" | "casual" | "white_coat" | "uniform";
      animalKind?: "dog" | "cat" | "bird" | "bear" | "fox" | "other";
      animalVibe?: "cute" | "cool" | "silly";
      robotDesign?: "simple" | "mecha" | "scifi" | "cute";
    }
  // 画像候補の生成(POST /v1/admin/avatar/fal/generate)と採用(PATCH /configs/:id)を
  // チャット画面内で完結させるためのカード。生成はエージェントツール経由にしない
  // (画像URL群はツール結果の500字に収まらないため)。フロントから直接叩き、
  // タイムアウト・5xx・429いずれの失敗でも status="failed" で確定させる
  // (無限スピナーを残さない)。adoptedUrl は採用済みの1枚(二重採用の防止・ハイライト用)。
  // W3-3(docs/COPILOT_UI_PARITY.md §3.1 #10、T3 候補カード): premiumはPOST
  // /generate-premium(Flux 2 Pro + Magnific、1枚高品質)の結果。既存の候補+採用
  // (adoptAvatarCandidate/PATCH /configs/:id)をそのまま使えるため新しいカード種別は
  // 増やさず、images配列に1枚だけ入れて流用する。premiumはヘッダ・コスト文言の
  // 出し分けにのみ使う(採用の仕組みは標準生成と完全に同じ)。
  | {
      kind: "avatarCandidates";
      configId: string;
      name: string;
      status: "generating" | "done" | "failed";
      images?: string[];
      message?: string;
      adoptedUrl?: string;
      premium?: boolean;
      // W3-4: create_avatar_config(ゼロから作成)由来のavatarAdoptedカードから引き継いだ
      // 見た目の意思決定。「もう一度試す」「別の候補を見る」の再生成でも同じ見た目を
      // 保つために、カード自身にも複製して持たせる(avatarAdoptedカードは既に画面外に
      // 流れている可能性があるため、そこへ都度遡らない)。
      promptInput?: AvatarPromptInput;
    }
  // W3-1(docs/COPILOT_UI_PARITY.md §3.1 #8、T3 候補カード+添付): 自分の写真をアバター
  // 画像として使う。旧UI(StudioImageSection.tsx「写真をアップロード」タブ)の再現。
  // PDF取り込みと同じ理由でエージェントツール経由にしない(バイナリはツール結果に
  // 乗らない)。PATCH /v1/admin/avatar/configs/:id は image_url が data: URIなら
  // サーバ側(uploadBase64ToStorage)が自動でStorageへアップロードする既存経路を
  // そのまま使うため、新規APIエンドポイントは作らない(pdfUploadと同じ3状態の作法)。
  | {
      kind: "avatarPhotoUpload";
      configId: string;
      status: "uploading" | "success" | "error";
      fileName: string;
      imageUrl?: string;
      message?: string;
    }
  // 声の候補提示〜採用。POST /match-voice はテキストの候補(id/title/description/score)
  // のみを返し音声プレビューを持たないため(旧UIウィザードのStudioVoiceSectionも同様に
  // 試聴機能を持たない)、本カードも一覧から選ぶ形にする。description は再検索(もう一度
  // 探す)用に保持する。他の失敗系カードと同じく、必ず status="failed" で確定させる。
  // mode省略時は"match"（既存カードとの後方互換）。"design"はGID 1217084040141851:
  // 説明文から声を作る(Fish Audio Voice Design)。実音声が不要な点がmatchとの違い。
  // audioCandidatesはdesignのときだけ埋まり、recommendationsはmatchのときだけ埋まる。
  // W3-2(docs/COPILOT_UI_PARITY.md §3.1 #9): "clone"は旧UI(StudioVoiceCloneSection.tsx)の
  // 音声クローンの再現。match/designと異なり候補一覧を持たず、POST /voice-clone が
  // 単発でvoice_idを確定・保存するため、status="done"になった時点で既にadoptedVoiceId
  // が確定している(採用ボタンを経由しない)。新しいカード種別を機能ごとに増やさない方針
  // (Asana制約)のため、既存カードにmode追加のみで対応する。fileNameはcloneのときだけ使う。
  | {
      kind: "avatarVoiceCandidates";
      configId: string;
      description: string;
      status: "matching" | "done" | "failed";
      mode?: "match" | "design" | "clone";
      fileName?: string;
      recommendations?: Array<{ id: string; title: string; description: string; score: number }>;
      audioCandidates?: Array<{ id: string; audioBase64: string; text: string | null }>;
      message?: string;
      adoptedVoiceId?: string;
    }
  // D3: 一覧が15件・1行60/100字で黙って切れていたのを解消するための全件カード。
  | {
      kind: "rulesList";
      rules: Array<{
        id: number;
        triggerPattern: string;
        expectedBehavior: string;
        priority: number;
        isActive: boolean;
        // P4-1: 古い(このフィールドが無い)キャッシュ済み会話との後方互換のため任意。
        source?: string | null;
        status?: string | null;
        evidence?: {
          evaluationIds?: number[];
          effectivePrinciples?: string[];
          failedPrinciples?: string[];
          avgScore?: number;
        } | null;
      }>;
      totalCount: number;
    }
  // GUI固有だった操作(PDF取り込み)を旧UIへ渡さず会話の中で完結させる最初の1件。
  // 送信の進捗までしか追わない(取り込み完了までの追跡は旧UIのPDFタブが担当)ため、
  // 状態は「送っている / 受け取った / 受け取れなかった」の3つで足りる。
  | {
      kind: "pdfUpload";
      status: "uploading" | "success" | "error";
      fileName: string;
      progress?: number;
      message?: string;
    }
  // 会話一覧(get_chat_sessions)。短縮IDの手打ちを不要にするため、次の1件を選ぶ
  // チップ(sessionListSelectionChips)とセットで使う。
  | {
      kind: "chatSessionList";
      total: number;
      sessions: Array<{
        shortId: string;
        startedAt: string;
        messageCount: number;
        preview: string;
        outcome: string | null;
      }>;
    }
  // 会話本文(get_chat_session_messages)。role のラベルはサーバ側(CHAT_ROLE_LABELS)を
  // 単一の情報源とし、ここでは辞書を持たずそのまま描画する。
  // role(生の値)はP5-1で追加: AI応答の直後にのみ「この会話からルールを作る」
  // チップを出すための判定に使う(roleLabelは表示用の日本語で判定に使わない)。
  | {
      kind: "chatSessionMessages";
      shortId: string;
      totalMessages: number;
      messages: Array<{ role: string; roleLabel: string; content: string }>;
    }
  // P5-1: 知識ギャップ一覧(get_knowledge_gaps)。各行から「このギャップから
  // ルールを作る」チップに繋げる。
  | {
      kind: "knowledgeGapsList";
      gaps: Array<{ id: number; userQuestion: string; ragHitCount: number }>;
      totalCount: number;
    }
  // GID 1217972976609524 (H-5): suggest_faq_import_from_text / suggest_faq_import_from_urls
  // が返す、DB未登録のFAQ案一覧。フィールド形状は
  // FaqImportPreviewAgentActionCard(useAgentChatTransport.ts)と同一に保つ(weeklySummaryと同じ作法)。
  | ({ kind: "faqImportPreview" } & Omit<FaqImportPreviewAgentActionCard, "kind">)
  // AI品質評価(get_conversation_evaluation)。4軸ラベルはサーバ側で確定済みのものを
  // そのまま描画する(旧UIの JudgeEvaluationSection.tsx と同一語彙)。
  | {
      kind: "evaluation";
      shortId: string;
      overallScore: number;
      axes: Array<{ label: string; score: number | null }>;
      notes: string | null;
    }
  // 週次まとめ。数値はサーバ集計値をそのまま描画する(LLMの生成文を経由しない)。
  // 各グループが null なのは、対応するクエリが失敗し取得できなかった場合(0とは区別する)。
  // フィールド形状は WeeklySummaryAgentActionCard(useAgentChatTransport.ts)と同一に保つ
  // 必要があるため、kind(UI向けにcamelCaseへ変える)以外はそこから再利用し、手書きの
  // 二重定義を避ける。actionExecutor.ts の WeeklySummaryCardPayload とはサーバ/フロント
  // という境界を跨ぐため型を共有できないが、フィールド名・形は3箇所とも一致させること。
  | ({ kind: "weeklySummary" } & Omit<WeeklySummaryAgentActionCard, "kind">)
  // ルール効果(get_tuning_rule_effect)。フィールド形状は
  // RuleEffectAgentActionCard(useAgentChatTransport.ts)と同一に保つ必要があるため、
  // kind(UI向けにcamelCaseへ変える)以外はそこから再利用する(weeklySummaryと同じ作法)。
  | ({ kind: "ruleEffect" } & Omit<RuleEffectAgentActionCard, "kind">)
  // W2-4: 会話数の日次推移+低評価セッション。フィールド形状は
  // AnalyticsTrendAgentActionCard(useAgentChatTransport.ts)と同一に保つ(weeklySummaryと同じ作法)。
  | ({ kind: "analyticsTrend" } & Omit<AnalyticsTrendAgentActionCard, "kind">)
  // W2-5: A/Bテスト結果+改善提案。フィールド形状は
  // AbTestResultsAgentActionCard(useAgentChatTransport.ts)と同一に保つ(weeklySummaryと同じ作法)。
  | ({ kind: "abTestResults" } & Omit<AbTestResultsAgentActionCard, "kind">)
  // W2-6: ナレッジ別の成約貢献度。フィールド形状は
  // KnowledgeAttributionAgentActionCard(useAgentChatTransport.ts)と同一に保つ(weeklySummaryと同じ作法)。
  | ({ kind: "knowledgeAttribution" } & Omit<KnowledgeAttributionAgentActionCard, "kind">)
  // W2-7: ご利用状況・お支払い(閲覧専用)。フィールド形状は
  // BillingSummaryAgentActionCard(useAgentChatTransport.ts)と同一に保つ(weeklySummaryと同じ作法)。
  | ({ kind: "billingSummary" } & Omit<BillingSummaryAgentActionCard, "kind">)
  // CP-3(GID 1218086647623729): change_my_plan の実行後カード。フィールド形状は
  // PlanChangedAgentActionCard(useAgentChatTransport.ts)と同一に保つ(weeklySummaryと同じ作法)。
  | ({ kind: "planChanged" } & Omit<PlanChangedAgentActionCard, "kind">);

// 優先度3段階(lib/tuningPriority.ts)の店主向け表示ラベル。rule / rulesList カードで共有する。
const TIER_LABEL: Record<"low" | "normal" | "high", string> = { low: "低", normal: "普通", high: "高" };

// 自由入力欄からの実API呼び出しで使うツール名 → 日本語ラベル
const REAL_TOOL_LABEL: Record<string, string> = {
  suggest_answer_correction: "誤った回答の直し方を判定",
  get_weekly_briefing: "週次ブリーフィングの取得",
  suggest_tuning_rule: "指示ルールの下書き提案",
  save_tuning_rule: "指示ルールの保存",
  suggest_faq: "FAQの下書き提案",
  save_faq: "FAQの保存",
  suggest_engagement_rule: "声がけの下書き提案",
  save_engagement_rule: "声がけの保存",
  get_tenant_settings: "テナント設定の取得",
  set_ga4_id: "GA4設定の変更",
  set_posthog: "PostHog設定の変更",
  update_allowed_origins: "Widget埋め込み許可ドメインの変更",
  set_faq_hints: "FAQ入力例の設定",
  get_faq_list: "FAQ一覧の取得",
  add_faq: "FAQの追加",
  update_faq: "FAQの更新",
  delete_faq: "FAQの削除",
  set_faq_published: "FAQの公開状態の変更",
  bulk_unpublish_faqs: "FAQの一括非公開",
  bulk_delete_faqs: "FAQの一括削除",
  get_avatar_list: "アバター一覧の取得",
  activate_avatar: "アバターの有効化",
  deactivate_avatar: "アバターの停止",
  delete_avatar_config: "アバター設定の削除",
  set_avatar_feature: "アバター機能のON/OFF",
  set_hermes_consent: "学習同意(自社内学習/共有プール参加)のON/OFF",
  update_avatar_profile: "アバターの基本設定の更新",
  reset_avatar_to_default: "アバターを既定に戻す",
  suggest_avatar_preset: "アバター見本の提案",
  adopt_avatar_preset: "アバター見本の採用",
  create_avatar_config: "アバターの新規作成",
  get_category_personas: "カテゴリ別ペルソナの一覧取得",
  suggest_category_persona: "カテゴリ別ペルソナの下書き提案",
  save_category_persona: "カテゴリ別ペルソナの保存",
  get_embed_code: "埋め込みコードの取得",
  set_widget_theme: "ウィジェットテーマの変更",
  get_tuning_rules: "指示ルール一覧の取得",
  update_tuning_rule: "指示ルールの更新",
  delete_tuning_rule: "指示ルールの削除",
  generate_tuning_rule_test_responses: "テスト応答の生成",
  approve_tuning_rule_response: "テスト応答の採用",
  remove_approved_response: "採用済み応答の取消",
  get_engagement_rules: "声がけルール一覧の取得",
  update_engagement_rule: "声がけルールの更新",
  delete_engagement_rule: "声がけルールの削除",
  get_knowledge_gaps: "知識ギャップの取得",
  dismiss_knowledge_gap: "知識ギャップの片付け",
  approve_gap_recommendation: "知識ギャップ推薦の承認",
  add_knowledge_from_gap: "知識ギャップからのFAQ作成",
  get_chat_sessions: "会話セッション一覧の取得",
  get_chat_session_messages: "会話の全文取得",
  delete_chat_session: "会話セッションの削除",
  get_session_outcome: "会話の成果の取得",
  record_session_outcome: "会話の成果の記録",
  get_conversation_evaluation: "対応品質評価の取得",
  get_escalations: "エスカレーション一覧の取得",
  reply_to_escalation: "エスカレーションへの返信",
  resolve_escalation: "エスカレーションの対応完了",
  get_monitoring_summary: "モニタリングサマリーの取得",
  get_legacy_ui_link: "旧管理画面への案内",
  get_analytics_summary: "会話分析サマリーの取得",
  get_analytics_trend: "会話数の推移・低評価セッションの取得",
  get_conversion_summary: "成約・効果分析サマリーの取得",
  get_ab_test_results: "A/Bテスト結果・改善提案の取得",
  get_knowledge_attribution: "ナレッジ別の成約貢献度の取得",
  get_billing_summary: "ご利用状況・お支払いの取得",
  change_my_plan: "プランの変更",
  start_billing_checkout: "お支払いカードの登録・変更",
  get_tuning_rule_effect: "ルール効果の取得",
  get_avatar_status: "アバター稼働状況の取得",
  request_sai_task: "Saiへの代行依頼",
  get_sai_task_status: "Saiタスク状況の取得",
  import_industry_faq_templates: "業種別FAQたたき台の登録",
  suggest_faq_import_from_text: "テキストからのFAQ一括提案",
  suggest_faq_import_from_urls: "URLからのFAQ一括提案",
  commit_faq_import: "FAQの一括登録",
  discard_faq_import: "FAQ一括提案の破棄",
  publish_faq_drafts: "下書きFAQの公開",
};

// 「進捗」としてカウントしてよいツール名。
// src/api/admin/agent/confirmPolicy.ts の WRITE_TOOL_RISK_TIERS(サーバ側の書き込み
// リスク階層表)と完全一致すること — confirmPolicy.test.ts が双方向の突き合わせを
// 機械的に検証する(サーバに書き込みツールを追加してここへの追加を忘れる/削除し忘れる、
// どちらもそのテストが落ちる)。CP-3のstart_billing_checkoutのように自テナントのDBを
// 直接は書き換えないツールも、WRITE_TOOL_RISK_TIERSに分類されている限りここに含める。
const REAL_WRITE_TOOLS = new Set([
  "save_tuning_rule",
  "update_tuning_rule",
  "delete_tuning_rule",
  "approve_tuning_rule_response",
  "remove_approved_response",
  "save_faq",
  "save_engagement_rule",
  "update_engagement_rule",
  "delete_engagement_rule",
  "add_faq",
  "update_faq",
  "delete_faq",
  "set_faq_published",
  "bulk_unpublish_faqs",
  "bulk_delete_faqs",
  "set_ga4_id",
  "set_posthog",
  "update_allowed_origins",
  "set_faq_hints",
  "set_widget_theme",
  "activate_avatar",
  "deactivate_avatar",
  "delete_avatar_config",
  "set_avatar_feature",
  "set_hermes_consent",
  "update_avatar_profile",
  "reset_avatar_to_default",
  "adopt_avatar_preset",
  "create_avatar_config",
  "save_category_persona",
  "import_industry_faq_templates",
  "commit_faq_import",
  "reply_to_escalation",
  "resolve_escalation",
  "publish_faq_drafts",
  "dismiss_knowledge_gap",
  "approve_gap_recommendation",
  "add_knowledge_from_gap",
  "request_sai_task",
  "record_session_outcome",
  "delete_chat_session",
  // CP-3(GID 1218086647623729): tenants.plan を実際に書き換える。
  "change_my_plan",
  // CP-3: Stripe Checkoutの支払いページURLを返すだけで自テナントのDBは書き換えない
  // (実際のCustomer/Subscription作成はStripe側のWebhook完了時)が、
  // confirmPolicy.test.ts はこの一覧とWRITE_TOOL_RISK_TIERSの完全一致(双方向)を
  // 検査するため、highに分類した以上ここにも含める(下記コメント参照)。
  "start_billing_checkout",
]);

// 確認待ち/連鎖ブロックの判定に使う部分一致マーカー。サーバ側の実体は
// src/api/admin/agent/agentRoutes.ts の BLOCKED_UNCONFIRMED_MARKER('確認が必要です')・
// BLOCKED_CHAIN_MARKER('確認をスキップできません')。この2ファイルは別プロジェクト
// (Node/Vite)のため定数を直接共有できず、文言はここに複製している。サーバ側の文言を
// 変える場合はここも同時に更新すること(ここでは完全一致ではなく includes による
// 部分一致にしてあるため、サーバ側の文言が「〜まで」を含む限り前方一致で検出できる)。
const CONFIRM_REQUIRED_MARKER = "確認が必要";
const CHAIN_BLOCKED_MARKER = "確認をスキップできません";

// Phase2 (P7): ログイン直後に能動的に状況を尋ねる自動キックオフメッセージ。
// 左レール「今週のまとめ」(handleCategory の "weekly" 分岐)と実質同じ依頼文で
// 同じツール(get_weekly_briefing)に着地する。この2つの関係は「必ず再取得する」で
// 統一する — カテゴリクリックのたびに毎回サーバへ問い合わせ、キャッシュや
// 直近取得のスキップは行わない。同一セッション内で内容がほぼ重複することは
// 許容する(週次まとめは「いつ見ても最新の状況を確認できる」がこの機能の目的で、
// 一度見たら消えるべき情報ではない)。カードの集計時点(asOf)表示が、
// 重複よりも「古いまま」を防ぐ方の実害を先に塞ぐ(WeeklySummaryCard 参照)。
const BOOTSTRAP_PROMPT =
  "ログインしたところです。今週の状況を教えてください。要点と次にやるべきことを最大3つまで、簡潔に教えてください。";

// GID 1216274591838389 チャット版: 新規テナント(onboarding_completed_at未設定)の初回起動時、
// 業種選択チップを添えた案内を出す(AIを介さないローカル表示。選択後の提案・登録は実API接続)。
const INDUSTRY_CHIPS: Chip[] = ONBOARDING_INDUSTRIES.map((ind) => ({
  label: `${ind.icon} ${ind.label}`,
  action: `__real:業種は「${ind.label}」です。この業種のFAQテンプレートを提案してください。`,
  tone: "ghost",
}));

// Asana 1217040702485762(P5): オンボーディング4段階(docs/ONBOARDING_FIRST_LOGIN.md §3.1③)。
// 導出ロジックの単一の情報源は src/api/admin/agent/onboardingStage.ts(バックエンド)。
// admin-ui と backend は別パッケージ(別ビルドルート)のため import できないが、admin-ui内の
// 段階順序(何が「次に足りない段階」か)は lib/landingDecision.ts の nextIncompleteStage に
// 集約する(オンボ 是正C-2。以前はここに同じ判定順序をif連鎖で再実装しており、
// landingDecision.ts のisOnboardingComplete・useAuthの型と3重に重複していた)。
// stage の型自体は useAuth.tsx の OnboardingStageFlags を単一の情報源として使う。

// 4段階のうち、まだ到達していない最初の段階に対応する案内文＋チップを返す。
// 全段階到達済みなら null(=通常の週次ブリーフィング側の起動に進む)。
function deriveOnboardingNextStep(stage: OnboardingStageFlags): { text: string; chips?: Chip[] } | null {
  const incompleteStage = nextIncompleteStage(stage);
  switch (incompleteStage) {
    case "industry_answered":
      return {
        text: "初めまして！まず1つだけ教えてください。どんな業種ですか？\nお答えに合わせて、すぐ使えるFAQのたたき台をご提案します。",
        chips: INDUSTRY_CHIPS,
      };
    case "knowledge_published":
      // オンボ 是正A-2: 業種は答えたが下書きが1件も無い(全INSERT失敗、または
      // 「あとで」を選んで抜けた等)場合は「下書きを見る」を出しても空振りになる。
      // 下書きの有無で「公開を促す」か「たたき台作成に戻す」かを分ける。
      if (!stage.hasDraftFaq) {
        return {
          text: "FAQのたたき台をまだお作りしていません。業種を教えていただければ、すぐ使えるたたき台をご提案します。",
          chips: INDUSTRY_CHIPS,
        };
      }
      return {
        text: "業種のFAQたたき台は下書きとして登録済みです。内容をご確認のうえ、よろしければ公開しましょう。",
        chips: [{ label: "下書きを見る", action: "__real:下書きのFAQを見せてください", tone: "ghost" }],
      };
    case "widget_installed":
      return {
        text: "FAQの準備ができました。次はウィジェットをサイトに設置しましょう。埋め込みコードをお渡しします。",
        chips: [{ label: "埋め込みコードを見る", action: "__real:埋め込みコードを教えてください", tone: "ghost" }],
      };
    case "first_conversation":
      return {
        text: "設置は完了しています。お客様からの最初のご質問をお待ちしています。準備は万端です！",
      };
    case null:
      return null;
  }
}

// ─── 実APIのツール結果 → 見た目の良いカードへの変換 ────────────────────────────
// actionExecutor.ts が返す日本語の定型文字列を軽くパースする。想定外の形式なら
// null を返し、呼び出し側は汎用の agentAction カード（生テキスト）にフォールバックする。

function parseSuggestFaq(result: string): { question: string; answer: string; category: string } | null {
  const q = result.match(/質問:\s*(.+)/)?.[1]?.trim();
  const a = result.match(/回答:\s*(.+)/)?.[1]?.trim();
  if (!q || !a) return null;
  const c = result.match(/分類:\s*(.+)/)?.[1]?.trim();
  return { question: q, answer: a, category: c || "(自動判定)" };
}

function parseSuggestTuningRule(result: string): { trigger: string; behavior: string } | null {
  const t = result.match(/トリガー:\s*(.+)/)?.[1]?.trim();
  const b = result.match(/対応方針:\s*(.+)/)?.[1]?.trim();
  if (!t || !b) return null;
  return { trigger: t, behavior: b };
}

function describeEngagementTrigger(type: string, config: Record<string, unknown>): string {
  switch (type) {
    case "idle_time":
      return `${config["seconds"] ?? "?"}秒間操作がない時`;
    case "scroll_depth":
      return `ページを${config["threshold"] ?? "?"}%スクロールした時`;
    case "exit_intent":
      return "サイトを離れようとした時";
    case "page_url_match": {
      const patterns = Array.isArray(config["patterns"]) ? (config["patterns"] as unknown[]).join("・") : "特定ページ";
      return `${patterns} を見ている時`;
    }
    default:
      return type;
  }
}

function parseSuggestEngagementRule(result: string): { when: string; message: string } | null {
  const type = result.match(/トリガー種別:\s*(.+)/)?.[1]?.trim();
  const cfgRaw = result.match(/トリガー設定:\s*(\{.*\})/)?.[1];
  const message = result.match(/表示文言:\s*(.+)/)?.[1]?.trim();
  if (!type || !message) return null;
  let config: Record<string, unknown> = {};
  try {
    config = cfgRaw ? (JSON.parse(cfgRaw) as Record<string, unknown>) : {};
  } catch {
    // パース失敗時はトリガー種別名だけで表示（フォールバック文言）
  }
  return { when: describeEngagementTrigger(type, config), message };
}

function parseLegacyUiLink(result: string): { label: string; url: string; description: string } | null {
  const label = result.match(/画面:\s*(.+)/)?.[1]?.trim();
  const url = result.match(/URL:\s*(.+)/)?.[1]?.trim();
  const description = result.match(/説明:\s*(.+)/)?.[1]?.trim();
  if (!label || !url || !description) return null;
  return { label, url, description };
}

const SAVE_SUCCESS_RE = /を(保存|登録|削除|更新|有効化|設定|採用)しました/;

// ─── PDF取り込みの案内文 ─────────────────────────────────────────────────────
// 判定条件は lib/bookPdfUpload.ts で旧UIと共有し、文言だけをこの面の話し言葉に合わせる。
// 店主に読ませるものなので、拡張子以外の技術用語(MIME・ステータスコード等)は出さない。

const PDF_REJECTION_MESSAGE: Record<BookPdfRejection, string> = {
  type: "PDFファイル（またはPDFをまとめたZIPファイル）を送ってください。",
  pdf_size: "PDFは1ファイル10MBまでです。分割してから送ってみてください。",
  zip_size: "ZIPファイルは50MBまでです。分けてから送ってみてください。",
};

const PDF_UPLOAD_AUTH_ERROR = "ログインの有効期限が切れたようです。もう一度ログインしてからお試しください。";
const PDF_UPLOAD_TOO_LARGE_ERROR = "ファイルが大きすぎて受け取れませんでした。分割してから送ってみてください。";
const PDF_UPLOAD_NETWORK_ERROR = "うまく送れませんでした。通信の状態を確かめて、もう一度お試しください。";
const PDF_UPLOAD_GENERIC_ERROR = "うまく受け取れませんでした。少し時間をおいてお試しください。";
const PDF_UPLOAD_ZIP_EMPTY_ERROR = "ZIPの中に取り込めるPDFが見つかりませんでした。";
// GID 1217040818410419: 書籍/PDF取り込みはR2C運用限定(2026-07-31決定)。専門用語(403/権限等)は
// 出さず、優しい日本語で断る。バックエンド(bookPdfRoutes.ts)の拒否文言とも揃える。
const PDF_UPLOAD_TENANT_RESTRICTED_MESSAGE =
  "この機能は現在ご利用いただけません。内容を文章で教えていただければ、代わりに登録いたします。";

const AVATAR_GENERATE_GENERIC_ERROR = "画像を生成できませんでした。少し時間をおいてもう一度お試しください。";
const AVATAR_PREMIUM_GENERATE_GENERIC_ERROR = "高品質画像を生成できませんでした。少し時間をおいてもう一度お試しください。";
const AVATAR_ADOPT_GENERIC_ERROR = "この画像を反映できませんでした。少し時間をおいてもう一度お試しください。";
const AVATAR_VOICE_MATCH_GENERIC_ERROR = "声を検索できませんでした。少し時間をおいてもう一度お試しください。";
const AVATAR_VOICE_MATCH_EMPTY_ERROR = "合う声が見つかりませんでした。もう一度お試しください。";
const AVATAR_VOICE_ADOPT_GENERIC_ERROR = "この声を反映できませんでした。少し時間をおいてもう一度お試しください。";

// ─── アバター写真アップロードの受付判定・案内文 ───────────────────────────────
// StudioImageSection.tsxの「JPG, PNG（最大5MB）」表示と揃える。旧UIのhandleFileUpload
// はサイズしか見ていないが、ここでは §10.3 の想定操作(0バイト・拡張子偽装)に応じて
// 種別も見る(旧UIより厳しい方に倒すのは9.3-8と矛盾しない — チャットが緩くなるのを
// 避けているだけで、既存ユーザー操作を追加で拒否するわけではない)。
const MAX_AVATAR_PHOTO_SIZE = 5 * 1024 * 1024;
const AVATAR_PHOTO_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const AVATAR_PHOTO_TYPE_ERROR = "JPG・PNG・WEBPの画像ファイルを送ってください。";
const AVATAR_PHOTO_SIZE_ERROR = "ファイルが大きすぎます。5MB以下の画像にしてください。";
const AVATAR_PHOTO_EMPTY_ERROR = "空のファイルは送信できませんでした。別の画像を試してください。";
const AVATAR_PHOTO_UPLOAD_ERROR = "この写真を反映できませんでした。少し時間をおいてもう一度お試しください。";

function validateAvatarPhotoFile(file: File): string | null {
  if (file.size === 0) return AVATAR_PHOTO_EMPTY_ERROR;
  if (file.size > MAX_AVATAR_PHOTO_SIZE) return AVATAR_PHOTO_SIZE_ERROR;
  if (!AVATAR_PHOTO_MIME_TYPES.has(file.type)) return AVATAR_PHOTO_TYPE_ERROR;
  return null;
}

// ─── 音声クローンの受付判定・案内文 ───────────────────────────────────────────
// バックエンド(src/api/admin/avatar/routes.ts ALLOWED_VOICE_MIME_TYPES)と同じ一覧に揃える。
const MAX_VOICE_CLONE_FILE_SIZE = 10 * 1024 * 1024;
const VOICE_CLONE_MIME_TYPES = new Set(["audio/mpeg", "audio/wav", "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/ogg"]);
const VOICE_CLONE_TYPE_ERROR = "対応していない音声形式です。MP3・WAV・MP4・OGGのファイルを送ってください。";
const VOICE_CLONE_SIZE_ERROR = "ファイルが大きすぎます。10MB以下の音声にしてください。";
const VOICE_CLONE_EMPTY_ERROR = "空のファイルは送信できませんでした。別の音声を試してください。";
const VOICE_CLONE_GENERIC_ERROR = "音声クローンの作成に失敗しました。少し時間をおいてもう一度お試しください。";

function validateVoiceCloneFile(file: File): string | null {
  if (file.size === 0) return VOICE_CLONE_EMPTY_ERROR;
  if (file.size > MAX_VOICE_CLONE_FILE_SIZE) return VOICE_CLONE_SIZE_ERROR;
  if (!VOICE_CLONE_MIME_TYPES.has(file.type)) return VOICE_CLONE_TYPE_ERROR;
  return null;
}

// ─── W3-4: ゼロから作成したアバターの見た目の要約表示 ───────────────────────────
// buildAvatarPrompt.tsに渡す英語の値と1対1の日本語ラベル。プロンプト自体はfal.aiへの
// 入力としてbuildAvatarPromptが組み立てる(ここでは会話への表示にのみ使う)。
const AVATAR_TYPE_LABEL: Record<string, string> = { human: "人物", anime: "アニメ調", "3d": "3Dキャラクター", animal: "動物", robot: "ロボット" };
const AVATAR_GENDER_LABEL: Record<string, string> = { male: "男性", female: "女性" };
const AVATAR_AGE_LABEL: Record<string, string> = { "20s": "20代", "30s": "30代", "40s": "40代", "50s+": "50代以上" };
const AVATAR_OUTFIT_LABEL: Record<string, string> = { business_suit: "ビジネススーツ", casual: "カジュアル", white_coat: "白衣", uniform: "制服" };
const AVATAR_ANIMAL_KIND_LABEL: Record<string, string> = { dog: "犬", cat: "猫", bird: "鳥", bear: "熊", fox: "狐", other: "動物" };
const AVATAR_ANIMAL_VIBE_LABEL: Record<string, string> = { cute: "可愛らしい", cool: "クール", silly: "コミカル" };
const AVATAR_ROBOT_DESIGN_LABEL: Record<string, string> = { simple: "シンプル", mecha: "メカ", scifi: "SF風", cute: "可愛らしい" };

function describeAvatarAppearance(card: Extract<Card, { kind: "avatarAdopted" }>): string {
  const parts = [AVATAR_TYPE_LABEL[card.avatarType ?? ""] ?? card.avatarType];
  if (card.gender) parts.push(AVATAR_GENDER_LABEL[card.gender] ?? card.gender);
  if (card.age) parts.push(AVATAR_AGE_LABEL[card.age] ?? card.age);
  if (card.outfit) parts.push(AVATAR_OUTFIT_LABEL[card.outfit] ?? card.outfit);
  if (card.animalKind) parts.push(AVATAR_ANIMAL_KIND_LABEL[card.animalKind] ?? card.animalKind);
  if (card.animalVibe) parts.push(AVATAR_ANIMAL_VIBE_LABEL[card.animalVibe] ?? card.animalVibe);
  if (card.robotDesign) parts.push(AVATAR_ROBOT_DESIGN_LABEL[card.robotDesign] ?? card.robotDesign);
  return parts.filter(Boolean).join("・");
}

const AVATAR_VOICE_DESIGN_GENERIC_ERROR = "声を作成できませんでした。少し時間をおいてもう一度お試しください。";
const AVATAR_VOICE_DESIGN_EMPTY_ERROR = "声を作成できませんでした。もう一度お試しください。";

// ─── 進行中テキストを少しずつ流し込む（体感の良さ重視の演出。本物の
//     トークンストリーミングではなく、確定済みの応答文字列をクライアント側で
//     少しずつ表示するだけ。真のストリーミングにはバックエンドの
//     SSE化(本番AdminAgentPanelと共有するエンドポイントの変更)が必要で別スコープ） ───

function useTypewriter(setMsgs: Dispatch<SetStateAction<Msg[]>>) {
  return useCallback(
    (id: number, fullText: string, onDone?: () => void) => {
      const reduceMotion =
        typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (reduceMotion || !fullText) {
        setMsgs((prev) => prev.map((m) => (m.id === id ? { ...m, text: fullText, revealing: false } : m)));
        onDone?.();
        return;
      }
      const chars = Array.from(fullText); // サロゲートペア・絵文字を考慮
      let i = 0;
      const CHARS_PER_TICK = 3;
      const timer = setInterval(() => {
        i = Math.min(chars.length, i + CHARS_PER_TICK);
        const done = i >= chars.length;
        // revealing中はMarkdownとして再パースしない(閉じていない**等が
        // 生の記法のままチラつくため)。完了した瞬間にfalseへ倒す。
        setMsgs((prev) =>
          prev.map((m) => (m.id === id ? { ...m, text: chars.slice(0, i).join(""), revealing: !done } : m)),
        );
        if (done) {
          clearInterval(timer);
          onDone?.();
        }
      }, 16);
    },
    [setMsgs],
  );
}

interface Chip {
  label: string;
  action: string;
  tone?: "primary" | "ghost";
}

interface Msg {
  id: number;
  role: "ai" | "me";
  text?: string;
  card?: Card;
  chips?: Chip[];
  chipsUsed?: boolean;
  /** この回答がどこから来たか(サーバの answered_from をそのまま持つ) */
  answeredFrom?: AnsweredFrom;
  /** タイプライター演出で少しずつ流し込み中かどうか。true の間は text が
      不完全なMarkdown断片(閉じていない**等)を含みうるため、Markdownとして
      再パースせず素のテキストで表示する(生の記法がチラつくのを防ぐ)。 */
  revealing?: boolean;
}

// 回答の出どころ表示。3値の語彙と文言はパネル(Surface A)と同一にする — 同じ回答が
// 面によって違う出どころに見えてはならないため(値の定義は agentRoutes.ts が正)。
const ANSWERED_FROM_LABEL: Record<AnsweredFrom, string> = {
  faq_list: "📚 登録した知識データから回答しました",
  tool_action: "⚙️ 操作を実行しました",
  general: "💡 R2Cの使い方ガイドから回答しました",
};

const AGENT = "#7c3aed";
const AGENT_SOFT = "rgba(124,58,237,0.10)";
const AGENT_BORDER = "rgba(124,58,237,0.30)";

const CATEGORIES: Category[] = [
  { key: "assistant", label: "アシスタント", icon: "✨" },
  { key: "weekly", label: "今週のまとめ", icon: "📊" },
  // 「対応中の会話」(J1: 今すぐ人が出るべき会話)と「会話の履歴」(J2点検/J3照会)は
  // 緊急性の軸が違うため別カテゴリーに分ける。バッジ(escalations件数)もこちらへ移す。
  // ラベルは RAIL_BADGE_LABEL.escalations を直接参照し、新しい呼び名を作らない。
  { key: "escalations", label: RAIL_BADGE_LABEL.escalations, icon: "💬", badge: "escalations" },
  { key: "history", label: "会話の履歴", icon: "🗂️" },
  { key: "knowledge", label: "知識データ", icon: "📚", badge: "gaps" },
  { key: "rules", label: "指示ルール", icon: "🎛️" },
  { key: "avatar", label: "アバター", icon: "🎭" },
];

// ─── ページ ──────────────────────────────────────────────────────────────────

let _uid = 100;
const nextId = () => ++_uid;

// 復元した会話のidと新規メッセージのidが衝突しないよう、採番を復元済みの最大値より後ろへ進める
const reserveIds = (restored: Msg[]) => {
  for (const m of restored) if (m.id > _uid) _uid = m.id;
};

export default function CopilotPreviewPage() {
  // super_adminがテナントプレビュー中の場合、対象テナントIDをtargetTenantIdとしてAPIに渡す
  // (他画面のescalations/knowledge-gaps等と同じパターン)。client_adminは自身のJWT由来の
  // tenantIdがサーバー側で使われるため、previewMode=falseのままで問題ない。
  const { user, isSuperAdmin, previewMode, previewTenantId, enterPreview, logout, isLoading: authLoading } = useAuth();
  const navigate = useNavigate();
  // super_adminがプレビューに入っていない場合、テナントが特定できないため
  // ほぼ全てのツールが「テナントが特定できません」になり会話が行き止まりになる。
  // 先にテナントを選ばせて既存のクライアントビュー(previewMode)へ入れる。
  // previewModeに入れば以降はclient_adminと同じ経路をそのまま辿る。
  const needsTenantSelection = isSuperAdmin && !previewMode;
  const [active, setActive] = useState("assistant");
  const [input, setInput] = useState("");
  const [isComposing, setIsComposing] = useState(false);
  // モバイル用: 左レール(ドロワー)の開閉状態。デスクトップでは未使用(CSSで常時表示)。
  const [railOpen, setRailOpen] = useState(false);
  // 起動直後は空。bootstrap()が実データの週次ブリーフィングを積む
  const [msgs, setMsgs] = useState<Msg[]>([]);

  // 自由入力欄・起動時ブリーフィング・サイドバー各カテゴリーが繋がる実チャットの状態。
  // sessionId・履歴ウィンドウ・targetTenantId 導出・エラー文言はパネル(Surface A)と
  // 共有の transport 層が持つ(lib/useAgentChatTransport.ts)。
  const {
    sessionId: realSessionId,
    adoptSessionId,
    send: sendAgentChat,
  } = useAgentChatTransport({ surface: "fullscreen" });
  const [realHistory, setRealHistory] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [sending, setSending] = useState(false);
  const [realActionCount, setRealActionCount] = useState(0); // 実際に成功した書き込み操作の件数

  // この画面が対象にしているテナント。左レールのバッジ件数とPDF取り込みの両方で使う。
  // テナントを特定できない場合(preview中でないsuper_admin)は空になり、バッジは取得しない
  // (全テナント横断の合計が「この店の件数」として出てしまうため)。なお、その状態では
  // needsTenantSelection でチャット自体がまだ描画されないため、コンポーザは存在しない。
  const scopedTenantId = previewMode ? (previewTenantId ?? "") : (user?.tenantId ?? "");

  // 相談窓口: 担当者からの未読返信。テナントが特定できない間は取りに行かない
  // (フック側が tenantId=null で素通りする)。
  const { replies: feedbackReplies, markRead: markFeedbackReplyRead } = useFeedbackReplies(
    scopedTenantId || null,
    isSuperAdmin,
  );

  // 「解決しました」= 既読にするだけ。「まだ解決しません」= 既読にしたうえで、元の質問を
  // 親IDに紐づけて再投稿する。どちらもパネル(Surface A)と同じ手順・同じAPI。
  const handleReplyResolved = useCallback(
    (reply: FeedbackReply) => markFeedbackReplyRead(reply.id),
    [markFeedbackReplyRead],
  );
  const handleReplyNotResolved = useCallback(
    async (reply: FeedbackReply) => {
      await markFeedbackReplyRead(reply.id);
      await submitConsultation({ message: reply.message, parentFeedbackId: reply.id });
    },
    [markFeedbackReplyRead],
  );

  const [railCounts, setRailCounts] = useState<RailCounts>({});
  useEffect(() => {
    if (!scopedTenantId) return;
    const qs = `?tenant=${encodeURIComponent(scopedTenantId)}`;
    void (async () => {
      // 失敗しても店主には何も見せない(バッジが出ないだけ)。片方だけ失敗しても
      // もう片方は出せるよう allSettled で個別に扱う。
      const [gapRes, escRes] = await Promise.allSettled([
        authFetch(`${API_BASE}/v1/admin/knowledge-gaps/count${qs}`),
        authFetch(`${API_BASE}/v1/admin/chat-history/escalations${qs}`),
      ]);
      const next: RailCounts = {};
      if (gapRes.status === "fulfilled" && gapRes.value.ok) {
        const data = (await gapRes.value.json().catch(() => null)) as { count?: number } | null;
        if (typeof data?.count === "number") next.gaps = data.count;
      }
      if (escRes.status === "fulfilled" && escRes.value.ok) {
        const data = (await escRes.value.json().catch(() => null)) as { escalations?: unknown[] } | null;
        if (Array.isArray(data?.escalations)) next.escalations = data.escalations.length;
      }
      setRailCounts(next);
    })();
  }, [scopedTenantId]);

  // textareaは行が増えても自動では伸びないため、入力量に応じて高さを合わせる
  // (伸ばさないと2行目以降を打った時に前の行が枠外へ隠れてしまう)
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    // 空の時は rows=1 の高さ(=きっちり1行)に戻す。高さを明示すると、Chromeでは
    // 長いplaceholderの折り返しがscrollHeightに乗って未入力でも枠が伸びてしまう
    if (!input) {
      el.style.height = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [input]);

  const threadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  const push = useCallback((...items: Msg[]) => {
    setMsgs((prev) => [...prev, ...items]);
  }, []);

  const revealText = useTypewriter(setMsgs);

  const say = (text: string, chips?: Chip[]): Msg => ({ id: nextId(), role: "ai", text, chips });
  const me = (text: string): Msg => ({ id: nextId(), role: "me", text });

  // チップを押したら、そのメッセージのチップを使用済みにする
  const consumeChips = (msgId: number) =>
    setMsgs((prev) => prev.map((m) => (m.id === msgId ? { ...m, chipsUsed: true } : m)));

  // 呼び出しのたびに進む世代カウンタ。テナント切替(force:true)が古い呼び出しを
  // 追い越した場合、古い呼び出しの応答が届いても画面へ反映しない・sendingも
  // 触らないようにする(GID: 連続テナント切替で古いテナントの応答が新しいテナントの
  // 会話に紛れ込むレースの回避)。通常呼び出し(force無し)は sending ガードにより
  // 同時に2本走らないため、この仕組みは通常時の挙動には影響しない。
  const requestEpochRef = useRef(0);

  // Phase1/2: 実際の R2Cエージェント API を呼ぶ（自由入力欄・起動時ブリーフィングから）。
  // suggest_tuning_rule / save_tuning_rule / get_weekly_briefing 等が本物のDBを読み書きする。
  // silent=true はページ起動時の自動キックオフ用（ユーザーが打った体で me() バブルを積まない）。
  // force=true はテナント切替専用。前の呼び出しがまだ sending 中でもガードを迂回して発火し、
  // 前の呼び出しを世代カウンタで追い越す(「新しいテナントへの切替」が「前のテナントの
  // 応答待ち」より優先されるべきであるため)。
  const sendReal = async (text: string, opts?: { silent?: boolean; force?: boolean }) => {
    if (!text.trim() || (sending && !opts?.force)) return;
    const myEpoch = ++requestEpochRef.current;
    if (!opts?.silent) push(me(text));
    setSending(true);

    const result = await sendAgentChat(text, { history: realHistory });
    if (requestEpochRef.current !== myEpoch) return; // より新しい呼び出しに追い越された
    if (!result.ok) {
      // silent(起動時ブリーフィング等、ユーザーが打った体でない自動送信)の失敗は、
      // 唯一の復帰手段が画面リロードになってしまう。同じ文面をチップから
      // 再送できるようにする(runAction経由の既存の__real:ディスパッチをそのまま使う
      // — 新しいチップ種別・新しい送信経路は作らない)。
      const retryChips: Chip[] | undefined = opts?.silent
        ? [{ label: "もう一度試す", action: `__real:${text}`, tone: "ghost" }]
        : undefined;
      push(say(result.message, retryChips));
      setSending(false);
      return;
    }

    const data = result.data;
    setRealHistory((prev) =>
      [
        ...prev,
        { role: "user" as const, content: text },
        { role: "assistant" as const, content: data.reply },
      ].slice(-AGENT_CHAT_HISTORY_MAX_ENTRIES),
    );

    // ツール結果を、可能なら提案書と同じ見た目のカードにパースする。
    // 想定外の形式(下書き生成失敗時のエラー文など)は汎用の agentAction カードにフォールバック。
    const actionMsgs: Msg[] = (data.actions ?? []).map((a) => {
      // 構造化カードが来ていればそれを直接描画する。自然文の言い回しが変わっても
      // カードが黙って消えない経路。card が無いツール(get_legacy_ui_link / get_weekly_briefing
      // 以外のすべて)は、これまでどおり下の正規表現パースにフォールバックする。
      if (a.card?.kind === "legacy_link") {
        const { label, url, description } = a.card;
        return { id: nextId(), role: "ai", card: { kind: "link", label, url, description } };
      }
      if (a.card?.kind === "chat_session_list") {
        const { total, sessions } = a.card;
        return { id: nextId(), role: "ai", card: { kind: "chatSessionList", total, sessions } };
      }
      if (a.card?.kind === "chat_session_messages") {
        const { shortId, totalMessages, messages } = a.card;
        return { id: nextId(), role: "ai", card: { kind: "chatSessionMessages", shortId, totalMessages, messages } };
      }
      if (a.card?.kind === "conversation_evaluation") {
        const { shortId, overallScore, axes, notes } = a.card;
        return { id: nextId(), role: "ai", card: { kind: "evaluation", shortId, overallScore, axes, notes } };
      }
      if (a.card?.kind === "avatar_preset") {
        const { presetId, name, imageUrl, description } = a.card;
        return { id: nextId(), role: "ai", card: { kind: "avatarPreset", presetId, name, imageUrl, description } };
      }
      if (a.card?.kind === "avatar_adopted") {
        const { configId, name, imageUrl, description, avatarType, gender, age, outfit, animalKind, animalVibe, robotDesign } = a.card;
        return {
          id: nextId(),
          role: "ai",
          card: { kind: "avatarAdopted", configId, name, imageUrl, description, avatarType, gender, age, outfit, animalKind, animalVibe, robotDesign },
        };
      }
      if (a.card?.kind === "tuning_rules_list") {
        const { rules, totalCount } = a.card;
        return { id: nextId(), role: "ai", card: { kind: "rulesList", rules, totalCount } };
      }
      if (a.card?.kind === "knowledge_gaps_list") {
        const { gaps, totalCount } = a.card;
        return { id: nextId(), role: "ai", card: { kind: "knowledgeGapsList", gaps, totalCount } };
      }
      if (a.card?.kind === "faq_import_preview") {
        const { source, total, truncated, faqs, errorUrls } = a.card;
        return { id: nextId(), role: "ai", card: { kind: "faqImportPreview", source, total, truncated, faqs, errorUrls } };
      }
      if (a.card?.kind === "weekly_summary") {
        const { asOf, sessions, avgScore, conversions, faq, pendingTuningRules, gaps, learned } = a.card;
        return {
          id: nextId(),
          role: "ai",
          card: { kind: "weeklySummary", asOf, sessions, avgScore, conversions, faq, pendingTuningRules, gaps, learned },
        };
      }
      if (a.card?.kind === "rule_effect") {
        const { ruleId, approvedAt, truncated, analyzedSessions, comparison, progress } = a.card;
        return {
          id: nextId(),
          role: "ai",
          card: { kind: "ruleEffect", ruleId, approvedAt, truncated, analyzedSessions, comparison, progress },
        };
      }
      if (a.card?.kind === "analytics_trend") {
        const { period, daily, lowScoreSessions } = a.card;
        return {
          id: nextId(),
          role: "ai",
          card: { kind: "analyticsTrend", period, daily, lowScoreSessions },
        };
      }
      if (a.card?.kind === "ab_test_results") {
        const { experiments, suggestions } = a.card;
        return {
          id: nextId(),
          role: "ai",
          card: { kind: "abTestResults", experiments, suggestions },
        };
      }
      if (a.card?.kind === "knowledge_attribution") {
        const { period, sourceType, totalChunksUsed, avgConversionRate, topItems, worstPerformer } = a.card;
        return {
          id: nextId(),
          role: "ai",
          card: { kind: "knowledgeAttribution", period, sourceType, totalChunksUsed, avgConversionRate, topItems, worstPerformer },
        };
      }
      if (a.card?.kind === "billing_summary") {
        const { period, plan, billingEstimateJpy, breakdown, invoicesAvailable, invoices, portalUrl, quota } = a.card;
        return {
          id: nextId(),
          role: "ai",
          card: { kind: "billingSummary", period, plan, billingEstimateJpy, breakdown, invoicesAvailable, invoices, portalUrl, quota },
        };
      }
      if (a.card?.kind === "plan_changed") {
        const { previousPlan, previousPlanLabel, plan, planLabel, billingSyncNeedsAttention } = a.card;
        return {
          id: nextId(),
          role: "ai",
          card: { kind: "planChanged", previousPlan, previousPlanLabel, plan, planLabel, billingSyncNeedsAttention },
        };
      }
      // D6: 優先度を含め、正規表現では拾えなかった内容(複数行の対応方針)もそのまま運ぶ。
      if (a.card?.kind === "tuning_rule_draft") {
        const { triggerPattern, expectedBehavior, priority } = a.card;
        return {
          id: nextId(),
          role: "ai",
          card: { kind: "rule", trigger: triggerPattern, behavior: expectedBehavior, priority },
        };
      }
      if (a.tool === "suggest_faq") {
        const parsed = parseSuggestFaq(a.result);
        if (parsed) return { id: nextId(), role: "ai", card: { kind: "faq", ...parsed } };
      } else if (a.tool === "suggest_tuning_rule") {
        const parsed = parseSuggestTuningRule(a.result);
        if (parsed) return { id: nextId(), role: "ai", card: { kind: "rule", ...parsed } };
      } else if (a.tool === "suggest_engagement_rule") {
        const parsed = parseSuggestEngagementRule(a.result);
        if (parsed) return { id: nextId(), role: "ai", card: { kind: "engagement", ...parsed } };
      } else if (a.tool === "get_legacy_ui_link") {
        const parsed = parseLegacyUiLink(a.result);
        if (parsed) return { id: nextId(), role: "ai", card: { kind: "link", ...parsed } };
      } else if (
        (a.tool === "save_faq" || a.tool === "save_tuning_rule" || a.tool === "save_engagement_rule") &&
        SAVE_SUCCESS_RE.test(a.result)
      ) {
        return { id: nextId(), role: "ai", card: { kind: "success", text: a.result } };
      }
      return { id: nextId(), role: "ai", card: { kind: "agentAction", tool: a.tool, result: a.result } };
    });

    // 実際にDBへ書き込んだ操作(確認ブロックで弾かれたものは除く)だけを実進捗としてカウントする。
    // ブロック理由は2種類あり、どちらも書き込みが起きていないため除外する:
    //   1. confirmed=false        → 「確認が必要です」
    //   2. 同一ターン内の連鎖ブロック → 「確認をスキップできません」(agentRoutes.ts:239)
    const writesThisTurn = (data.actions ?? []).filter(
      (a) =>
        REAL_WRITE_TOOLS.has(a.tool) &&
        !a.result.includes(CONFIRM_REQUIRED_MARKER) &&
        !a.result.includes(CHAIN_BLOCKED_MARKER),
    ).length;
    if (writesThisTurn > 0) setRealActionCount((n) => n + writesThisTurn);

    // suggest系の下書きが出たら、そのまま自然文で確定できるチップを添える
    const SUGGEST_TOOLS = new Set(["suggest_tuning_rule", "suggest_faq", "suggest_engagement_rule"]);
    const suggested = data.actions?.some((a) => SUGGEST_TOOLS.has(a.tool));
    // Saiへの依頼がconfirmed待ちでブロックされた場合も、そのまま同意できるチップを添える
    const saiPendingConfirm = data.actions?.some(
      (a) => a.tool === "request_sai_task" && a.result.includes(CONFIRM_REQUIRED_MARKER),
    );
    // エスカレーションへの返信/対応完了がconfirmed待ちでブロックされた場合も同様
    const escalationPendingConfirm = data.actions?.some(
      (a) =>
        (a.tool === "reply_to_escalation" || a.tool === "resolve_escalation") &&
        a.result.includes(CONFIRM_REQUIRED_MARKER),
    );
    // オンボーディングのFAQテンプレート提案がconfirmed待ちでブロックされた場合も同様
    const industryTemplatePendingConfirm = data.actions?.some(
      (a) => a.tool === "import_industry_faq_templates" && a.result.includes("よろしければ登録しますか"),
    );
    // H-5: suggest_faq_import_from_text/urls のFAQ案一覧カードが出たら、そのまま
    // 登録できるチップを添える(旧UIのプレビュー画面が持っていた「候補を見て選ぶ」を
    // 自由入力頼みにしない)。文字列マッチではなくcard種別で判定する(sessionListCard等と同じ作法)。
    const faqImportPreviewSuggested = data.actions?.some((a) => a.card?.kind === "faq_import_preview");
    // オンボ 是正B-1: publish_faq_draftsだけ確認チップが無く、下書き公開の動線が
    // 自由入力頼みになっていた(request_sai_task等の既存パターンに揃える)。
    const publishDraftsPendingConfirm = data.actions?.some(
      (a) => a.tool === "publish_faq_drafts" && a.result.includes("よろしければ公開しますか"),
    );
    // 成果(コンバージョン)記録がconfirmed待ちでブロックされた場合も同様
    const outcomePendingConfirm = data.actions?.some(
      (a) => a.tool === "record_session_outcome" && a.result.includes(CONFIRM_REQUIRED_MARKER),
    );
    // 会話セッション削除(不可逆)がconfirmed待ちでブロックされた場合も同様
    const deletePendingConfirm = data.actions?.some(
      (a) => a.tool === "delete_chat_session" && a.result.includes(CONFIRM_REQUIRED_MARKER),
    );
    // 会話一覧(get_chat_sessions)が返ってきたら、短縮IDを手打ちさせず次の1件を
    // 選べるチップを添える。同じターンに複数の会話一覧が返ることは無い前提(最初の1件)。
    const sessionListAction = data.actions?.find((a) => a.card?.kind === "chat_session_list");
    const sessionListCard =
      sessionListAction?.card?.kind === "chat_session_list" ? sessionListAction.card : undefined;
    // アバター見本の提案(suggest_avatar_preset)が出たら、そのまま採用できるチップを添える
    const avatarPresetSuggested = data.actions?.some((a) => a.tool === "suggest_avatar_preset");
    // 週次まとめのアクションチップ: LLMの文には付けられない(chipsはsuggest_*系の
    // ツール結果パースからしか生成できない構造のため)。サーバ集計値(card)から
    // 決定的に導く — 未回答質問/承認待ちルールが実在する時だけ、その場で着手できる
    // チップを添える。「次にやるべきこと」の文はLLMの解釈のまま、実行導線だけを分離する。
    const weeklySummaryCard = data.actions?.find((a) => a.card?.kind === "weekly_summary")?.card;
    const weeklySummaryGapsActionable =
      weeklySummaryCard?.kind === "weekly_summary" && (weeklySummaryCard.gaps?.total ?? 0) > 0;
    const weeklySummaryTuningActionable =
      weeklySummaryCard?.kind === "weekly_summary" && (weeklySummaryCard.pendingTuningRules ?? 0) > 0;
    const chips: Chip[] | undefined = suggested
      ? [
          { label: "保存して", action: "__real:保存してください", tone: "primary" },
          { label: "やめておく", action: "__real:やめておきます", tone: "ghost" },
        ]
      : avatarPresetSuggested
      ? [
          { label: "採用して", action: "__real:採用してください", tone: "primary" },
          { label: "やめておく", action: "__real:やめておきます", tone: "ghost" },
        ]
      : saiPendingConfirm
      ? [
          { label: "お願いする", action: "__real:はい、お願いします", tone: "primary" },
          { label: "やめておく", action: "__real:やめておきます", tone: "ghost" },
        ]
      : escalationPendingConfirm
      ? [
          { label: "実行して", action: "__real:はい、お願いします", tone: "primary" },
          { label: "やめておく", action: "__real:やめておきます", tone: "ghost" },
        ]
      : industryTemplatePendingConfirm
      ? [
          { label: "登録して", action: "__real:登録してください", tone: "primary" },
          { label: "あとで", action: "__real:あとでにします", tone: "ghost" },
        ]
      : faqImportPreviewSuggested
      ? [
          { label: "登録して", action: "__real:登録してください", tone: "primary" },
          { label: "やめておく", action: "__real:やめておきます", tone: "ghost" },
        ]
      : publishDraftsPendingConfirm
      ? [
          { label: "公開する", action: "__real:はい、公開してください", tone: "primary" },
          { label: "あとで", action: "__real:あとでにします", tone: "ghost" },
        ]
      : outcomePendingConfirm
      ? [
          { label: "記録して", action: "__real:はい、お願いします", tone: "primary" },
          { label: "やめておく", action: "__real:やめておきます", tone: "ghost" },
        ]
      : deletePendingConfirm
      ? [
          { label: "削除して", action: "__real:はい、削除してください", tone: "primary" },
          { label: "やめておく", action: "__real:やめておきます", tone: "ghost" },
        ]
      : sessionListCard && sessionListCard.sessions.length > 0
      ? sessionListCard.sessions.map((s) => ({
          label: `${s.startedAt.slice(5, 10)} ${s.preview.slice(0, 12)}`,
          action: `__real:[${s.shortId}]の会話を見せて`,
          tone: "ghost" as const,
        }))
      : weeklySummaryGapsActionable || weeklySummaryTuningActionable
      ? [
          ...(weeklySummaryGapsActionable
            ? [{ label: "FAQにする", action: "__real:AIが答えられなかった質問をFAQにしてください", tone: "primary" as const }]
            : []),
          ...(weeklySummaryTuningActionable
            ? [{ label: "確認する", action: "__real:承認待ちの指示ルールを見せてください", tone: "primary" as const }]
            : []),
        ]
      : undefined;

    push(...actionMsgs);

    // 最終返信だけを少しずつ流し込む(演出)。チップは流し込み完了後に表示する。
    const replyId = nextId();
    push({ id: replyId, role: "ai", text: "", answeredFrom: data.answered_from, revealing: true });
    revealText(replyId, data.reply || "（応答なし）", () => {
      // タイプライター演出の完了は非同期(setInterval)のため、演出中により新しい
      // 呼び出し(テナント再切替等)に追い越されている可能性がある。追い越されていたら
      // sending は触らない(そのより新しい呼び出し自身の完了処理に任せる)。
      if (requestEpochRef.current !== myEpoch) return;
      if (chips) setMsgs((prev) => prev.map((m) => (m.id === replyId ? { ...m, chips } : m)));
      setSending(false);
    });
    // setSending(false) は revealText の完了コールバックに任せる
  };

  // オンボーディング段階に応じて「次の一手」を出すか、通常の週次ブリーフィングを取りに
  // 行くかを決める共通処理。マウント時(初回ログイン/会話復元後)とテナント切替後の
  // 両方から呼ばれる — 以前はテナント切替側がオンボーディング判定を経由せず常に
  // ブリーフィングへ直行しており、切替直後は「次の一手」が出ないという2経路の
  // 不一致があった(P1-3)。
  //
  // myEpoch は呼び出し時点の requestEpochRef の値。stage取得(await)の間に、より新しい
  // 呼び出し(テナント再切替)に追い越されていたら、そのまま何も表示せず抜ける
  // (追い越した側がこの関数を呼び直すか、sendReal自身の世代ガードに委ねる)。これが
  // 無いと、切替でスレッドを空にした直後に前テナントの「次の一手」が新テナントの
  // スレッドへ紛れ込む(P2-1)。
  const runOnboardingAwareBriefing = async (
    myEpoch: number,
    opts: { hasRestoredConversation: boolean; loadingText: string; force?: boolean; fromLegacy?: boolean },
  ) => {
    let stage: OnboardingStageFlags | null = null;
    // Asana 1217040568430944(P7): super_adminのクライアントビュー(previewMode)からも
    // オンボーディングの「次の一手」提示を使えるようにする(docs/ONBOARDING_FIRST_LOGIN.md 決定D)。
    // previewMode中はJWTのtenant_idを見るmy-tenantではなくtargetTenantId明示の
    // /v1/admin/tenants/:id(super_admin専用、useAuthのtenantPlan取得と同じ経路)を使う。
    try {
      if (previewMode && previewTenantId) {
        const res = await authFetch(`${API_BASE}/v1/admin/tenants/${previewTenantId}`);
        if (res.ok) {
          const data = (await res.json()) as { onboarding_stage?: OnboardingStageFlags };
          stage = data.onboarding_stage ?? null;
        }
      } else if (!previewMode && user?.role === "client_admin") {
        const res = await authFetch(`${API_BASE}/v1/admin/my-tenant`);
        if (res.ok) {
          const data = (await res.json()) as { onboarding_stage?: OnboardingStageFlags };
          stage = data.onboarding_stage ?? null;
        }
      }
    } catch {
      // 取得失敗時は通常の週次ブリーフィング側にフォールバック
    }

    if (requestEpochRef.current !== myEpoch) return; // より新しい呼び出しに追い越された

    const nextStep = stage ? deriveOnboardingNextStep(stage) : null;

    if (opts.hasRestoredConversation) {
      if (nextStep) push(say(nextStep.text, nextStep.chips));
      return;
    }

    if (nextStep) {
      push(say(nextStep.text, nextStep.chips));
      return;
    }

    // P6-1: 新規テナントが指示ルールの存在に気づけるよう、4段階のオンボーディングが
    // 全て完了した直後に一度だけ紹介する。backendのonboardingStage.ts(単一の情報源)は
    // 変更せず、admin-ui内のブラウザ単位フラグ(tuningRuleIntro.ts)だけで
    // 「1回きり」を保証する軽量な接続(既存テナント向けの移行導線は別途作らない — 4段階が
    // 全て真になるのは実質的にこのオンボーディングフローを新規に通過したテナントのみ)。
    if (stage && scopedTenantId && !hasShownTuningRuleIntro(scopedTenantId)) {
      markTuningRuleIntroShown(scopedTenantId);
      push(say(
        "指示ルールも使えます。お客様への受け答えを1つずつAIチャットボットに教えられる機能です。最初のルールを作ってみますか？",
        [
          { label: "🎛️ 作ってみる", action: "__real:指示ルールを初めて作ります。何をどう伝えればいいか教えてください", tone: "primary" },
          { label: "あとで", action: "__real:あとでにします", tone: "ghost" },
        ],
      ));
      return;
    }

    // 旧UIから戻ってきたが会話を復元できなかった場合は、ログイン直後と同じ
    // BOOTSTRAP_PROMPT(LLM 1ターン + get_weekly_briefing)を焚かない。復元失敗は
    // 「初回ログイン」ではなく単なる不通なので、定型文だけ返して余計な課金を避ける。
    if (opts.fromLegacy) {
      push({ id: nextId(), role: "ai", text: "旧画面から戻られましたね。続きから話せます。" });
      return;
    }

    push({ id: nextId(), role: "ai", text: opts.loadingText });
    await sendReal(BOOTSTRAP_PROMPT, { silent: true, force: opts.force });
  };

  // マウント時、まず同一タブに保存済みの会話があれば復元する(リロード・ブラウザバック・
  // モバイルのタブ破棄で会話が消えないように)。
  //
  // Asana 1217040702485762(P5): 復元できた場合でも、オンボーディングが未完了なら
  // 必ず「次の一手」を提示する(以前は復元時にブートストラップ自体を丸ごとスキップして
  // おり、2回目以降のログインで次に何をすべきかが消える欠陥があった)。
  //
  // 復元できなかった場合は、4段階(docs/ONBOARDING_FIRST_LOGIN.md §3.1③)のうち
  // 最初に未到達の段階の案内を出す。全段階到達済み・または段階を取得できない
  // (super_admin/previewMode含む)場合は、従来どおり実データの週次ブリーフィングを
  // 自動取得する。
  const bootstrapped = useRef(false);
  useEffect(() => {
    // テナント選択待ちの間は取りに行かない（テナント未特定のブリーフィングは
    // 「テナントが特定できません」で埋まるだけのため）。選択してpreviewModeに
    // 入った時点でこのeffectが再評価され、通常どおりブリーフィングが走る。
    if (needsTenantSelection) return;
    // P6-1で発見(既存の潜在バグ): /copilot-previewはRequireAuth外の隔離ルートのため、
    // useAuth()のセッション確認(非同期)が終わる前に user=null のままこのeffectが
    // 走ってしまうことがある。user未確定のままだとscopedTenantIdが空になり、
    // オンボーディング段階(stage)判定そのものが飛ばされて通常の週次ブリーフィングに
    // フォールバックしていた(既存の4段階次の一手が出ないことがある、同一の原因)。
    // needsTenantSelectionと同じ理由でauth確認が終わるまで待つ。
    if (authLoading) return;
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    const myEpoch = requestEpochRef.current;
    const restored = restoreChatSession<Msg>(CHAT_SESSION_SURFACE_FULLSCREEN, scopedTenantId || null);
    const hasRestoredConversation = !!(restored && restored.messages.length > 0);
    if (hasRestoredConversation && restored) {
      reserveIds(restored.messages);
      adoptSessionId(restored.sessionId);
      setMsgs(restored.messages);
      setRealHistory(restored.history ?? []);
    }

    void runOnboardingAwareBriefing(myEpoch, {
      hasRestoredConversation,
      loadingText: "ログイン、お疲れさまです。今週の実データを確認しています…",
      fromLegacy: new URLSearchParams(window.location.search).get("from") === "legacy",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsTenantSelection, authLoading]);

  // super_adminがプレビュー中に別テナントへenterPreviewする経路(AppSwitcher/テナント詳細の
  // 「クライアントビューで見る」等)を検知し、会話を初期化して新テナントの週次ブリーフィングを
  // 取り直す。上の bootstrap effect は needsTenantSelection のみを見ており、previewMode の
  // まま別テナントへ切り替わるケースでは再評価されないため、前テナントの会話(weeklySummary
  // カードを含む)が残ったまま新テナントの画面として表示され続けていた(GID: PR #633 で報告)。
  //
  // 初回確定("" → 最初のテナント)は上の effect が担当するため何もしない。空への遷移
  // (プレビュー解除)も何もしない(その間は needsTenantSelection の描画分岐でチャット自体が
  // 表示されない)。scopedTenantId が「別の非空値」に変わった場合だけリセットする。
  const lastScopedTenantIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = lastScopedTenantIdRef.current;
    lastScopedTenantIdRef.current = scopedTenantId || prev;

    if (!prev || !scopedTenantId || scopedTenantId === prev) return;

    // 世代カウンタを切替の時点で即座に進める(sendReal呼び出しより前)。まだ完了して
    // いない直前の呼び出し(この後始まる bootstrap 側の onboarding 判定を含む)を
    // ここで無効化してから会話をリセットする(P2-1)。
    requestEpochRef.current += 1;
    const myEpoch = requestEpochRef.current;

    // 会話・履歴・sessionId・進捗カウント・保存済みセッション(前テナントのもの)を
    // すべて破棄してから、新テナントの週次ブリーフィングを取り直す。
    clearChatSession(CHAT_SESSION_SURFACE_FULLSCREEN);
    setMsgs([]);
    setRealHistory([]);
    setRealActionCount(0);
    adoptSessionId(crypto.randomUUID());

    // force:true — 直前の切替の応答待ち(sending中)でも必ずこの切替を発火させる。
    // 「新しい切替」は「前のテナントの応答待ち」より常に優先されるべきで、
    // 追い越された古い呼び出し側は sendReal 内の世代カウンタが無害化する。
    void runOnboardingAwareBriefing(myEpoch, {
      hasRestoredConversation: false,
      force: true,
      loadingText: "テナントを切り替えました。今週の実データを確認しています…",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopedTenantId]);

  // テナント選択用の一覧。既存の GET /v1/admin/tenants(super_admin限定)をそのまま使う。
  const [tenants, setTenants] = useState<TenantOption[] | null>(null);
  const [tenantsFailed, setTenantsFailed] = useState(false);
  useEffect(() => {
    if (!needsTenantSelection) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch(`${API_BASE}/v1/admin/tenants`);
        if (!res.ok) {
          if (!cancelled) setTenantsFailed(true);
          return;
        }
        const data = (await res.json()) as { tenants?: TenantOption[] };
        if (!cancelled) setTenants(data.tenants ?? []);
      } catch {
        if (!cancelled) setTenantsFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [needsTenantSelection]);

  // 会話が更新されるたびに同一タブへ保存する。タイプライター演出は16ms毎にmsgsを
  // 書き換えるため、そのまま保存すると1応答で数百回の書き込みになる。少し待って
  // 落ち着いた状態だけを書き込む。
  useEffect(() => {
    if (msgs.length === 0) return;
    const timer = setTimeout(() => {
      saveChatSession(CHAT_SESSION_SURFACE_FULLSCREEN, {
        sessionId: realSessionId,
        messages: msgs,
        history: realHistory,
        tenantId: scopedTenantId || null,
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [msgs, realHistory, realSessionId, scopedTenantId]);

  // 新UI(サイドバー型ではないため)にはログアウト手段が無く、Phase4トグルで
  // このブラウザの既定画面にすると詰む(GID: 新UI常用時にログアウトできない)。
  // previewMode(super_adminのクライアントビュー)中も、実ログインユーザーは
  // super_adminのため、ここでのログアウトは正しくsuper_admin自身を退出させる。
  const handleLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  const runAction = (action: string, fromMsgId: number) => {
    consumeChips(fromMsgId);
    // チップは全て実APIへの返信（sendReal 側で me() を積むため、ここでは積まない）
    void sendReal(action.startsWith("__real:") ? action.slice("__real:".length) : action);
  };

  // 会話中は今アクティブなカテゴリー以外への切り替えを禁止する。応答が同じ
  // スレッドに割り込んで別カテゴリーの応答と混ざるのを防ぐため。
  // 「会話中」の定義:
  //   - sending: 実APIの応答待ち〜タイプライター演出完了まで
  //   - awaitingUserDecision: 直前のAIメッセージにまだ選ばれていないチップが残っている
  //     (＝suggest_*の下書きやSai依頼の確認待ちで、ユーザーの選択待ち)
  // いずれかがtrueの間はロックし、実APIの応答が完了すると自動的に解放される。
  const lastMsg = msgs[msgs.length - 1];
  const awaitingUserDecision =
    !!lastMsg && lastMsg.role === "ai" && !!lastMsg.chips && lastMsg.chips.length > 0 && !lastMsg.chipsUsed;
  const busy = sending || awaitingUserDecision;

  // 相談窓口の入口: 直近のAI回答の下に「解決しましたか？」を出す(パネルと同じ導線)。
  // 出さない場合:
  //   - 応答待ち・タイプライター中(sending) / まだチップを選んでいない(awaitingUserDecision)
  //   - ユーザーが一度も質問していない(起動時ブリーフィングだけの状態)。聞いてもいない
  //     ことに「解決しましたか？」と尋ねる形になるため。
  const lastUserText = msgs.reduce<string | undefined>(
    (acc, m) => (m.role === "me" && m.text ? m.text : acc),
    undefined,
  );
  const showResolutionPrompt =
    !busy && !!lastUserText && !!lastMsg && lastMsg.role === "ai" && !!lastMsg.text;

  // ボタン側のdisabledで大半は弾かれるが、ここでも二重に防御する。
  const handleCategory = (key: string) => {
    if (busy && key !== active) return;
    setActive(key);
    setRailOpen(false); // モバイル: カテゴリー選択でドロワーを閉じる(デスクトップでは無害)
    if (key === "weekly") {
      // BOOTSTRAP_PROMPT と同じ依頼文・同じツールに着地する。関係は「必ず再取得する」で
      // 統一済み(BOOTSTRAP_PROMPT のコメント参照)。ここでキャッシュや直近取得のスキップは
      // 行わない — クリックした瞬間の最新状況を見せるのがこのカテゴリの役割。
      void sendReal("今週の状況を教えてください。要点と次にやるべきことを最大3つまで、簡潔に教えてください。");
    } else if (key === "escalations") {
      void sendReal("対応中のエスカレーションの状況を教えて");
    } else if (key === "history") {
      // 会話の履歴は「点検(品質を確かめる)」と「照会(特定の1件を探す)」で送る内容が
      // 別物なので、定型プロンプト1本を即送信していた旧挙動をやめ、既存のチップ機構
      // (__real: プレフィックスで自然文を代理送信)でユーザーに選ばせる。
      // sendReal経由ではなくpushで直接積むため sendReal 自身の sending ガードが効かず、
      // 既にチップ提示中(active === "history" かつ busy)に連打すると同じ質問が
      // 積み上がってしまう。ここだけ明示的に多重投入を防ぐ。
      if (busy) return;
      push(say("会話の履歴について、何をしますか？", [
        {
          label: "最近の会話を点検する",
          action: "__real:直近の会話を点検して、対応品質に問題がありそうな会話があれば教えて",
          tone: "primary",
        },
        { label: "特定の会話を探す", action: "__real:特定の会話を探したい", tone: "ghost" },
      ]));
    } else if (key === "avatar") {
      void sendReal("アバターの稼働状況と、設定の一覧を教えて");
    } else if (key === "knowledge") {
      // Phase E: get_faq_list/get_knowledge_gaps(実API)に接続。以前はモック固定文言だった
      void sendReal("知識データの状況を教えて（FAQの件数と、AIが答えられなかった質問があれば教えて）");
    } else if (key === "rules") {
      // Phase B: get_tuning_rules(実API)に接続。以前はモック固定文言だった
      void sendReal("指示ルールの状況を教えて");
    }
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text || sending) return;
    // チップ(保存して/やめておく)を無視して別の話題を打った場合、そのままだと未使用の
    // チップが宙ぶらりんで残り、新しい応答の横に古い選択肢が並んでしまう。入力欄は
    // 塞がず(=「やっぱりいいです」と打てるようにしたまま)、送信時に使用済みにする。
    if (lastMsg && awaitingUserDecision) consumeChips(lastMsg.id);
    setInput("");
    void sendReal(text);
  };

  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (shouldSubmitOnEnter(e, isComposing)) {
      e.preventDefault();
      handleSend();
    }
  };

  // ─── PDF取り込み(コンポーザへのドラッグ＆ドロップ / 📎ボタン) ─────────────────
  // 会話ではなくファイルそのものが指示なので、LLMのツール呼び出しループは通さず、旧UIの
  // PDFタブと同じ既存エンドポイントへ直接送る。エージェントに「アップロードするか」を
  // 判断させる余地は無い(落とした行為が意思表示そのもの)。
  const uploadUrl = isSuperAdmin && scopedTenantId
    ? `${API_BASE}/v1/admin/knowledge/book-pdf?tenant=${encodeURIComponent(scopedTenantId)}`
    : `${API_BASE}/v1/admin/knowledge/book-pdf`;

  // GID 1217040818410419: previewMode中はisSuperAdminがclient_admin相当に落ちる(useAuth.tsx:213-214)
  // ため、ここで isSuperAdmin(上の派生値)を使うと previewMode中のsuper_admin自身からもPDF投入が
  // 消えてしまう。生のロールで判定する(この画面はテナントとsuper_adminのpreviewの両方が通る)。
  const canUploadBookPdf = user?.role === "super_admin";

  const pdfInputRef = useRef<HTMLInputElement>(null);
  const [pdfDragOver, setPdfDragOver] = useState(false);
  const pdfDragCounterRef = useRef(0);

  const updatePdfCard = useCallback((msgId: number, patch: Partial<Extract<Card, { kind: "pdfUpload" }>>) => {
    setMsgs((prev) =>
      prev.map((m) =>
        m.id === msgId && m.card?.kind === "pdfUpload" ? { ...m, card: { ...m.card, ...patch } } : m,
      ),
    );
  }, []);

  const acceptFiles = async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    // GID 1217040818410419: 書籍/PDF取り込みはR2C運用限定。通信前にこの場で優しく断る
    // (拡張子/サイズの受付判定と同じく、対象外の相手には通信させない)。
    if (!canUploadBookPdf) {
      push({
        id: nextId(),
        role: "ai",
        card: {
          kind: "pdfUpload",
          status: "error",
          fileName: fileArray.length === 1 ? fileArray[0].name : `${fileArray.length}件のファイル`,
          message: PDF_UPLOAD_TENANT_RESTRICTED_MESSAGE,
        },
      });
      return;
    }

    const accepted: { file: File; isZip: boolean }[] = [];
    for (const file of fileArray) {
      const verdict = validateBookPdfFile(file);
      if (verdict.kind === "rejected") {
        // 受け付けない形式・大きさは通信する前にこの場で断る
        push({
          id: nextId(),
          role: "ai",
          card: {
            kind: "pdfUpload",
            status: "error",
            fileName: file.name,
            message: PDF_REJECTION_MESSAGE[verdict.reason],
          },
        });
        continue;
      }
      accepted.push({ file, isZip: verdict.kind === "zip" });
    }
    if (accepted.length === 0) return;

    const token = await getAccessToken();

    // 旧UIと同じく1件ずつ順に送る(同時送信で回線と取り込みキューを圧迫しないため)
    for (const { file, isZip } of accepted) {
      const cardId = nextId();
      push({
        id: cardId,
        role: "ai",
        card: { kind: "pdfUpload", status: "uploading", fileName: file.name, progress: 0 },
      });

      const form = new FormData();
      form.append("file", file);
      // ZIPはサーバー側が中の各PDFのファイル名からタイトルを付けるため送らない
      if (!isZip) form.append("title", defaultBookTitle(file.name));

      const { status, body, networkError } = await uploadBookPdfWithProgress(
        uploadUrl,
        form,
        token,
        (pct) => updatePdfCard(cardId, { progress: pct }),
      );

      if (networkError) {
        updatePdfCard(cardId, { status: "error", message: PDF_UPLOAD_NETWORK_ERROR });
        continue;
      }

      if (status < 200 || status >= 300) {
        const kind = classifyUploadStatus(status);
        const serverMessage = (body as { error?: string } | null)?.error;
        updatePdfCard(cardId, {
          status: "error",
          message:
            kind === "auth" ? PDF_UPLOAD_AUTH_ERROR
            : kind === "too_large" ? PDF_UPLOAD_TOO_LARGE_ERROR
            : serverMessage || PDF_UPLOAD_GENERIC_ERROR,
        });
        continue;
      }

      if (isZip) {
        const results = (body as { results?: { status: string }[] } | null)?.results ?? [];
        const okCount = results.filter((r) => r.status === "ok").length;
        if (okCount === 0) {
          updatePdfCard(cardId, { status: "error", message: PDF_UPLOAD_ZIP_EMPTY_ERROR });
          continue;
        }
        updatePdfCard(cardId, {
          status: "success",
          message: `${okCount}件のPDFを受け取りました。読み込みが終わると、内容から答えられるようになります。`,
        });
      } else {
        updatePdfCard(cardId, {
          status: "success",
          message: "読み込みが終わると、この資料の内容から答えられるようになります。",
        });
      }
      // 他の書き込み操作と同じく、実際にDBへ入った件数としてヘッダーのバッジに反映する
      setRealActionCount((n) => n + 1);
    }
  };

  // ─── アバター画像候補の生成・採用(採用が気に入らなかった場合の分岐) ────────────
  // PDF取り込みと同じ理由でエージェントツール経由にしない: 画像URL群はツール結果の
  // 500字に収まらない。プロンプトは wizard と同じ buildAvatarPrompt を固定の標準的な
  // 選択(人物・バストショット・自然な笑顔・シンプル背景)で使う。チャットは選択肢を
  // 集めない(「選ばせない」方針)ため、雰囲気を変えたい場合は生成をやり直すだけで良い。
  const updateAvatarCandidatesCard = useCallback((msgId: number, patch: Partial<Extract<Card, { kind: "avatarCandidates" }>>) => {
    setMsgs((prev) =>
      prev.map((m) =>
        m.id === msgId && m.card?.kind === "avatarCandidates" ? { ...m, card: { ...m.card, ...patch } } : m,
      ),
    );
  }, []);

  const generateAvatarCandidates = async (configId: string, name: string, promptInput: AvatarPromptInput) => {
    const cardId = nextId();
    push({ id: cardId, role: "ai", card: { kind: "avatarCandidates", configId, name, status: "generating", promptInput } });

    const { prompt } = buildAvatarPrompt(promptInput);

    // previewMode(super_adminのクライアントビュー)中は操作対象テナントを
    // ?tenant= で明示する。付けないとバックエンドが自身の(空の)テナントで
    // 課金・保存してしまう(uploadUrl と同じ既存パターン、#P0-2)。
    const generateUrl = isSuperAdmin && scopedTenantId
      ? `${API_BASE}/v1/admin/avatar/fal/generate?tenant=${encodeURIComponent(scopedTenantId)}`
      : `${API_BASE}/v1/admin/avatar/fal/generate`;

    try {
      const res = await authFetch(generateUrl, {
        method: "POST",
        body: JSON.stringify({ prompt, numImages: 4 }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        updateAvatarCandidatesCard(cardId, { status: "failed", message: body?.error || AVATAR_GENERATE_GENERIC_ERROR });
        return;
      }
      const data = (await res.json()) as { images?: string[] };
      const images = data.images ?? [];
      if (images.length === 0) {
        updateAvatarCandidatesCard(cardId, { status: "failed", message: AVATAR_GENERATE_GENERIC_ERROR });
        return;
      }
      updateAvatarCandidatesCard(cardId, { status: "done", images });
    } catch (err) {
      const message =
        (err as { message?: string } | null)?.message === "__AUTH_REQUIRED__"
          ? AGENT_CHAT_AUTH_REQUIRED_MESSAGE
          : AVATAR_GENERATE_GENERIC_ERROR;
      updateAvatarCandidatesCard(cardId, { status: "failed", message });
    }
  };

  // W3-3(docs/COPILOT_UI_PARITY.md §3.1 #10): 高品質画像(Flux 2 Pro + Magnific、1枚)の
  // 生成。generateAvatarCandidatesと違いconfirmingを経てから呼ばれる(通常生成より
  // 高い費用がかかるため、AvatarAdoptedCard側で「生成する/やめる」の確認を挟む。
  // Asana制約U-17: 繰り返し頼まれても毎回明示する — ここではボタン側で確認状態を
  // 生成完了/キャンセルのたびにリセットすることで満たす)。採用(PATCH)はimages配列に
  // 1枚だけ入れてavatarCandidates/adoptAvatarCandidateをそのまま使う。
  const generatePremiumAvatarCandidate = async (configId: string, name: string, promptInput: AvatarPromptInput) => {
    const cardId = nextId();
    push({ id: cardId, role: "ai", card: { kind: "avatarCandidates", configId, name, status: "generating", premium: true, promptInput } });

    const { prompt } = buildAvatarPrompt(promptInput);

    const generateUrl = isSuperAdmin && scopedTenantId
      ? `${API_BASE}/v1/admin/avatar/generate-premium?tenant=${encodeURIComponent(scopedTenantId)}`
      : `${API_BASE}/v1/admin/avatar/generate-premium`;

    try {
      const res = await authFetch(generateUrl, {
        method: "POST",
        body: JSON.stringify({ prompt }),
      });
      if (!res.ok) {
        // plan_upgrade_required等はerrorがコード・messageが日本語文言(voice-cloneと同じ
        // dual-field形状)。messageを優先し、無ければerrorをそのまま出す。
        const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
        updateAvatarCandidatesCard(cardId, { status: "failed", message: body?.message || body?.error || AVATAR_PREMIUM_GENERATE_GENERIC_ERROR });
        return;
      }
      const data = (await res.json()) as { imageUrl?: string };
      if (!data.imageUrl) {
        updateAvatarCandidatesCard(cardId, { status: "failed", message: AVATAR_PREMIUM_GENERATE_GENERIC_ERROR });
        return;
      }
      updateAvatarCandidatesCard(cardId, { status: "done", images: [data.imageUrl] });
    } catch (err) {
      const message =
        (err as { message?: string } | null)?.message === "__AUTH_REQUIRED__"
          ? AGENT_CHAT_AUTH_REQUIRED_MESSAGE
          : AVATAR_PREMIUM_GENERATE_GENERIC_ERROR;
      updateAvatarCandidatesCard(cardId, { status: "failed", message });
    }
  };

  const adoptAvatarCandidate = async (cardMsgId: number, configId: string, imageUrl: string) => {
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/avatar/configs/${configId}`, {
        method: "PATCH",
        body: JSON.stringify({ image_url: imageUrl }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        updateAvatarCandidatesCard(cardMsgId, { message: body?.error || AVATAR_ADOPT_GENERIC_ERROR });
        return;
      }
      updateAvatarCandidatesCard(cardMsgId, { adoptedUrl: imageUrl });
      setRealActionCount((n) => n + 1);
    } catch (err) {
      const message =
        (err as { message?: string } | null)?.message === "__AUTH_REQUIRED__"
          ? AGENT_CHAT_AUTH_REQUIRED_MESSAGE
          : AVATAR_ADOPT_GENERIC_ERROR;
      updateAvatarCandidatesCard(cardMsgId, { message });
    }
  };

  // ─── アバター画像の自前アップロード(写真をアバターにする) ─────────────────────
  // W3-1(docs/COPILOT_UI_PARITY.md §3.1 #8): PDF取り込みと同じくエージェントツール
  // 経由にせず、ファイル選択の瞬間に確定する(落とした行為が意思表示そのもの)。
  // adoptAvatarCandidateと同じPATCHエンドポイントを使うが、対象カード種別が異なる
  // (avatarPhotoUploadは常に新規カードとして積む。候補一覧を持たないため)ため、
  // 更新関数を共有しない。
  const updateAvatarPhotoUploadCard = useCallback((msgId: number, patch: Partial<Extract<Card, { kind: "avatarPhotoUpload" }>>) => {
    setMsgs((prev) =>
      prev.map((m) =>
        m.id === msgId && m.card?.kind === "avatarPhotoUpload" ? { ...m, card: { ...m.card, ...patch } } : m,
      ),
    );
  }, []);

  const uploadAvatarPhoto = async (configId: string, file: File) => {
    const rejection = validateAvatarPhotoFile(file);
    if (rejection) {
      // 受け付けない形式・大きさは通信する前にこの場で断る(PDF取り込みと同じ作法)
      push({ id: nextId(), role: "ai", card: { kind: "avatarPhotoUpload", configId, status: "error", fileName: file.name, message: rejection } });
      return;
    }

    const cardId = nextId();
    push({ id: cardId, role: "ai", card: { kind: "avatarPhotoUpload", configId, status: "uploading", fileName: file.name } });

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    }).catch(() => null);

    if (!dataUrl) {
      updateAvatarPhotoUploadCard(cardId, { status: "error", message: AVATAR_PHOTO_UPLOAD_ERROR });
      return;
    }

    try {
      const res = await authFetch(`${API_BASE}/v1/admin/avatar/configs/${configId}`, {
        method: "PATCH",
        body: JSON.stringify({ image_url: dataUrl }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        updateAvatarPhotoUploadCard(cardId, { status: "error", message: body?.error || AVATAR_PHOTO_UPLOAD_ERROR });
        return;
      }
      updateAvatarPhotoUploadCard(cardId, { status: "success", imageUrl: dataUrl });
      setRealActionCount((n) => n + 1);
    } catch (err) {
      const message =
        (err as { message?: string } | null)?.message === "__AUTH_REQUIRED__"
          ? AGENT_CHAT_AUTH_REQUIRED_MESSAGE
          : AVATAR_PHOTO_UPLOAD_ERROR;
      updateAvatarPhotoUploadCard(cardId, { status: "error", message });
    }
  };

  // ─── アバターの声の選択・採用 ─────────────────────────────────────────────────
  // POST /match-voice はテキストの候補(id/title/description/score)のみを返す
  // (旧UIウィザードのStudioVoiceSectionも同様に試聴機能を持たない。Fish Audio
  // 検索APIの応答に音声プレビューURLが含まれないため)。「声の説明」は新たに
  // 尋ねず、採用済みアバターの性格・話し方の説明をそのまま検索クエリに使う
  // (「選ばせない」方針。ユーザーは声だけの追加質問に答えなくてよい)。
  const updateAvatarVoiceCard = useCallback((msgId: number, patch: Partial<Extract<Card, { kind: "avatarVoiceCandidates" }>>) => {
    setMsgs((prev) =>
      prev.map((m) =>
        m.id === msgId && m.card?.kind === "avatarVoiceCandidates" ? { ...m, card: { ...m.card, ...patch } } : m,
      ),
    );
  }, []);

  const matchAvatarVoice = async (configId: string, description: string) => {
    const cardId = nextId();
    const boundedDescription = description.slice(0, 300);
    push({ id: cardId, role: "ai", card: { kind: "avatarVoiceCandidates", configId, description: boundedDescription, status: "matching" } });

    // previewMode中は操作対象テナントを ?tenant= で明示する(generateAvatarCandidates
    // と同じ理由、#P0-2)。
    const matchVoiceUrl = isSuperAdmin && scopedTenantId
      ? `${API_BASE}/v1/admin/avatar/match-voice?tenant=${encodeURIComponent(scopedTenantId)}`
      : `${API_BASE}/v1/admin/avatar/match-voice`;

    try {
      const res = await authFetch(matchVoiceUrl, {
        method: "POST",
        body: JSON.stringify({ description: boundedDescription }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        updateAvatarVoiceCard(cardId, { status: "failed", message: body?.error || AVATAR_VOICE_MATCH_GENERIC_ERROR });
        return;
      }
      const data = (await res.json()) as { recommendations?: Array<{ id: string; title: string; description: string; score: number }> };
      const recommendations = data.recommendations ?? [];
      if (recommendations.length === 0) {
        updateAvatarVoiceCard(cardId, { status: "failed", message: AVATAR_VOICE_MATCH_EMPTY_ERROR });
        return;
      }
      updateAvatarVoiceCard(cardId, { status: "done", recommendations });
    } catch (err) {
      const message =
        (err as { message?: string } | null)?.message === "__AUTH_REQUIRED__"
          ? AGENT_CHAT_AUTH_REQUIRED_MESSAGE
          : AVATAR_VOICE_MATCH_GENERIC_ERROR;
      updateAvatarVoiceCard(cardId, { status: "failed", message });
    }
  };

  const adoptAvatarVoice = async (cardMsgId: number, configId: string, voiceId: string) => {
    try {
      const res = await authFetch(`${API_BASE}/v1/admin/avatar/configs/${configId}`, {
        method: "PATCH",
        body: JSON.stringify({ voice_id: voiceId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        updateAvatarVoiceCard(cardMsgId, { message: body?.error || AVATAR_VOICE_ADOPT_GENERIC_ERROR });
        return;
      }
      updateAvatarVoiceCard(cardMsgId, { adoptedVoiceId: voiceId });
      setRealActionCount((n) => n + 1);
    } catch (err) {
      const message =
        (err as { message?: string } | null)?.message === "__AUTH_REQUIRED__"
          ? AGENT_CHAT_AUTH_REQUIRED_MESSAGE
          : AVATAR_VOICE_ADOPT_GENERIC_ERROR;
      updateAvatarVoiceCard(cardMsgId, { message });
    }
  };

  // GID 1217084040141851: 説明文から声を作る(Fish Audio Voice Design)。
  // matchAvatarVoiceと同じカード(avatarVoiceCandidates)をmode="design"で使う。
  const designAvatarVoice = async (configId: string, instruction: string) => {
    const cardId = nextId();
    const boundedInstruction = instruction.slice(0, 2000);
    push({ id: cardId, role: "ai", card: { kind: "avatarVoiceCandidates", configId, description: boundedInstruction, status: "matching", mode: "design" } });

    const designVoiceUrl = isSuperAdmin && scopedTenantId
      ? `${API_BASE}/v1/admin/avatar/design-voice?tenant=${encodeURIComponent(scopedTenantId)}`
      : `${API_BASE}/v1/admin/avatar/design-voice`;

    try {
      const res = await authFetch(designVoiceUrl, {
        method: "POST",
        body: JSON.stringify({ instruction: boundedInstruction }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        updateAvatarVoiceCard(cardId, { status: "failed", message: body?.error || AVATAR_VOICE_DESIGN_GENERIC_ERROR });
        return;
      }
      const data = (await res.json()) as {
        candidates?: Array<{ id: string; audioBase64: string; text: string | null }>;
      };
      const audioCandidates = data.candidates ?? [];
      if (audioCandidates.length === 0) {
        updateAvatarVoiceCard(cardId, { status: "failed", message: AVATAR_VOICE_DESIGN_EMPTY_ERROR });
        return;
      }
      updateAvatarVoiceCard(cardId, { status: "done", audioCandidates });
    } catch (err) {
      const message =
        (err as { message?: string } | null)?.message === "__AUTH_REQUIRED__"
          ? AGENT_CHAT_AUTH_REQUIRED_MESSAGE
          : AVATAR_VOICE_DESIGN_GENERIC_ERROR;
      updateAvatarVoiceCard(cardId, { status: "failed", message });
    }
  };

  // GID 1217084040141851: design-voice候補(base64 WAV)を永続音声モデルとして採用する。
  // 音声はJSONではなくmultipartで送る(候補WAVはexpress.json()のグローバル上限1mbを
  // 超えうるため。バックエンド側もmultipartで受ける実装)。
  const adoptDesignedVoice = async (cardMsgId: number, configId: string, candidateId: string) => {
    const card = msgs.find((m) => m.id === cardMsgId)?.card;
    const candidate =
      card?.kind === "avatarVoiceCandidates"
        ? card.audioCandidates?.find((c) => c.id === candidateId)
        : undefined;
    if (!candidate) return;

    try {
      const audioBytes = Uint8Array.from(atob(candidate.audioBase64), (c) => c.charCodeAt(0));
      const audioBlob = new Blob([audioBytes], { type: "audio/wav" });
      const form = new FormData();
      form.append("name", `設計した声-${candidateId.slice(0, 8)}`);
      form.append("audio", audioBlob, "candidate.wav");

      const res = await fetchWithAuth(
        `${API_BASE}/v1/admin/avatar/configs/${configId}/adopt-designed-voice`,
        { method: "POST", body: form },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        updateAvatarVoiceCard(cardMsgId, { message: body?.error || AVATAR_VOICE_ADOPT_GENERIC_ERROR });
        return;
      }
      const data = (await res.json()) as { voiceId: string };
      updateAvatarVoiceCard(cardMsgId, { adoptedVoiceId: data.voiceId });
      setRealActionCount((n) => n + 1);
    } catch (err) {
      const message =
        (err as { message?: string } | null)?.message === "__AUTH_REQUIRED__"
          ? AGENT_CHAT_AUTH_REQUIRED_MESSAGE
          : AVATAR_VOICE_ADOPT_GENERIC_ERROR;
      updateAvatarVoiceCard(cardMsgId, { message });
    }
  };

  // ─── 音声クローン(自分の声を添付してアバターの声にする) ───────────────────────
  // W3-2(docs/COPILOT_UI_PARITY.md §3.1 #9): PDF取り込み・写真アップロードと同じく
  // エージェントツール経由にせず、ファイル選択の瞬間に確定する。POST /voice-clone は
  // 単発でvoice_idを確定・保存するため(adoptDesignedVoiceのような別ステップの採用は
  // 無い)、成功時にそのままadoptedVoiceIdへ反映する。avatarVoiceCandidatesカードを
  // mode="clone"で使い、新しいカード種別は増やさない(Asana制約)。
  const cloneAvatarVoice = async (configId: string, avatarName: string, file: File) => {
    const rejection = validateVoiceCloneFile(file);
    if (rejection) {
      push({ id: nextId(), role: "ai", card: { kind: "avatarVoiceCandidates", configId, description: "", status: "failed", mode: "clone", fileName: file.name, message: rejection } });
      return;
    }

    const cardId = nextId();
    push({ id: cardId, role: "ai", card: { kind: "avatarVoiceCandidates", configId, description: "", status: "matching", mode: "clone", fileName: file.name } });

    try {
      const form = new FormData();
      // 旧UI(StudioVoiceCloneSection.tsx)はクローン名を店主に入力させるが、チャットでは
      // 「選ばせない」方針(AVATAR_CHAT_MIGRATION.md §3)に沿ってアバター名から自動生成する。
      form.append("name", `${avatarName}の声`.slice(0, 100));
      form.append("audio", file);

      const res = await fetchWithAuth(`${API_BASE}/v1/admin/avatar/configs/${configId}/voice-clone`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
        // plan_upgrade_required等はerrorがコード・messageが日本語文言(他の直叩きエンドポイントの
        // {error:"<日本語>"}単一形式と異なる)。messageを優先し、無ければerrorをそのまま出す。
        updateAvatarVoiceCard(cardId, { status: "failed", message: body?.message || body?.error || VOICE_CLONE_GENERIC_ERROR });
        return;
      }
      const data = (await res.json()) as { voiceId: string };
      updateAvatarVoiceCard(cardId, { status: "done", adoptedVoiceId: data.voiceId });
      setRealActionCount((n) => n + 1);
    } catch (err) {
      const message =
        (err as { message?: string } | null)?.message === "__AUTH_REQUIRED__"
          ? AGENT_CHAT_AUTH_REQUIRED_MESSAGE
          : VOICE_CLONE_GENERIC_ERROR;
      updateAvatarVoiceCard(cardId, { status: "failed", message });
    }
  };

  const handlePdfDrop = (e: React.DragEvent) => {
    e.preventDefault();
    pdfDragCounterRef.current = 0;
    setPdfDragOver(false);
    if (e.dataTransfer.files.length > 0) void acceptFiles(e.dataTransfer.files);
  };

  const handlePdfDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    pdfDragCounterRef.current += 1;
    setPdfDragOver(true);
  };

  const handlePdfDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    pdfDragCounterRef.current -= 1;
    if (pdfDragCounterRef.current <= 0) {
      pdfDragCounterRef.current = 0;
      setPdfDragOver(false);
    }
  };

  // ドラッグ＆ドロップができない環境(モバイル・キーボード操作)向けの同等手段
  const handlePdfInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      void acceptFiles(e.target.files);
      e.target.value = "";
    }
  };

  // ─── レイアウト ───────────────────────────────────────────────────────────
  if (needsTenantSelection) {
    return (
      <TenantSelection
        tenants={tenants}
        failed={tenantsFailed}
        onSelect={(t) => enterPreview(t.id, t.name)}
      />
    );
  }

  return (
    <div
      className="cp-shell"
      style={{
        display: "flex",
        background: "var(--background)",
        color: "var(--foreground)",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
        overflow: "hidden",
        // previewMode中はPreviewModeBanner分の高さをcp-shellのheight計算から差し引く(index.css参照)。
        // PreviewModeBannerが実測してdocumentElementに書き込むCSS変数を優先し、初回描画など
        // まだ計測前の一瞬だけ定数値にフォールバックする(GID 1217808308055510: 固定値だけだと
        // テナント名の長さ・折り返しでズレて後続のヘッダーに重なる)。
        ["--cp-banner-h" as string]: previewMode
          ? `var(${PREVIEW_BANNER_HEIGHT_CSS_VAR}, ${PREVIEW_MODE_BANNER_HEIGHT}px)`
          : "0px",
      } as React.CSSProperties}
    >
      {/* モバイル: ドロワーが開いている間の背景オーバーレイ。外側タップで閉じる */}
      {railOpen && (
        <div className="cp-rail-backdrop" onClick={() => setRailOpen(false)} aria-hidden="true" />
      )}
      {/* 左レール(=各カテゴリはAIブリーフィングの窓口)。モバイルではドロワー化(index.css参照) */}
      <aside className={`cp-rail${railOpen ? " cp-rail-open" : ""}`} style={{ width: 248, flexShrink: 0, background: "var(--sidebar, var(--card))", borderRight: "1px solid var(--border)", padding: "20px 14px", display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ fontWeight: 900, fontSize: 18, letterSpacing: "-0.03em", padding: "4px 8px 6px" }}>
            R2C
            <span style={{ fontSize: 11, fontWeight: 700, color: AGENT, background: AGENT_SOFT, padding: "2px 8px", borderRadius: 6, marginLeft: 7, letterSpacing: "0.04em" }}>店主モード</span>
          </div>
          <button
            className="cp-menu-btn"
            onClick={() => setRailOpen(false)}
            aria-label="メニューを閉じる"
            style={{ border: "none", background: "transparent", color: "var(--muted-foreground)", cursor: "pointer", minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", fontSize: 18, borderRadius: 10, flexShrink: 0 }}
          >
            ✕
          </button>
        </div>
        {/* AppSwitcher (R2C ⇄ R2C2)。旧UI(AppSidebar)と同じくヘッダー直下に配置。
            この画面には旧UIのチャットパネル(Surface A)が無いため、ロックタブの
            質問はこの画面自身のチャットへ流す(onSeedQuery)。 */}
        <div style={{ padding: "0 2px" }}>
          <AppSwitcher onSeedQuery={(query) => void sendReal(query)} />
        </div>
        {/* GID 1217808308055510: 「PROTOTYPE」バッジはsuper_adminの検証用ラベル。
            テナント本人の通常アクセス(previewMode=false)では出さない — この画面は
            チャット・ファーストUIとしてテナントにも表示されうるため、常時表示だと
            製品が試作品に見えてしまう。 */}
        {previewMode && <PreviewBadge />}
        {CATEGORIES.map((c) => {
          const locked = busy && c.key !== active;
          const count = c.badge ? railCounts[c.badge] : undefined;
          return (
            <button
              key={c.key}
              onClick={() => handleCategory(c.key)}
              disabled={locked}
              title={locked ? "会話が完了するまで他のカテゴリーには切り替えられません" : undefined}
              style={{
                display: "flex", alignItems: "center", gap: 11, textAlign: "left",
                padding: "11px 12px", borderRadius: 10, border: "none",
                cursor: locked ? "not-allowed" : "pointer",
                fontSize: 15, fontWeight: active === c.key ? 700 : 500,
                color: active === c.key ? AGENT : "var(--muted-foreground)",
                background: active === c.key ? AGENT_SOFT : "transparent",
                opacity: locked ? 0.35 : c.dim ? 0.55 : 1, minHeight: 44,
              }}
            >
              <span style={{ fontSize: 18 }}>{c.icon}</span>
              <span style={{ minWidth: 0 }}>{c.label}</span>
              {/* 0件はバッジを出さない(「0」は情報ではなくノイズになる) */}
              {c.badge && count !== undefined && count > 0 && (
                <RailCountBadge count={count} label={RAIL_BADGE_LABEL[c.badge]} />
              )}
            </button>
          );
        })}
        <div style={{ marginTop: "auto" }}>
          <Phase4DefaultToggle />
          <div style={{ fontSize: 12, color: "var(--muted-foreground)", lineHeight: 1.55, padding: "10px" }}>
            「くわしい設定」は従来画面のまま。会話UIは<strong style={{ color: "var(--foreground)" }}>追加</strong>で、既存は消していません。
          </div>
          {/* テーマ切替・言語切替。旧UI(AppSidebar)フッターと同じ並び(設定行→ログアウト) */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 8px", marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>テーマ</span>
            <ThemeToggle />
          </div>
          <div style={{ padding: "0 8px", marginBottom: 10 }}>
            <LangSwitcher />
          </div>
          <button
            onClick={() => void handleLogout()}
            title={previewMode ? "Super Adminとしてログアウトします（クライアントビューの「元に戻す」とは別の操作です）" : "ログアウト"}
            style={{
              display: "flex", alignItems: "center", gap: 10, width: "calc(100% - 16px)", margin: "2px 8px 0",
              padding: "11px 12px", borderRadius: 10, border: "1px solid var(--border)",
              background: "transparent", cursor: "pointer", textAlign: "left",
              fontSize: 13, color: "var(--muted-foreground)", minHeight: 44,
            }}
          >
            <LogOut size={16} />
            ログアウト
          </button>
        </div>
      </aside>

      {/* チャット本体 */}
      <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* ヘッダー */}
        <header className="cp-header" style={{ display: "flex", alignItems: "center", gap: 14, borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <button
            className="cp-menu-btn"
            onClick={() => setRailOpen(true)}
            aria-label="メニューを開く"
            aria-expanded={railOpen}
            style={{ border: "none", background: "transparent", color: "var(--foreground)", cursor: "pointer", minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center", fontSize: 20, borderRadius: 10, flexShrink: 0 }}
          >
            ☰
          </button>
          <AgentMark />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 17 }}>R2Cエージェント</div>
            <div style={{ fontSize: 13, color: "var(--muted-foreground)", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 0 3px rgba(34,197,94,0.15)" }} />オンライン
            </div>
          </div>
          {/* 通知ベル: モバイルではcp-railがドロワー化しoverflow-y:autoでポップオーバーが
              見切れうるため、常時表示のcp-header側に置く(cp-railのoverflow影響を受けない) */}
          <NotificationBell />
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
            <RealActionBadge count={realActionCount} />
          </div>
        </header>

        {/* スレッド */}
        <div ref={threadRef} className="cp-thread" style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ width: "100%", maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>
            {msgs.map((m) => (
              <MessageRow
                key={m.id}
                m={m}
                onChip={runAction}
                onGenerateAvatarCandidates={generateAvatarCandidates}
                onGeneratePremiumAvatarCandidate={generatePremiumAvatarCandidate}
                onAdoptAvatarCandidate={adoptAvatarCandidate}
                onUploadAvatarPhoto={uploadAvatarPhoto}
                onCloneAvatarVoice={cloneAvatarVoice}
                onMatchAvatarVoice={matchAvatarVoice}
                onAdoptAvatarVoice={adoptAvatarVoice}
                onDesignAvatarVoice={designAvatarVoice}
                onAdoptDesignedVoice={adoptDesignedVoice}
              />
            ))}
            {/* key に直近メッセージのidを与え、回答が変わるたびに新しい確認として出す
                (前の回答で「はい」を押した状態を持ち越さない) */}
            {showResolutionPrompt && <ResolutionPrompt key={lastMsg.id} question={lastUserText} />}
          </div>
        </div>

        {/* コンポーザ（実API接続）。PDFはここへ落とすと会話の中で取り込みが始まる */}
        <div className="cp-composer-wrap" style={{ flexShrink: 0 }}>
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            {/* 担当者からのお返事(最新の未読1件のみ。他は件数で案内)。
                スレッドの中ではなくコンポーザの上に固定する理由が2つある:
                  1. スレッドは新しい応答が来るたび末尾へ自動スクロールするため、途中に
                     差し込むと届いた直後に画面外へ流れてしまう。
                  2. msgs に入れると会話と一緒に sessionStorage へ保存され、既読化した
                     お返事がリロード後に復活する。ここは常にフックの現在値だけを映す。 */}
            {feedbackReplies.length > 0 && (
              <FeedbackReplyNotice
                reply={feedbackReplies[0]}
                extraCount={feedbackReplies.length - 1}
                onResolved={() => handleReplyResolved(feedbackReplies[0])}
                onNotResolved={() => handleReplyNotResolved(feedbackReplies[0])}
              />
            )}
            <div
              onDragEnter={handlePdfDragEnter}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={handlePdfDragLeave}
              onDrop={handlePdfDrop}
              style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 12px 12px 20px", border: canUploadBookPdf && pdfDragOver ? `2px dashed ${AGENT}` : `1px solid ${sending ? AGENT_BORDER : "var(--border)"}`, borderRadius: 16, background: canUploadBookPdf && pdfDragOver ? AGENT_SOFT : "var(--input, var(--card))" }}
            >
              {canUploadBookPdf && (
                <input
                  ref={pdfInputRef}
                  type="file"
                  accept=".pdf,.zip,application/pdf,application/zip"
                  multiple
                  style={{ display: "none" }}
                  aria-hidden="true"
                  tabIndex={-1}
                  onChange={handlePdfInputChange}
                />
              )}
              {/* textarea(1行から始まり複数行も書ける)。Enterで送信、Shift+Enterで改行。
                  IME変換中のEnterは shouldSubmitOnEnter が弾く(旧UIパネルと共通実装) */}
              <textarea
                ref={composerRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleComposerKeyDown}
                onCompositionStart={() => setIsComposing(true)}
                onCompositionEnd={() => setIsComposing(false)}
                placeholder="指示ルールを話しかけてみてください（例：保証について聞かれたら2年と答えて）"
                rows={1}
                disabled={sending}
                style={{ flex: 1, border: "none", outline: "none", background: "transparent", color: "var(--foreground)", fontSize: 16, maxHeight: 140, resize: "none", fontFamily: "inherit", lineHeight: 1.6, padding: 0, overflowY: "auto" }}
              />
              {canUploadBookPdf && (
                <button
                  onClick={() => pdfInputRef.current?.click()}
                  aria-label="PDFを添付"
                  title="PDFを添付（ここへドラッグ＆ドロップでも取り込めます）"
                  style={{ width: 40, height: 40, borderRadius: 12, border: "1px solid var(--border)", background: "transparent", color: "var(--muted-foreground)", cursor: "pointer", fontSize: 17, flexShrink: 0 }}
                >
                  📎
                </button>
              )}
              <button onClick={handleSend} disabled={sending} aria-label="送信" style={{ width: 40, height: 40, borderRadius: 12, border: "none", background: AGENT, color: "#fff", cursor: sending ? "not-allowed" : "pointer", opacity: sending ? 0.6 : 1, fontSize: 18 }}>
                {sending ? "…" : "↑"}
              </button>
            </div>
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted-foreground)", textAlign: "center" }}>
              実際の R2Cエージェントに接続されています。要ログイン。
              {canUploadBookPdf && "PDFはここへドラッグ＆ドロップできます。"}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

// ─── 部品 ────────────────────────────────────────────────────────────────────

// super_adminがプレビュー未選択で入ってきた時だけ出す、チャット開始前のテナント選択。
// 選ぶと既存の enterPreview(=クライアントビュー)に入り、以降の画面・ツールは
// client_adminと同じ挙動になる(super_admin専用の機能は一切増やさない)。
function TenantSelection({
  tenants,
  failed,
  onSelect,
}: {
  tenants: TenantOption[] | null;
  failed: boolean;
  onSelect: (t: TenantOption) => void;
}) {
  return (
    <div
      style={{
        minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
        padding: "24px 16px", background: "var(--background)", color: "var(--foreground)",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
      }}
    >
      <div style={{ width: "100%", maxWidth: 420, display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <AgentMark />
          <div>
            <h1 style={{ margin: 0, fontSize: 19, fontWeight: 800, letterSpacing: "-0.02em" }}>
              どのお客様として見ますか？
            </h1>
            <div style={{ fontSize: 13, color: "var(--muted-foreground)", marginTop: 3, lineHeight: 1.5 }}>
              テナントを選ぶとクライアントビューに入り、そのお客様と同じチャットを再現できます。
            </div>
          </div>
        </div>

        {failed ? (
          <div style={{ fontSize: 14, color: "var(--muted-foreground)", lineHeight: 1.7 }}>
            テナント一覧を取得できませんでした。ページを再読み込みしてお試しください。
          </div>
        ) : tenants === null ? (
          <div style={{ fontSize: 14, color: "var(--muted-foreground)" }}>テナント一覧を読み込んでいます…</div>
        ) : tenants.length === 0 ? (
          <div style={{ fontSize: 14, color: "var(--muted-foreground)" }}>表示できるテナントがありません。</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "60vh", overflowY: "auto" }}>
            {tenants.map((t) => (
              <button
                key={t.id}
                onClick={() => onSelect(t)}
                style={{
                  display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3,
                  width: "100%", padding: "12px 14px", borderRadius: 12,
                  border: `1px solid ${AGENT_BORDER}`, background: "var(--card)",
                  color: "var(--foreground)", cursor: "pointer", textAlign: "left", minHeight: 44,
                }}
              >
                <span style={{ fontSize: 15, fontWeight: 700 }}>{t.name}</span>
                <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{t.id}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PreviewBadge() {
  return (
    <div style={{ margin: "6px 8px 10px", fontSize: 11.5, fontWeight: 700, letterSpacing: "0.03em", color: "#b45309", background: "rgba(245,158,11,0.14)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 8, padding: "6px 10px", lineHeight: 1.45 }}>
      PROTOTYPE ・ 全ての操作が実際のR2Cエージェント(実API)に接続されています
    </div>
  );
}

// 左レールの件数バッジ。marginLeft:auto で行末に寄せ、flexShrink:0 で
// ラベルに押し潰されないようにする(狭い幅ではラベル側が折り返す)。
function RailCountBadge({ count, label }: { count: number; label: string }) {
  return (
    <span
      aria-label={`${label} ${count}件`}
      style={{
        marginLeft: "auto", flexShrink: 0, minWidth: 24, padding: "1px 7px", borderRadius: 999,
        fontSize: 13, fontWeight: 700, lineHeight: 1.5, textAlign: "center",
        color: "#b45309", background: "rgba(245,158,11,0.16)", border: "1px solid rgba(245,158,11,0.35)",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {count}
    </span>
  );
}

function AgentMark() {
  return (
    <div style={{ width: 44, height: 44, borderRadius: "50%", flexShrink: 0, position: "relative", background: `conic-gradient(from 140deg, ${AGENT}, #d99320, ${AGENT})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "absolute", inset: 3, borderRadius: "50%", background: "var(--card, var(--background))" }} />
      <span style={{ position: "relative", zIndex: 1, fontSize: 20 }}>✨</span>
    </div>
  );
}

// Phase4: チャット・ファーストを既定ランディングにするかの個人オプトイン(このブラウザのみ)。
// ONにすると次回以降 /admin, / を開いた時にこの画面が開くようになる。テナント全体・
// 他ユーザーには一切影響しない。既定はOFF(従来のダッシュボードのまま)。
function Phase4DefaultToggle() {
  const [enabled, setEnabled] = useState(() => isChatFirstDefaultEnabled());

  const toggle = () => {
    const next = !enabled;
    setChatFirstDefaultEnabled(next);
    setEnabled(next);
    // 「オプトインした人が1ヶ月後も残っているか」を測るための計測だけの副回線
    // (docs/AGENT_METRICS.md の chat_first_toggle)。トグルの実体はあくまで上の
    // localStorage 側なので、await せず失敗も握り潰す。この通信の成否がトグルの
    // 見た目・保存値・ユーザーへのエラー表示に影響してはならない。
    void authFetch(`${API_BASE}/v1/admin/agent/ui-event`, {
      method: "POST",
      body: JSON.stringify({ event: "chat_first_toggle", enabled: next }),
    }).catch(() => undefined);
  };

  return (
    <button
      onClick={toggle}
      style={{
        display: "flex", alignItems: "center", gap: 10, width: "calc(100% - 16px)", margin: "0 8px 8px",
        padding: "10px 12px", borderRadius: 10, border: "1px solid var(--border)",
        background: enabled ? AGENT_SOFT : "transparent", cursor: "pointer", textAlign: "left",
      }}
    >
      <span
        style={{
          width: 36, height: 20, borderRadius: 999, background: enabled ? AGENT : "var(--border)",
          position: "relative", flexShrink: 0, transition: "background 0.15s",
        }}
      >
        <span
          style={{
            position: "absolute", top: 3, left: enabled ? 19 : 3, width: 14, height: 14, borderRadius: "50%",
            background: "#fff", transition: "left 0.15s",
          }}
        />
      </span>
      <span style={{ fontSize: 13, color: enabled ? AGENT : "var(--muted-foreground)", lineHeight: 1.45 }}>
        これを既定の画面にする
        <br />
        <span style={{ fontSize: 11.5, opacity: 0.75 }}>このブラウザだけの設定です</span>
      </span>
    </button>
  );
}

function RealActionBadge({ count }: { count: number }) {
  return (
    <div aria-label={`実際の操作 ${count}件`} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: count > 0 ? "#16a34a" : "var(--muted-foreground)" }}>
      <span style={{ fontSize: 13 }}>{count > 0 ? "✅" : "◦"}</span>
      実際の操作 <strong style={{ fontVariantNumeric: "tabular-nums" }}>{count}</strong>件
    </div>
  );
}

function MessageRow({
  m,
  onChip,
  onGenerateAvatarCandidates,
  onGeneratePremiumAvatarCandidate,
  onAdoptAvatarCandidate,
  onUploadAvatarPhoto,
  onCloneAvatarVoice,
  onMatchAvatarVoice,
  onAdoptAvatarVoice,
  onDesignAvatarVoice,
  onAdoptDesignedVoice,
}: {
  m: Msg;
  onChip: (a: string, id: number) => void;
  onGenerateAvatarCandidates: (configId: string, name: string, promptInput: AvatarPromptInput) => void | Promise<void>;
  onGeneratePremiumAvatarCandidate: (configId: string, name: string, promptInput: AvatarPromptInput) => void | Promise<void>;
  onAdoptAvatarCandidate: (cardMsgId: number, configId: string, imageUrl: string) => void | Promise<void>;
  onUploadAvatarPhoto: (configId: string, file: File) => void | Promise<void>;
  onCloneAvatarVoice: (configId: string, avatarName: string, file: File) => void | Promise<void>;
  onMatchAvatarVoice: (configId: string, description: string) => void | Promise<void>;
  onAdoptAvatarVoice: (cardMsgId: number, configId: string, voiceId: string) => void | Promise<void>;
  onDesignAvatarVoice: (configId: string, instruction: string) => void | Promise<void>;
  onAdoptDesignedVoice: (cardMsgId: number, configId: string, candidateId: string) => void | Promise<void>;
}) {
  const isMe = m.role === "me";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: isMe ? "flex-end" : "flex-start", gap: 10 }}>
      {m.text && (
        <div style={{ maxWidth: "90%", padding: "14px 18px", borderRadius: isMe ? "18px 18px 6px 18px" : "18px 18px 18px 6px", background: isMe ? AGENT : "var(--muted, rgba(120,120,140,0.12))", color: isMe ? "#fff" : "var(--foreground)", fontSize: 16, lineHeight: 1.7, wordBreak: "break-word", ...(isMe || m.revealing ? { whiteSpace: "pre-wrap" } : {}) }}>
          {/* 自分自身の発話はMarkdown解釈させない(意図しない**強調**表示等を避ける)。
              タイプライター演出で流し込み中(m.revealing)は閉じていない**等の
              不完全なMarkdown断片を含みうるため、完了するまでは素のテキストで
              表示する(生の記法がチラついて見えるのを防ぐ)。 */}
          {isMe || m.revealing ? m.text : <AgentMarkdown content={m.text} />}
        </div>
      )}
      {/* 回答の出どころ。テキストが流し込まれるまでは出さない(空バブルの下に
          ラベルだけが浮くのを避ける) */}
      {m.text && m.answeredFrom && (
        <div style={{ fontSize: 12.5, color: "var(--muted-foreground)", padding: "0 4px" }}>
          {ANSWERED_FROM_LABEL[m.answeredFrom]}
        </div>
      )}
      {m.card && (
        <CardView
          card={m.card}
          msgId={m.id}
          onGenerateAvatarCandidates={onGenerateAvatarCandidates}
          onGeneratePremiumAvatarCandidate={onGeneratePremiumAvatarCandidate}
          onAdoptAvatarCandidate={onAdoptAvatarCandidate}
          onUploadAvatarPhoto={onUploadAvatarPhoto}
          onCloneAvatarVoice={onCloneAvatarVoice}
          onMatchAvatarVoice={onMatchAvatarVoice}
          onAdoptAvatarVoice={onAdoptAvatarVoice}
          onDesignAvatarVoice={onDesignAvatarVoice}
          onAdoptDesignedVoice={onAdoptDesignedVoice}
          onSendReal={(action) => onChip(action, m.id)}
        />
      )}
      {m.chips && !m.chipsUsed && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {m.chips.map((c, i) => (
            <button
              key={i}
              onClick={() => onChip(c.action, m.id)}
              style={{
                fontSize: 14.5, fontWeight: 700, padding: "10px 18px", borderRadius: 12, cursor: "pointer",
                border: c.tone === "primary" ? "none" : "1px solid var(--border)",
                background: c.tone === "primary" ? AGENT : "transparent",
                color: c.tone === "primary" ? "#fff" : "var(--muted-foreground)",
                minHeight: 44,
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 相談窓口(担当者への相談 → 返信 → 解決確認) ──────────────────────────────
// ロジック(ポーリング・既読化・相談投稿)は lib/feedbackReplies.ts でパネルと共有し、
// ここは見せ方だけを持つ。パネル側の ReplyCard/FeedbackPrompt をそのまま使わないのは、
// あれがダークのパネル前提の固定色(#86efac 等)で書かれており、light/dark 両対応の
// この画面ではコントラストが破綻するため(文言と操作は同一に保っている)。

function FeedbackReplyNotice({
  reply,
  extraCount,
  onResolved,
  onNotResolved,
}: {
  reply: FeedbackReply;
  extraCount: number;
  onResolved: () => Promise<void>;
  onNotResolved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const run = (action: () => Promise<void>) => {
    setBusy(true);
    void action();
  };

  return (
    <div style={{ marginBottom: 12 }}>
      <CardShell
        tone="brand"
        hd={
          <>
            <span>💬</span>担当者からお返事が届きました
            {extraCount > 0 && (
              <span style={{ fontWeight: 500, fontSize: 12.5, opacity: 0.8 }}>{`＋あと${extraCount}件`}</span>
            )}
          </>
        }
      >
        {/* コンポーザの上に固定するため、縦幅は詰める(狭い画面ではスレッドが潰れる)。
            どの相談への返事かは1行で足りるので、ラベル付きの Field にはしない。 */}
        <div style={{ fontSize: 13, color: "var(--muted-foreground)", lineHeight: 1.5, wordBreak: "break-word" }}>
          ご相談: {reply.message}
          {reply.replied_at && (
            <>
              {" ・ "}
              {new Date(reply.replied_at).toLocaleString("ja-JP", {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </>
          )}
        </div>
        {/* 長いお返事でコンポーザが画面外に押し出されないよう、高さを制限して中でスクロールさせる
            (上限値は狭い画面でさらに小さくする。index.css の .cp-consult-reply) */}
        <div
          className="cp-consult-reply"
          style={{
            fontSize: 15, color: "var(--foreground)", background: "var(--muted, rgba(120,120,140,0.1))",
            borderRadius: 10, padding: "10px 14px", borderLeft: "3px solid #d99320",
            lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word", overflowY: "auto",
          }}
        >
          {reply.reply_body}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            onClick={() => run(onResolved)}
            disabled={busy}
            style={{
              fontSize: 14.5, fontWeight: 700, padding: "10px 18px", borderRadius: 12, minHeight: 44,
              border: "none", background: AGENT, color: "#fff",
              cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1,
            }}
          >
            解決しました
          </button>
          <button
            onClick={() => run(onNotResolved)}
            disabled={busy}
            style={{
              fontSize: 14.5, fontWeight: 700, padding: "10px 18px", borderRadius: 12, minHeight: 44,
              border: "1px solid var(--border)", background: "transparent", color: "var(--muted-foreground)",
              cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1,
            }}
          >
            まだ解決しません
          </button>
        </div>
      </CardShell>
    </div>
  );
}

// 直近のAI回答の下に出す「解決しましたか？」。「うまく解決しなかった」を押すと、その
// 質問がそのまま担当者への相談として投稿される(= 相談窓口ループの入口)。
function ResolutionPrompt({ question }: { question: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "dismissed">("idle");

  if (state === "dismissed") return null;

  if (state === "sent") {
    return (
      <div style={{ fontSize: 13.5, color: "#16a34a", padding: "0 4px" }}>
        {"✅ 担当者に伝えました。お返事はこの画面に届きます。"}
      </div>
    );
  }

  const handleNotResolved = async () => {
    setState("sending");
    const ok = await submitConsultation({ message: question });
    setState(ok ? "sent" : "idle");
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "0 4px" }}>
      <span style={{ fontSize: 13.5, color: "var(--muted-foreground)" }}>このお返事で解決しましたか？</span>
      <button
        onClick={() => setState("dismissed")}
        style={{
          fontSize: 13.5, fontWeight: 700, padding: "7px 16px", borderRadius: 999, minHeight: 36,
          border: `1px solid ${AGENT_BORDER}`, background: AGENT_SOFT, color: AGENT, cursor: "pointer",
        }}
      >
        はい
      </button>
      <button
        onClick={() => void handleNotResolved()}
        disabled={state === "sending"}
        style={{
          fontSize: 13.5, fontWeight: 700, padding: "7px 16px", borderRadius: 999, minHeight: 36,
          border: "1px solid var(--border)", background: "transparent", color: "var(--muted-foreground)",
          cursor: state === "sending" ? "not-allowed" : "pointer",
        }}
      >
        {state === "sending" ? "送信中..." : "うまく解決しなかった"}
      </button>
    </div>
  );
}

function CardShell({ hd, tone = "agent", children, foot }: { hd: React.ReactNode; tone?: "agent" | "brand" | "good" | "bad"; children: React.ReactNode; foot?: React.ReactNode }) {
  const border = tone === "bad" ? "rgba(239,68,68,0.4)" : tone === "good" ? "rgba(34,197,94,0.4)" : tone === "brand" ? "rgba(217,147,32,0.4)" : AGENT_BORDER;
  const hdBg = tone === "bad" ? "rgba(239,68,68,0.12)" : tone === "good" ? "rgba(34,197,94,0.12)" : tone === "brand" ? "rgba(217,147,32,0.12)" : AGENT_SOFT;
  const hdColor = tone === "bad" ? "#dc2626" : tone === "good" ? "#16a34a" : tone === "brand" ? "#b45309" : AGENT;
  return (
    <div style={{ width: "100%", maxWidth: "100%", border: `1px solid ${border}`, borderRadius: 16, overflow: "hidden", background: "var(--card)", boxShadow: "0 2px 4px rgba(0,0,0,0.05), 0 10px 28px rgba(0,0,0,0.07)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 18px", background: hdBg, borderBottom: `1px solid ${border}`, fontWeight: 700, fontSize: 15, color: hdColor }}>{hd}</div>
      <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>
      {foot}
    </div>
  );
}

function Field({ k, v, quote, hi, pre }: { k: string; v: string; quote?: boolean; hi?: boolean; pre?: boolean }) {
  return (
    <div style={{ fontSize: 15 }}>
      <div style={{ fontSize: 12.5, color: "var(--muted-foreground)", fontWeight: 600, marginBottom: 4 }}>{k}</div>
      <div style={{ color: "var(--foreground)", ...(pre ? { whiteSpace: "pre-wrap" } : {}), ...(quote ? { background: "var(--muted, rgba(120,120,140,0.1))", borderRadius: 10, padding: "10px 14px", borderLeft: `3px solid ${hi ? "#d99320" : AGENT}`, lineHeight: 1.7 } : {}) }}>{v}</div>
    </div>
  );
}

function CardView({
  card,
  msgId,
  onGenerateAvatarCandidates,
  onGeneratePremiumAvatarCandidate,
  onAdoptAvatarCandidate,
  onUploadAvatarPhoto,
  onCloneAvatarVoice,
  onMatchAvatarVoice,
  onAdoptAvatarVoice,
  onDesignAvatarVoice,
  onAdoptDesignedVoice,
  onSendReal,
}: {
  card: Card;
  msgId: number;
  onGenerateAvatarCandidates: (configId: string, name: string, promptInput: AvatarPromptInput) => void | Promise<void>;
  onGeneratePremiumAvatarCandidate: (configId: string, name: string, promptInput: AvatarPromptInput) => void | Promise<void>;
  onAdoptAvatarCandidate: (cardMsgId: number, configId: string, imageUrl: string) => void | Promise<void>;
  onUploadAvatarPhoto: (configId: string, file: File) => void | Promise<void>;
  onCloneAvatarVoice: (configId: string, avatarName: string, file: File) => void | Promise<void>;
  onMatchAvatarVoice: (configId: string, description: string) => void | Promise<void>;
  onAdoptAvatarVoice: (cardMsgId: number, configId: string, voiceId: string) => void | Promise<void>;
  onDesignAvatarVoice: (configId: string, instruction: string) => void | Promise<void>;
  onAdoptDesignedVoice: (cardMsgId: number, configId: string, candidateId: string) => void | Promise<void>;
  onSendReal?: (action: string) => void;
}) {
  switch (card.kind) {
    case "agentAction":
      return (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 9, padding: "10px 14px", borderRadius: 12, background: "rgba(34,197,94,0.10)", border: "1px solid rgba(34,197,94,0.28)", fontSize: 14.5, lineHeight: 1.7, maxWidth: "90%" }}>
          <span style={{ fontSize: 12.5, flexShrink: 0 }}>✅</span>
          <span>
            <strong style={{ color: "var(--foreground)" }}>{REAL_TOOL_LABEL[card.tool] ?? card.tool}</strong>
            <span style={{ color: "var(--muted-foreground)" }}>：{card.result}</span>
          </span>
        </div>
      );
    case "faq":
      return (
        <CardShell hd={<><span>📚</span>新しい知識を登録します</>}
          foot={<CardActionsNote note="登録するまで反映されません。内容はいつでも直せます。" />}>
          <Field k="お客様の質問" v={card.question} />
          <Field k="AIが答える内容" v={card.answer} quote />
          <Field k="分類" v={card.category + "（AIが自動で判定）"} />
        </CardShell>
      );
    case "rule":
      return (
        <CardShell hd={<><span>🎛️</span>AIへの指示ルールを追加します</>}
          foot={<CardActionsNote note="「いつ・どう振る舞うか」を1つの指示にまとめました。" />}>
          <Field k="どんな時に" v={card.trigger} />
          <Field k="こう振る舞う" v={card.behavior} quote pre />
          {card.priority !== undefined && (
            <Field k="優先度" v={TIER_LABEL[priorityToTier(card.priority)]} />
          )}
        </CardShell>
      );
    case "rulesList":
      // P6-1: 新規テナントが最初にこのカードを開いた時、0件をそのまま出すと
      // 「技術的な空表示」になり何をすればいいか分からない。何ができるか(具体例)と
      // 最初の一手(チップ)を添える。
      if (card.totalCount === 0) {
        return (
          <CardShell hd={<><span>🎛️</span>指示ルールはまだありません</>}>
            <div style={{ fontSize: 14.5, color: "var(--foreground)" }}>
              指示ルールを使うと、「保証について聞かれたら2年とお伝えする」のように、AIチャットボットの受け答えを1つずつ細かく調整できます。
            </div>
            {onSendReal && (
              <button
                onClick={() => onSendReal("__real:指示ルールを初めて作ります。何をどう伝えればいいか教えてください")}
                style={{ alignSelf: "flex-start", fontSize: 13.5, fontWeight: 700, padding: "9px 16px", borderRadius: 10, cursor: "pointer", border: "none", background: AGENT, color: "#fff", minHeight: 44 }}
              >
                🎛️ 最初のルールを作ってみる
              </button>
            )}
          </CardShell>
        );
      }
      return (
        <CardShell hd={<><span>🎛️</span>指示ルール一覧（{card.totalCount}件）</>}>
          {card.rules.map((r) => {
            // P4-1: AI(judge/hermes)が提案したルールは、店主が作ったものと同じ見た目で
            // 並べない(出所が分からないと承認判断ができない)。is_activeだけでは
            // 未承認(pending)と却下済み(rejected)を区別できないためstatusも見る。
            // R6: Hermes提案もJudge提案と同じ棚(tuning_rules)に着地するため、
            // 同一の一覧・同一の承認操作の対象にしつつ、出所ラベルだけ分ける。
            const isJudgeProposal = r.source === "judge";
            const isHermesProposal = r.source === "hermes";
            const isAiProposal = isJudgeProposal || isHermesProposal;
            const isPendingApproval = isAiProposal && !r.isActive && r.status !== "rejected";
            const isRejected = isAiProposal && r.status === "rejected";
            return (
              <div
                key={r.id}
                style={{ display: "flex", flexDirection: "column", gap: 6, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: "var(--muted-foreground)", flexWrap: "wrap" }}>
                  <span>{r.isActive ? "✅ 有効" : "⏸️ 無効"}</span>
                  <span>優先度: {TIER_LABEL[priorityToTier(r.priority)]}</span>
                  {isAiProposal && (
                    <span style={{ fontWeight: 700, color: "#b45309", background: "rgba(245,158,11,0.14)", borderRadius: 6, padding: "2px 8px" }}>
                      {isHermesProposal ? "🌐 Hermesの提案" : "🤖 AIの提案"}
                      {isPendingApproval ? "（未承認）" : isRejected ? "（却下済み）" : ""}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 14.5, color: "var(--foreground)" }}>
                  <strong>{r.triggerPattern}</strong> → {r.expectedBehavior}
                </div>
                {/* 根拠は評価IDなどの内部識別子をそのまま出さず、店主の言葉に言い換える */}
                {r.evidence && (
                  <div style={{ fontSize: 12.5, color: "var(--muted-foreground)", display: "flex", flexDirection: "column", gap: 2 }}>
                    {r.evidence.avgScore !== undefined && (
                      <div>もとになった会話の対応の質: 目安{r.evidence.avgScore}点</div>
                    )}
                    {r.evidence.effectivePrinciples && r.evidence.effectivePrinciples.length > 0 && (
                      <div>効果があった対応: {r.evidence.effectivePrinciples.join("、")}</div>
                    )}
                    {r.evidence.failedPrinciples && r.evidence.failedPrinciples.length > 0 && (
                      <div>うまくいかなかった対応: {r.evidence.failedPrinciples.join("、")}</div>
                    )}
                  </div>
                )}
                {/* D5: 旧UIの3段階(低/普通/高)と同じ語彙でチャットからも優先度を変えられるようにする。
                    却下済みのAI提案は編集の意味が無いため出さない。 */}
                {onSendReal && !isRejected && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {(["low", "normal", "high"] as const)
                      .filter((t) => t !== priorityToTier(r.priority))
                      .map((t) => (
                        <button
                          key={t}
                          onClick={() =>
                            onSendReal(
                              `__real:指示ルール（ID: ${r.id}、「${r.triggerPattern}」）の優先度を「${TIER_LABEL[t]}」にしてください`,
                            )
                          }
                          style={{ fontSize: 12.5, fontWeight: 600, padding: "6px 12px", borderRadius: 8, cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: "var(--muted-foreground)", minHeight: 44 }}
                        >
                          優先度を{TIER_LABEL[t]}にする
                        </button>
                      ))}
                  </div>
                )}
                {isPendingApproval && onSendReal && (
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() =>
                        onSendReal(
                          `__real:AIが提案したルール（ID: ${r.id}、「${r.triggerPattern}」→「${r.expectedBehavior}」）を承認して有効にしてください`,
                        )
                      }
                      style={{ fontSize: 13.5, fontWeight: 700, padding: "8px 14px", borderRadius: 10, cursor: "pointer", border: "none", background: AGENT, color: "#fff", minHeight: 44 }}
                    >
                      有効にする
                    </button>
                    <button
                      onClick={() =>
                        onSendReal(
                          `__real:AIが提案したルール（ID: ${r.id}、「${r.triggerPattern}」→「${r.expectedBehavior}」）を却下してください`,
                        )
                      }
                      style={{ fontSize: 13.5, fontWeight: 700, padding: "8px 14px", borderRadius: 10, cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: "var(--muted-foreground)", minHeight: 44 }}
                    >
                      却下する
                    </button>
                  </div>
                )}
                {/* GID 1217752900578379 (R4): status==='active' のときのみ approved_at が
                    記録されている(T1で確認済みの唯一の書き込み経路)。未承認の行に出すと
                    効果を聞いても「まだ承認されていません」が返るだけで、押しても無意味になる。 */}
                {r.status === "active" && onSendReal && (
                  <button
                    onClick={() => onSendReal(`__real:指示ルール（ID: ${r.id}）の効果を教えて`)}
                    style={{ alignSelf: "flex-start", fontSize: 13.5, fontWeight: 700, padding: "8px 14px", borderRadius: 10, cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: "var(--muted-foreground)", minHeight: 44 }}
                  >
                    📊 効果を見る
                  </button>
                )}
              </div>
            );
          })}
        </CardShell>
      );
    case "engagement":
      return (
        <CardShell hd={<><span>⚡</span>お客様への声がけを設定します</>}
          foot={<CardActionsNote note="離脱しそうなタイミングを検知して自動で表示します。" />}>
          <Field k="いつ出すか" v={card.when} />
          <Field k="表示する言葉" v={card.message} quote hi />
        </CardShell>
      );
    case "success":
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderRadius: 12, background: "rgba(34,197,94,0.10)", border: "1px solid rgba(34,197,94,0.28)", color: "var(--foreground)", fontSize: 15 }}>
          <span style={{ fontSize: 17 }}>✅</span>{card.text}
        </div>
      );
    case "pdfUpload":
      return <PdfUploadCard card={card} />;
    case "avatarPreset":
      return (
        <CardShell hd={<><span>🎭</span>アバターの見本を提案します</>}
          foot={<CardActionsNote note="採用しても公開はされません。声や話し方はあとから自由に変更できます。" />}>
          {card.imageUrl && (
            <img
              src={card.imageUrl}
              alt={card.name}
              style={{ width: 96, height: 96, borderRadius: 12, objectFit: "cover", alignSelf: "flex-start" }}
            />
          )}
          <Field k="名前" v={card.name} />
          <Field k="性格・話し方" v={card.description} quote />
        </CardShell>
      );
    case "avatarAdopted":
      return <AvatarAdoptedCard card={card} onGenerate={onGenerateAvatarCandidates} onGeneratePremium={onGeneratePremiumAvatarCandidate} onUploadPhoto={onUploadAvatarPhoto} onCloneVoice={onCloneAvatarVoice} onMatchVoice={onMatchAvatarVoice} onDesignVoice={onDesignAvatarVoice} />;
    case "avatarCandidates":
      return <AvatarCandidatesCard card={card} msgId={msgId} onGenerate={onGenerateAvatarCandidates} onGeneratePremium={onGeneratePremiumAvatarCandidate} onAdopt={onAdoptAvatarCandidate} />;
    case "avatarPhotoUpload":
      return <AvatarPhotoUploadCard card={card} />;
    case "avatarVoiceCandidates":
      return (
        <AvatarVoiceCard
          card={card}
          msgId={msgId}
          onMatch={onMatchAvatarVoice}
          onAdopt={onAdoptAvatarVoice}
          onDesign={onDesignAvatarVoice}
          onAdoptDesigned={onAdoptDesignedVoice}
        />
      );
    case "link": {
      // 同一オリジンの内部パスだけ rel="opener" を付けて opener を明示的に維持する。主要
      // ブラウザは target="_blank" を rel 省略時も暗黙に noopener 扱いする(2021年前後の
      // ブラウザ既定変更)ため、rel を外すだけでは window.opener が渡らない。opener を維持
      // することで、旧UI側の戻りリンク(AppSidebar)が window.close()で元のタブへ戻せる
      // (=会話が復元できる)。外部URL(他オリジン)は一般のリンクなので、従来どおり
      // rel="noopener noreferrer" を維持しopenerを渡さない。
      // 判定は文字列の前方一致(例: startsWith("/"))ではなくURLパースでオリジンを比較する
      // ("/\\evil.com" のようなバックスラッシュはWHATWG URLパーサでスラッシュに正規化され
      // 別オリジンへの絶対URLになるため、前方一致だと内部パス扱いしてしまう=reverse
      // tabnabbingの経路になる)。
      const isInternalLink = (() => {
        try {
          return new URL(card.url, window.location.origin).origin === window.location.origin;
        } catch {
          return false;
        }
      })();
      return (
        <CardShell hd={<><span>🔗</span>{card.label}へご案内します</>}>
          <Field k="この操作について" v={card.description} />
          {/* 同一SPA内のパスなので、target無しだとこのページごとアンマウントされ会話履歴(msgs/sessionId)が消える */}
          <a
            href={card.url}
            target="_blank"
            rel={isInternalLink ? "opener" : "noopener noreferrer"}
            style={{ display: "inline-flex", alignSelf: "flex-start", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 10, background: AGENT, color: "#fff", fontSize: 14, fontWeight: 700, textDecoration: "none" }}
          >
            {card.label}を開く ↗
          </a>
          <div style={{ fontSize: 12.5, color: "var(--muted-foreground)" }}>
            別タブで開きます。終わったらこのタブを閉じると、さきほどの会話に戻れます。
          </div>
          {onSendReal && (
            <button
              onClick={() => onSendReal("__real:旧画面での作業が終わりました。反映を確認してください")}
              style={{ alignSelf: "flex-start", fontSize: 14.5, fontWeight: 700, padding: "10px 18px", borderRadius: 12, cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: "var(--muted-foreground)", minHeight: 44 }}
            >
              終わったら教えて
            </button>
          )}
        </CardShell>
      );
    }
    case "chatSessionList":
      return (
        <CardShell hd={<><span>💬</span>会話セッション一覧（全{card.total}件中{card.sessions.length}件）</>}>
          {card.sessions.map((s) => (
            <div key={s.shortId} style={{ display: "flex", flexDirection: "column", gap: 3, paddingBottom: 10, borderBottom: "1px solid var(--border)" }}>
              <div style={{ fontSize: 12.5, color: "var(--muted-foreground)" }}>
                {s.startedAt.slice(0, 10)} ・ {s.messageCount}件
                {s.outcome && (
                  <span style={{ marginLeft: 8, padding: "1px 8px", borderRadius: 999, fontSize: 12.5, fontWeight: 600, background: "rgba(34,197,94,0.15)", border: "1px solid rgba(34,197,94,0.3)", color: "#16a34a" }}>
                    {s.outcome}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 15, color: "var(--foreground)" }}>{s.preview}</div>
            </div>
          ))}
          <div style={{ fontSize: 12.5, color: "var(--muted-foreground)" }}>
            下のボタンから会話を選ぶと、内容を表示します。
          </div>
        </CardShell>
      );
    case "chatSessionMessages":
      return (
        <CardShell hd={<><span>📜</span>会話[{card.shortId}]（全{card.totalMessages}件中{card.messages.length}件）</>}>
          {card.messages.map((m, i) => {
            // P5-1: AI応答の直後にのみ「この会話からルールを作る」を出す。
            // 直前が必ずしもお客様発言とは限らない(担当者返信を挟む等)ため、
            // 遡って直近のuser発言を探す。見つからなければチップを出さない。
            const prevUser =
              m.role === "assistant"
                ? card.messages.slice(0, i).reverse().find((p) => p.role === "user")
                : undefined;
            return (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <Field k={m.roleLabel} v={m.content} quote />
                {prevUser && onSendReal && (
                  <button
                    onClick={() =>
                      onSendReal(
                        `__real:この会話(お客様:「${prevUser.content.slice(0, 300)}」→AI:「${m.content.slice(0, 300)}」)から指示ルールを提案してください`,
                      )
                    }
                    style={{ alignSelf: "flex-start", fontSize: 12.5, fontWeight: 700, padding: "8px 14px", borderRadius: 8, cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: "var(--muted-foreground)", minHeight: 44 }}
                  >
                    🎛️ この会話からルールを作る
                  </button>
                )}
                {/* 要件 F1: 誤答に気づいた場所から直せるようにする(CLAUDE.md 禁止45)。
                    「知識かルールか」は店主に選ばせず suggest_answer_correction が判定する。 */}
                {prevUser && onSendReal && (
                  <button
                    onClick={() =>
                      onSendReal(
                        `__real:この回答(お客様:「${prevUser.content.slice(0, 300)}」→AI:「${m.content.slice(0, 300)}」)は間違っています。どこが違うか伝えるので、直し方を判定してください`,
                      )
                    }
                    style={{ alignSelf: "flex-start", fontSize: 12.5, fontWeight: 700, padding: "8px 14px", borderRadius: 8, cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: "var(--muted-foreground)", minHeight: 44 }}
                  >
                    ✏️ この回答を直す
                  </button>
                )}
              </div>
            );
          })}
        </CardShell>
      );
    case "evaluation": {
      // 閾値(80以上=良好/60以上=許容/未満=要改善)は旧UI(JudgeEvaluationSection.tsx)と同一。
      // 同じ会話が面によって違う評価に見えてはならない。
      const tone = card.overallScore >= 80 ? "good" : card.overallScore >= 60 ? "brand" : "bad";
      return (
        <CardShell hd={<><span>🤖</span>対応品質評価（総合{card.overallScore}点）</>} tone={tone}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {card.axes.map((a) => {
              const color =
                a.score == null ? "var(--muted-foreground)" : a.score >= 80 ? "#4ade80" : a.score >= 60 ? "#fbbf24" : "#f87171";
              return (
                <span
                  key={a.label}
                  style={{ padding: "3px 10px", borderRadius: 999, fontSize: 12.5, fontWeight: 600, background: "rgba(120,120,140,0.12)", border: "1px solid var(--border)", color }}
                >
                  {a.label}: {a.score ?? "未測定"}
                </span>
              );
            })}
          </div>
          {card.notes && <Field k="所見" v={card.notes} quote />}
        </CardShell>
      );
    }
    case "weeklySummary":
      return <WeeklySummaryCard card={card} />;
    case "ruleEffect":
      return <RuleEffectCard card={card} onSendReal={onSendReal} />;
    case "analyticsTrend":
      return <AnalyticsTrendCard card={card} onSendReal={onSendReal} />;
    case "abTestResults":
      return <AbTestResultsCard card={card} onSendReal={onSendReal} />;
    case "knowledgeAttribution":
      return <KnowledgeAttributionCard card={card} />;
    case "billingSummary":
      return <BillingSummaryCard card={card} />;
    case "planChanged":
      return <PlanChangedCard card={card} />;
    case "knowledgeGapsList":
      return (
        <CardShell hd={<><span>📚</span>知識ギャップ一覧（{card.totalCount}件）</>}>
          {card.gaps.map((g) => (
            <div key={g.id} style={{ display: "flex", flexDirection: "column", gap: 6, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}>
              <div style={{ fontSize: 14.5, color: "var(--foreground)" }}>{g.userQuestion}</div>
              <div style={{ fontSize: 12.5, color: "var(--muted-foreground)" }}>{g.ragHitCount}件ヒット</div>
              {onSendReal && (
                <button
                  onClick={() =>
                    onSendReal(
                      `__real:知識ギャップ（ID: ${g.id}、質問:「${g.userQuestion}」）から指示ルールを提案してください`,
                    )
                  }
                  style={{ alignSelf: "flex-start", fontSize: 13.5, fontWeight: 700, padding: "8px 14px", borderRadius: 10, cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: "var(--muted-foreground)", minHeight: 44 }}
                >
                  🎛️ このギャップからルールを作る
                </button>
              )}
            </div>
          ))}
        </CardShell>
      );
    // H-5: suggest_faq_import_from_text/urls のFAQ案一覧。件数は「全total件中faqs.length件」
    // で20件上限の切り詰めを黙って隠さない(chatSessionListと同じ作法)。登録/取り消しの
    // 実行導線はカード内ボタンではなく、メッセージのchips(登録して/やめておく)側に持たせる
    // (sessionListCard・weeklySummary等の他カードと同じく、実行はチップ、カードは提示に徹する)。
    case "faqImportPreview":
      return (
        <CardShell hd={<><span>📥</span>FAQ取り込み候補（全{card.total}件中{card.faqs.length}件）</>}>
          {card.faqs.map((f, i) => (
            <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4, paddingBottom: 10, borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 16, fontWeight: 600, color: "var(--foreground)" }}>{f.question}</span>
                {f.duplicate && (
                  <span style={{ padding: "1px 8px", borderRadius: 999, fontSize: 12.5, fontWeight: 600, background: "rgba(251,191,36,0.15)", border: "1px solid rgba(251,191,36,0.3)", color: "#b45309", flexShrink: 0 }}>
                    重複の可能性
                  </span>
                )}
              </div>
              <div style={{ fontSize: 15, color: "var(--muted-foreground)" }}>{f.answer}</div>
              {f.sourceUrl && (
                <div style={{ fontSize: 12.5, color: "var(--muted-foreground)", wordBreak: "break-all" }}>取得元: {f.sourceUrl}</div>
              )}
            </div>
          ))}
          {card.errorUrls.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "#dc2626" }}>取得できなかったURL（{card.errorUrls.length}件）</div>
              {card.errorUrls.map((e) => (
                <div key={e.url} style={{ fontSize: 12.5, color: "var(--muted-foreground)", wordBreak: "break-all" }}>
                  {e.url}（{e.error}）
                </div>
              ))}
            </div>
          )}
          {card.truncated && (
            <div style={{ fontSize: 12.5, color: "var(--muted-foreground)" }}>
              ※ 生成数が上限を超えたため、先頭{card.faqs.length}件のみを対象にしています。
            </div>
          )}
          <div style={{ fontSize: 12.5, color: "var(--muted-foreground)" }}>
            下のボタンから登録するか決められます。
          </div>
        </CardShell>
      );
    default:
      return null;
  }
}

// 週次まとめ。数値はすべてサーバ集計値(card)をそのまま描画し、LLMの生成文を経由しない
// (権威の分離: 数値=サーバ、解釈と「次にやるべきこと」=LLMの文)。各グループが null なのは
// 取得できなかった場合で、0とは区別して表示自体を省く。
function WeeklySummaryCard({ card }: { card: Extract<Card, { kind: "weeklySummary" }> }) {
  const { sessions, avgScore, conversions, faq, pendingTuningRules, gaps, learned } = card;
  const stats: Array<{ label: string; value: string; sub?: string }> = [];

  if (sessions) {
    stats.push({
      label: "会話数",
      value: `${sessions.total}件`,
      sub:
        sessions.changePct !== null
          ? `先週同時点比 ${sessions.changePct >= 0 ? "+" : ""}${sessions.changePct}%（${sessions.prevTotal}件）`
          : undefined,
    });
  }
  if (avgScore !== null) stats.push({ label: "応答品質スコア", value: `${avgScore}/100` });
  if (conversions) {
    stats.push({ label: "成約", value: `${conversions.count}件・¥${conversions.total.toLocaleString("ja-JP")}` });
  }
  if (faq) {
    stats.push({
      label: "FAQ",
      value: `${faq.total}件（公開${faq.published}件）`,
      sub: faq.lastUpdated
        ? `最終更新 ${new Date(faq.lastUpdated).toLocaleDateString("ja-JP", { month: "short", day: "numeric" })}`
        : undefined,
    });
  }
  if (pendingTuningRules !== null) stats.push({ label: "承認待ちの指示ルール", value: `${pendingTuningRules}件` });
  if (gaps) stats.push({ label: "AIが答えられなかった質問", value: `${gaps.total}件（未対応の累計）` });
  if (learned) {
    const total = learned.faqAdded + learned.memorized;
    stats.push({
      label: "AIが新しく覚えたこと",
      value: total === 0 ? "なし" : `${total}件`,
      sub: total === 0 ? undefined : `追加したFAQ ${learned.faqAdded}件・会話から自動 ${learned.memorized}件`,
    });
  }

  // 会話復元(sessionStorage)で古いまとめがそのまま画面に残るケースがあるため、
  // 集計時点(asOf)を常に表示する。取得日時をJSTの暦日で比較し、今日でなければ
  // 「別の日に取得した内容」だと分かるようにする(取得直後かどうかは問わない — 復元も
  // 再取得も同じ card 構造なので、この表示ロジック1本だけで両方をカバーできる)。
  //
  // asOf は改ざん/破損したsessionStorageから復元される可能性がある(手動編集・古い
  // スキーマのデータ等)。toISOString() は Invalid Date で例外を投げるため、ここで
  // throw するとカード1枚のためにスレッド全体の描画が落ちる。素通しせず必ず検証する。
  const asOfDate = new Date(card.asOf);
  const asOfValid = !Number.isNaN(asOfDate.getTime());
  const jstDayKey = (d: Date) => new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const isStale = !asOfValid || jstDayKey(asOfDate) !== jstDayKey(new Date());
  const asOfLabel = asOfValid
    ? asOfDate.toLocaleString("ja-JP", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "不明";

  return (
    <CardShell
      hd={<><span>📊</span>今週(月曜起点)のまとめ</>}
      foot={
        <div
          style={{
            padding: "10px 18px",
            borderTop: "1px solid var(--border)",
            background: "var(--muted, rgba(120,120,140,0.06))",
            fontSize: 12.5,
            color: isStale ? "#b45309" : "var(--muted-foreground)",
          }}
        >
          集計時点: {asOfLabel}
          {isStale && "（別の日に取得した内容です。最新の状況は左の「今週のまとめ」をもう一度お試しください）"}
        </div>
      }
    >
      {stats.length === 0 && (
        // 全指標が取得できなかった場合。空のカードを出すと「壊れている」のか
        // 「動きが無かった」のか区別できないため、必ず文で伝える。
        <div style={{ fontSize: 14, color: "var(--muted-foreground)", lineHeight: 1.8 }}>
          今週は動きがありませんでした。
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {stats.map((s) => (
          <div
            key={s.label}
            style={{
              flex: "1 1 140px",
              minWidth: 120,
              background: "var(--muted, rgba(120,120,140,0.08))",
              borderRadius: 10,
              padding: "10px 12px",
            }}
          >
            <div style={{ fontSize: 12, color: "var(--muted-foreground)", fontWeight: 600, marginBottom: 4 }}>
              {s.label}
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--foreground)" }}>{s.value}</div>
            {s.sub && <div style={{ fontSize: 11.5, color: "var(--muted-foreground)", marginTop: 2 }}>{s.sub}</div>}
          </div>
        ))}
      </div>
      {gaps && gaps.top.length > 0 && (
        <div>
          <div style={{ fontSize: 12.5, color: "var(--muted-foreground)", fontWeight: 600, marginBottom: 6 }}>
            答えられなかった質問（上位）
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {gaps.top.map((g) => (
              <div
                key={g.id}
                style={{
                  fontSize: 14,
                  color: "var(--foreground)",
                  background: "var(--muted, rgba(120,120,140,0.08))",
                  borderRadius: 8,
                  padding: "8px 12px",
                }}
              >
                「{g.question}」
              </div>
            ))}
          </div>
        </div>
      )}
    </CardShell>
  );
}

// ルール効果(get_tuning_rule_effect)。数値はすべてサーバ集計値(card)をそのまま描画し、
// LLMの生成文を経由しない(WeeklySummaryCardと同じ権威分離)。母数不足時は現在N/必要N/
// 見込み日数の到達条件のみを表示し、率・%・矢印・断定語(「改善しました」等)は一切出さない
// (CLAUDE.md「絶対にやってはいけないこと」34: 計測の土台が壊れたまま効果を数値で出さない。
// 「点推定を単独で出さない」: 母数充足時も必ず95%信頼区間を併記する)。
function RuleEffectCard({
  card,
  onSendReal,
}: {
  card: Extract<Card, { kind: "ruleEffect" }>;
  onSendReal?: (action: string) => void;
}) {
  // GID 1217752900578379 (R4 S6): 効果を見て終わりにせず、その場で打ち手に繋げる
  // (CLAUDE.md 禁止15「動線として閉じていない機能を足す」)。既存の update_tuning_rule に
  // 自然文で着地させる(新規ツールを作らない)。母数不足・充足いずれの状態でも無効化はできる
  // (判定待ちのルールを止めるかどうかは店主の判断であり、機能側で先回りして制限しない)。
  const disableButton = onSendReal && (
    <button
      onClick={() => onSendReal(`__real:指示ルール（ID: ${card.ruleId}）を無効にしてください`)}
      style={{ alignSelf: "flex-start", fontSize: 13.5, fontWeight: 700, padding: "8px 14px", borderRadius: 10, cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: "var(--muted-foreground)", minHeight: 44 }}
    >
      このルールを無効にする
    </button>
  );

  if (card.progress) {
    return (
      <CardShell hd={<><span>📊</span>ルール効果（ID: {card.ruleId}）</>} tone="agent">
        <div style={{ fontSize: 14, color: "var(--foreground)" }}>
          まだ判定できません（判定に必要な会話数が不足しています）
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {card.progress.map((p) => (
            <div
              key={p.group}
              style={{
                fontSize: 13.5,
                color: "var(--muted-foreground)",
                background: "var(--muted, rgba(120,120,140,0.08))",
                borderRadius: 8,
                padding: "8px 12px",
              }}
            >
              {p.groupLabel}: 現在{p.currentN}件 / 必要{p.requiredN}件
              {p.etaDays != null && `（現ペースであと約${p.etaDays}日）`}
            </div>
          ))}
        </div>
        {disableButton}
      </CardShell>
    );
  }

  // 型上 comparison/progress は互いに排他だが、防御的にnullガードする(実行時の値混入対策)。
  if (!card.comparison) return null;

  const { didEstimate, ci95Low, ci95High, naiveTreatmentDelta } = card.comparison;
  const tone = ci95Low > 0 ? "good" : ci95High < 0 ? "bad" : "agent";
  const verdict =
    ci95Low > 0
      ? "効いている可能性が高いです"
      : ci95High < 0
        ? "逆効果の可能性があります"
        : "まだ判定できません（差が誤差の範囲内です）";

  return (
    <CardShell hd={<><span>📊</span>ルール効果（ID: {card.ruleId}）</>} tone={tone}>
      <div style={{ fontSize: 15, fontWeight: 700, color: "var(--foreground)" }}>{verdict}</div>
      <Field k="推定差分" v={`${didEstimate}点（95%信頼区間: ${ci95Low}〜${ci95High}）`} />
      <Field k="参考（対照群との比較前の単純差分）" v={`${naiveTreatmentDelta}点`} />
      {card.truncated && (
        <div style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
          ※直近{card.analyzedSessions}件のセッションで判定しています
        </div>
      )}
      {disableButton}
    </CardShell>
  );
}

// W2-4(docs/COPILOT_UI_PARITY.md §3.1 #12): 会話数の日次推移+低評価セッション。
// 旧UI(analytics/index.tsx の TrendChartsSection/LowScoreSessionsTable)の再現。
// 数値はすべてサーバ集計値(card)をそのまま描画し、LLMの生成文を経由しない
// (RuleEffectCard/WeeklySummaryCardと同じ権威分離)。棒グラフはchart.jsを持ち込まず、
// conversion/index.tsx の BarChart と同じ依存無しCSS実装に揃える(このカードのためだけに
// チャットバンドルへchart.jsを追加しない)。
function AnalyticsTrendCard({
  card,
  onSendReal,
}: {
  card: Extract<Card, { kind: "analyticsTrend" }>;
  onSendReal?: (action: string) => void;
}) {
  const { daily, lowScoreSessions, period } = card;
  const periodLabel = period === "7d" ? "直近7日間" : period === "90d" ? "直近90日間" : "直近30日間";
  const totalSessions = daily.reduce((sum, d) => sum + d.sessions, 0);
  const maxSessions = Math.max(...daily.map((d) => d.sessions), 1);

  return (
    <CardShell hd={<><span>📈</span>会話数の推移（{periodLabel}）</>} tone="agent">
      <div style={{ fontSize: 15, fontWeight: 700, color: "var(--foreground)" }}>
        合計 {totalSessions}件
      </div>
      {daily.length > 0 && (
        <>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 64 }}>
            {daily.map((d) => (
              <div
                key={d.date}
                title={`${d.date}: ${d.sessions}件${d.avgScore != null ? ` / スコア${d.avgScore.toFixed(0)}` : ""}`}
                style={{
                  flex: "1 1 0",
                  minWidth: 2,
                  height: `${Math.max((d.sessions / maxSessions) * 100, d.sessions > 0 ? 4 : 1)}%`,
                  background: "linear-gradient(180deg, #3b82f6, #8b5cf6)",
                  borderRadius: 2,
                }}
              />
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted-foreground)" }}>
            <span>{daily[0]!.date.slice(5)}</span>
            <span>{daily[daily.length - 1]!.date.slice(5)}</span>
          </div>
        </>
      )}
      {lowScoreSessions.length > 0 ? (
        <div>
          <div style={{ fontSize: 12.5, color: "var(--muted-foreground)", fontWeight: 600, marginBottom: 6 }}>
            低評価セッション（スコア40未満、下位{lowScoreSessions.length}件）
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {lowScoreSessions.map((s) => (
              <div
                key={s.shortId}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13.5,
                  background: "var(--muted, rgba(120,120,140,0.08))",
                  borderRadius: 8,
                  padding: "8px 12px",
                }}
              >
                <span style={{ color: "var(--foreground)" }}>
                  [{s.shortId}] スコア{s.score.toFixed(0)}（{s.messageCount}件のやり取り）
                </span>
                {onSendReal && (
                  <button
                    onClick={() => onSendReal(`__real:会話 [${s.shortId}] の中身を見せて`)}
                    style={{ flexShrink: 0, fontSize: 12, fontWeight: 700, padding: "6px 10px", borderRadius: 8, cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: AGENT, minHeight: 36 }}
                  >
                    見る
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 13.5, color: "var(--muted-foreground)" }}>
          低評価セッション（スコア40未満）はありません
        </div>
      )}
    </CardShell>
  );
}

// A/Bテストのstatus表示。旧UI(conversion/index.tsx STATUS_COLORS・conversion.ab_status_*)と
// 同じ4状態・同じ日本語ラベルに揃える(このカードのためだけにi18n辞書は持ち込まない)。
const AB_STATUS_LABEL: Record<string, string> = { draft: "準備中", running: "実施中", completed: "完了", cancelled: "中止" };

// W2-5(docs/COPILOT_UI_PARITY.md §3.1 #13): 実施中/直近のA/Bテスト結果+改善提案。
// 旧UI(conversion/index.tsx の A/Bテストセクション・改善提案セクション)の再現。
// 数値はすべてサーバ集計値(card)をそのまま描画する(AnalyticsTrendCardと同じ権威分離)。
// 改善提案の「適用」は専用の保存ツールを新設せず、既存の suggest_tuning_rule フローに
// 委ねる(__real: 送信でLLMに続けさせる。TuningRuleDraftCard等と同じ作法)。
function AbTestResultsCard({
  card,
  onSendReal,
}: {
  card: Extract<Card, { kind: "abTestResults" }>;
  onSendReal?: (action: string) => void;
}) {
  const { experiments, suggestions } = card;

  return (
    <CardShell hd={<><span>🔬</span>A/Bテスト結果・改善提案</>} tone="agent">
      {experiments.length === 0 ? (
        <div style={{ fontSize: 13.5, color: "var(--muted-foreground)" }}>実施中/直近のA/Bテストはありません</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {experiments.map((exp) => (
            <div key={exp.id} style={{ display: "flex", flexDirection: "column", gap: 6, background: "var(--muted, rgba(120,120,140,0.08))", borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ padding: "2px 8px", borderRadius: 999, background: "rgba(120,120,140,0.15)", fontSize: 11, fontWeight: 700, color: "var(--muted-foreground)", whiteSpace: "nowrap" }}>
                  {AB_STATUS_LABEL[exp.status] ?? exp.status}
                </span>
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--foreground)" }}>{exp.name}</span>
              </div>
              {!exp.results ? (
                <div style={{ fontSize: 12.5, color: "var(--muted-foreground)" }}>まだ結果はありません</div>
              ) : !exp.results.reliable ? (
                <div style={{ fontSize: 12.5, color: "var(--muted-foreground)" }}>{exp.results.warning}</div>
              ) : (
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {Object.entries(exp.results.variants).map(([variant, s]) => (
                    <div key={variant} style={{ fontSize: 12.5, color: "var(--foreground)" }}>
                      <strong>{variant}</strong>: 継続率{s.reachedTwoPlusRate}% / 成約率{s.conversionRate}%（{s.exposed}件）
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <div>
        <div style={{ fontSize: 12.5, color: "var(--muted-foreground)", fontWeight: 600, marginBottom: 6 }}>
          改善提案
        </div>
        {suggestions.length === 0 ? (
          <div style={{ fontSize: 13.5, color: "var(--muted-foreground)" }}>現在、改善提案はありません</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {suggestions.map((s) => (
              <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 13.5, background: "var(--muted, rgba(120,120,140,0.08))", borderRadius: 8, padding: "8px 12px" }}>
                <span style={{ color: "var(--foreground)" }}>{s.description}</span>
                {onSendReal && s.suggestedAction && (
                  <button
                    onClick={() => onSendReal(`__real:「${s.suggestedAction}」というルールを追加して`)}
                    style={{ flexShrink: 0, fontSize: 12, fontWeight: 700, padding: "6px 10px", borderRadius: 8, cursor: "pointer", border: "1px solid var(--border)", background: "transparent", color: AGENT, minHeight: 36 }}
                  >
                    適用する
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </CardShell>
  );
}

const KNOWLEDGE_SOURCE_LABEL: Record<string, string> = { faq: "FAQ", book: "書籍" };
const KNOWLEDGE_TREND_LABEL: Record<string, { label: string; color: string }> = {
  up: { label: "▲", color: "#4ade80" },
  down: { label: "▼", color: "#f87171" },
  stable: { label: "→", color: "var(--muted-foreground)" },
  insufficient_data: { label: "判定不能", color: "var(--muted-foreground)" },
};

// W2-6(docs/COPILOT_UI_PARITY.md §3.1 #14): FAQ・書籍の知識チャンクごとの成約(CV)貢献度。
// 旧UI(KnowledgeAttributionTab.tsx)の再現。数値はすべてサーバ集計値(card)をそのまま
// 描画する(AbTestResultsCardと同じ権威分離)。旧UIのTop10棒グラフ+chart.jsは持ち込まず、
// 成約率が高い順の上位5件をリスト表示に絞る(AnalyticsTrendCardと同じ簡素化方針)。
function KnowledgeAttributionCard({ card }: { card: Extract<Card, { kind: "knowledgeAttribution" }> }) {
  const { period, totalChunksUsed, avgConversionRate, topItems, worstPerformer } = card;
  const periodLabel = period === "7d" ? "直近7日間" : period === "90d" ? "直近90日間" : "直近30日間";

  return (
    <CardShell hd={<><span>🧠</span>ナレッジ別の成約貢献度（{periodLabel}）</>} tone="agent">
      {topItems.length === 0 ? (
        <div style={{ fontSize: 13.5, color: "var(--muted-foreground)" }}>対象期間にRAGで参照されたナレッジはありません</div>
      ) : (
        <>
          <div style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
            利用チャンク数 {totalChunksUsed}件（平均成約率 {(avgConversionRate * 100).toFixed(1)}%）
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {topItems.map((it) => {
              const trend = KNOWLEDGE_TREND_LABEL[it.trend] ?? KNOWLEDGE_TREND_LABEL["stable"]!;
              return (
                <div key={it.chunkId} style={{ display: "flex", flexDirection: "column", gap: 2, background: "var(--muted, rgba(120,120,140,0.08))", borderRadius: 8, padding: "8px 12px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ padding: "2px 8px", borderRadius: 999, background: "rgba(120,120,140,0.15)", fontSize: 11, fontWeight: 700, color: "var(--muted-foreground)", whiteSpace: "nowrap" }}>
                      {KNOWLEDGE_SOURCE_LABEL[it.source] ?? it.source}
                    </span>
                    <span style={{ fontSize: 13.5, color: "var(--foreground)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--muted-foreground)" }}>
                    成約率 <strong style={{ color: "var(--foreground)" }}>{(it.conversionRate * 100).toFixed(1)}%</strong>
                    <span style={{ color: trend.color, marginLeft: 4 }}>{trend.label}</span>
                    {` （${it.usageCount}回利用/${it.conversationCount}会話）`}
                  </div>
                </div>
              );
            })}
          </div>
          {worstPerformer && worstPerformer.chunkId !== topItems[0]?.chunkId && (
            <div style={{ fontSize: 12.5, color: "var(--muted-foreground)" }}>
              要改善: [{KNOWLEDGE_SOURCE_LABEL[worstPerformer.source] ?? worstPerformer.source}] {worstPerformer.title}: 成約率{(worstPerformer.conversionRate * 100).toFixed(1)}%
            </div>
          )}
        </>
      )}
    </CardShell>
  );
}

// W2-7(docs/COPILOT_UI_PARITY.md §3.1 #15): ご利用状況・お支払い(閲覧専用)。旧UI
// (pages/admin/billing/index.tsx)の再現だが、D2決定により閲覧一式に限定する — 請求書の
// 再送・金額調整・無料期間・プラン変更・一時停止/再開のボタンは一切出さない(旧UIでは
// それらもsuper_admin以外には隠れているが、この画面はテナント自身が見るものなので
// そもそもボタン自体を存在させない)。portalUrlはStripeが発行する読み取り専用の顧客
// ポータル(支払い方法の確認・変更・請求書ダウンロードができる、Stripe自身の認証で
// 保護された画面)なので、外部リンクとして案内する(旧UIの「invoices」タブと同じ導線)。
// UX-C(2026-08-26): 込み枠1本分のバー。QuotaSection.tsx(旧UI)と同じ配色規則
// (80%未満=緑・80〜99%=黄・100%以上=赤)。旧UIとは別コンポーネント階層(この画面は
// chat-embedded cardでQuotaSectionを直接importする構成に無い)なので、視覚仕様だけ
// 揃えて実装はここに閉じる。
function BillingQuotaBar({ label, used, included, unit }: { label: string; used: number; included: number; unit: string }) {
  const percentage = included > 0 ? Math.min(100, Math.round((used / included) * 100)) : 0;
  const color = percentage >= 100 ? "#f87171" : percentage >= 80 ? "#fbbf24" : "#4ade80";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
      <span style={{ width: 80, flexShrink: 0, color: "var(--muted-foreground)" }}>{label}</span>
      <div style={{ flex: 1, height: 8, borderRadius: 4, background: "rgba(120,120,140,0.15)", overflow: "hidden" }}>
        <div style={{ width: `${percentage}%`, height: "100%", background: color }} />
      </div>
      <span style={{ width: 110, flexShrink: 0, textAlign: "right", color: "var(--foreground)" }}>
        {used.toLocaleString("ja-JP")} / {included.toLocaleString("ja-JP")}{unit}
      </span>
    </div>
  );
}

function BillingSummaryCard({ card }: { card: Extract<Card, { kind: "billingSummary" }> }) {
  const { period, plan, billingEstimateJpy, breakdown, invoicesAvailable, invoices, portalUrl, quota } = card;
  const periodLabel = period === "7d" ? "直近7日間" : period === "90d" ? "直近90日間" : "直近30日間";

  return (
    <CardShell hd={<><span>💳</span>ご利用状況・お支払い（{periodLabel}）</>} tone="agent">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ padding: "3px 10px", borderRadius: 999, background: "rgba(120,120,140,0.15)", fontSize: 12, fontWeight: 700, color: "var(--foreground)", whiteSpace: "nowrap" }}>
          {plan}
        </span>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--foreground)" }}>
          今期の請求見積り {billingEstimateJpy !== null ? `${billingEstimateJpy.toLocaleString("ja-JP")}円` : "算出できません"}
        </span>
      </div>
      {/* UX-C: 今月(JST暦月)の込み枠・無料枠消費。上のperiod(直近7/30/90日)とは別軸。
          quotaがnull(取得不可)のときはブロックごと出さない(0件と誤読させない)。 */}
      {quota && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 11.5, color: "var(--muted-foreground)" }}>今月の利用枠</div>
          {quota.freeAd ? (
            <>
              <BillingQuotaBar label="会話数" used={quota.freeAd.used} included={quota.freeAd.limit} unit="会話" />
              {quota.freeAd.remaining === 0 && (
                <div style={{ fontSize: 12.5, color: "#f87171", fontWeight: 700 }}>
                  今月の上限に到達しています。新しい会話は翌月まで開始できません。
                </div>
              )}
            </>
          ) : quota.text.included !== null && quota.avatar.includedMinutes !== null ? (
            <>
              <BillingQuotaBar label="テキスト会話" used={quota.text.used} included={quota.text.included} unit="会話" />
              <BillingQuotaBar label="アバター利用" used={quota.avatar.usedMinutes} included={quota.avatar.includedMinutes} unit="分" />
              {(quota.text.overage > 0 || quota.avatar.overageMinutes > 0) && (
                <div style={{ fontSize: 12, color: "#fbbf24" }}>
                  込み枠を超過しています(超過分は従量で加算されます)
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 12.5, color: "var(--muted-foreground)" }}>
              {plan === "enterprise" ? "利用量に上限はありません" : "込み枠の無い純従量プランです"}
              （当月{quota.text.used.toLocaleString("ja-JP")}会話）
            </div>
          )}
        </div>
      )}
      {breakdown.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontSize: 11.5, color: "var(--muted-foreground)" }}>機能別の原価構成比(参考)</div>
          {breakdown.map((b) => (
            <div key={b.feature} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
              <span style={{ width: 80, flexShrink: 0, color: "var(--muted-foreground)" }}>{b.label}</span>
              <div style={{ flex: 1, height: 8, borderRadius: 4, background: "rgba(120,120,140,0.15)", overflow: "hidden" }}>
                <div style={{ width: `${b.percentage}%`, height: "100%", background: "linear-gradient(90deg, #3b82f6, #8b5cf6)" }} />
              </div>
              <span style={{ width: 90, flexShrink: 0, textAlign: "right", color: "var(--foreground)" }}>{b.percentage}%（${b.costUsd.toLocaleString("en-US")}）</span>
            </div>
          ))}
        </div>
      )}
      <div>
        <div style={{ fontSize: 12.5, color: "var(--muted-foreground)", fontWeight: 600, marginBottom: 6 }}>
          直近の請求書
        </div>
        {!invoicesAvailable ? (
          <div style={{ fontSize: 13.5, color: "var(--muted-foreground)" }}>
            現在確認できません（契約中のサブスクリプションがないか、一時的に取得できません）
          </div>
        ) : invoices.length === 0 ? (
          <div style={{ fontSize: 13.5, color: "var(--muted-foreground)" }}>請求書はまだありません</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {invoices.map((inv) => (
              <div key={inv.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 13.5, background: "var(--muted, rgba(120,120,140,0.08))", borderRadius: 8, padding: "8px 12px" }}>
                <span style={{ color: "var(--foreground)" }}>
                  [{inv.statusLabel}] {inv.amountDue.toLocaleString("ja-JP")}円（{new Date(inv.created * 1000).toISOString().slice(0, 10)}）
                </span>
                {inv.hostedInvoiceUrl && (
                  <a href={inv.hostedInvoiceUrl} target="_blank" rel="noopener noreferrer" style={{ flexShrink: 0, fontSize: 12, fontWeight: 700, color: AGENT }}>
                    詳細 ↗
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {portalUrl && (
        <a
          href={portalUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: "inline-flex", alignSelf: "flex-start", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 10, border: "1px solid var(--border)", background: "transparent", color: AGENT, fontSize: 13.5, fontWeight: 700, textDecoration: "none" }}
        >
          お支払い方法の確認・変更 ↗
        </a>
      )}
    </CardShell>
  );
}

// CP-3(GID 1218086647623729): change_my_plan の実行後カード。billingSyncNeedsAttention
// は握り潰さず必ず警告として出す(サーバ側 actionExecutor.ts の同名コメント参照。
// ここで無視すると「変更しました」とだけ見えて、請求構成が追随していないことに
// 誰も気づけない)。
function PlanChangedCard({ card }: { card: Extract<Card, { kind: "planChanged" }> }) {
  const { previousPlanLabel, planLabel, billingSyncNeedsAttention } = card;
  return (
    <CardShell hd={<><span>💳</span>プラン変更</>} tone={billingSyncNeedsAttention ? "bad" : "good"}>
      <div style={{ fontSize: 15, fontWeight: 700, color: "var(--foreground)" }}>
        {previousPlanLabel} → {planLabel}
      </div>
      {billingSyncNeedsAttention && (
        <div style={{ fontSize: 12.5, color: "#f87171", fontWeight: 700 }}>
          注意: 請求構成の更新に問題が発生しました。運営（R2Cサポート）までご連絡ください
        </div>
      )}
    </CardShell>
  );
}

// 採用直後のカード。この画面のまま画像候補の生成に進める入口を持つ。
// ボタンは相談窓口の ResolutionPrompt/ConsultReplyCard と同じく、チャットの
// ツール呼び出しループを経由せずここから直接バックエンドを叩く(チップとは別系統)。
function AvatarAdoptedCard({
  card,
  onGenerate,
  onGeneratePremium,
  onUploadPhoto,
  onCloneVoice,
  onMatchVoice,
  onDesignVoice,
}: {
  card: Extract<Card, { kind: "avatarAdopted" }>;
  onGenerate: (configId: string, name: string, promptInput: AvatarPromptInput) => void | Promise<void>;
  onGeneratePremium: (configId: string, name: string, promptInput: AvatarPromptInput) => void | Promise<void>;
  onUploadPhoto: (configId: string, file: File) => void | Promise<void>;
  onCloneVoice: (configId: string, avatarName: string, file: File) => void | Promise<void>;
  onMatchVoice: (configId: string, description: string) => void | Promise<void>;
  onDesignVoice: (configId: string, instruction: string) => void | Promise<void>;
}) {
  const [busyImage, setBusyImage] = useState(false);
  const [busyVoice, setBusyVoice] = useState(false);
  const [busyDesignVoice, setBusyDesignVoice] = useState(false);
  const [busyPremium, setBusyPremium] = useState(false);
  const [premiumConfirming, setPremiumConfirming] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const voiceCloneInputRef = useRef<HTMLInputElement>(null);
  // W3-4: create_avatar_config(ゼロから作成)由来のカードはavatarType以下が埋まっている。
  // adopt_avatar_preset由来のカードは常にundefinedのため、既存どおりhuman/bust/smile/simple
  // に落ち着く(挙動を変えない)。
  const promptInput: AvatarPromptInput = {
    type: card.avatarType ?? "human",
    gender: card.gender,
    age: card.age,
    outfit: card.outfit,
    animalKind: card.animalKind,
    animalVibe: card.animalVibe,
    robotDesign: card.robotDesign,
    composition: "bust",
    expression: "smile",
    background: "simple",
  };
  const handleGenerate = () => {
    setBusyImage(true);
    void Promise.resolve(onGenerate(card.configId, card.name, promptInput)).finally(() => setBusyImage(false));
  };
  // W3-3: 高品質生成(Flux 2 Pro + Magnific)は通常生成より高い費用がかかるため、
  // Asana制約U-17(実行前の費用明示。繰り返し頼まれても毎回明示する)に沿って
  // ボタン1回目の押下では確定させず、確認文を挟む。confirming状態は生成完了/
  // キャンセルのたびにfalseへ戻す(押すたびに毎回訊く。前回同意を記憶しない)。
  const handlePremiumClick = () => setPremiumConfirming(true);
  const handlePremiumCancel = () => setPremiumConfirming(false);
  const handlePremiumConfirm = () => {
    setPremiumConfirming(false);
    setBusyPremium(true);
    void Promise.resolve(onGeneratePremium(card.configId, card.name, promptInput)).finally(() => setBusyPremium(false));
  };
  // W3-1: 旧UI(StudioImageSection.tsx)の「AIで生成」「写真をアップロード」2タブを
  // ここで並列の2ボタンとして提示する(ボタンを押した瞬間にファイル選択が開き、
  // 選んだ時点で即アップロードが始まる。「使う」の再確認は求めない — ドラッグ操作の
  // 意思表示に確認を挟まないPDF取り込みと同じ作法)。
  const handlePhotoInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void onUploadPhoto(card.configId, file);
  };
  // W3-2: 音声クローンも同じ作法(選んだ瞬間に確定)。旧UIはEnterpriseプラン未満だと
  // セクションごと隠すが、AVATAR_CHAT_MIGRATION.md §0決定3(アップセル導線は入口を
  // 塞がない)に沿ってボタン自体は常に出し、プラン未達はアップロード後のエラーカードで
  // サーバのplan_upgrade_requiredメッセージをそのまま案内する。
  const handleVoiceCloneInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void onCloneVoice(card.configId, card.name, file);
  };
  const handleMatchVoice = () => {
    setBusyVoice(true);
    // 声の説明を新たに尋ねず、採用済みの性格・話し方の説明をそのまま検索クエリにする。
    void Promise.resolve(onMatchVoice(card.configId, card.description)).finally(() => setBusyVoice(false));
  };
  const handleDesignVoice = () => {
    setBusyDesignVoice(true);
    // GID 1217084040141851: こちらも同じ理由で、性格・話し方の説明をそのまま
    // Voice Designのinstructionにする(声だけの追加質問をしない)。
    void Promise.resolve(onDesignVoice(card.configId, card.description)).finally(() => setBusyDesignVoice(false));
  };

  return (
    <CardShell
      tone="good"
      hd={<><span>✅</span>アバター「{card.name}」を{card.avatarType ? "作成" : "採用"}しました</>}
      foot={<CardActionsNote note="AIでの生成・声の検索・音声クローンのたびに少額の費用が発生します（写真のアップロードは無料です）。気に入るまで何度でもやり直せます。" />}
    >
      {card.imageUrl && (
        <img
          src={card.imageUrl}
          alt={card.name}
          style={{ width: 96, height: 96, borderRadius: 12, objectFit: "cover", alignSelf: "flex-start" }}
        />
      )}
      {card.avatarType && <Field k="見た目" v={describeAvatarAppearance(card)} />}
      <Field k="性格・話し方" v={card.description} quote />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          onClick={handleGenerate}
          disabled={busyImage}
          style={{
            alignSelf: "flex-start", fontSize: 14.5, fontWeight: 700, padding: "10px 18px", borderRadius: 12, minHeight: 44,
            border: "none", background: AGENT, color: "#fff",
            cursor: busyImage ? "not-allowed" : "pointer", opacity: busyImage ? 0.6 : 1,
          }}
        >
          {busyImage ? "生成しています…" : "画像を新しく生成する"}
        </button>
        <input
          ref={photoInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          style={{ display: "none" }}
          aria-hidden="true"
          tabIndex={-1}
          onChange={handlePhotoInputChange}
        />
        <button
          onClick={() => photoInputRef.current?.click()}
          style={{
            alignSelf: "flex-start", fontSize: 14.5, fontWeight: 700, padding: "10px 18px", borderRadius: 12, minHeight: 44,
            border: "1px solid var(--border)", background: "transparent", color: "var(--foreground)", cursor: "pointer",
          }}
        >
          自分の写真を使う
        </button>
        <button
          onClick={handlePremiumClick}
          disabled={busyPremium || premiumConfirming}
          style={{
            alignSelf: "flex-start", fontSize: 14.5, fontWeight: 700, padding: "10px 18px", borderRadius: 12, minHeight: 44,
            border: "1px solid var(--border)", background: "transparent", color: "var(--foreground)",
            cursor: busyPremium || premiumConfirming ? "not-allowed" : "pointer", opacity: busyPremium || premiumConfirming ? 0.6 : 1,
          }}
        >
          {busyPremium ? "高品質画像を生成しています…" : "💎 高品質な画像を生成する"}
        </button>
        <button
          onClick={handleMatchVoice}
          disabled={busyVoice}
          style={{
            alignSelf: "flex-start", fontSize: 14.5, fontWeight: 700, padding: "10px 18px", borderRadius: 12, minHeight: 44,
            border: "1px solid var(--border)", background: "transparent", color: "var(--foreground)",
            cursor: busyVoice ? "not-allowed" : "pointer", opacity: busyVoice ? 0.6 : 1,
          }}
        >
          {busyVoice ? "声を探しています…" : "声を探す"}
        </button>
        <button
          onClick={handleDesignVoice}
          disabled={busyDesignVoice}
          style={{
            alignSelf: "flex-start", fontSize: 14.5, fontWeight: 700, padding: "10px 18px", borderRadius: 12, minHeight: 44,
            border: "1px solid var(--border)", background: "transparent", color: "var(--foreground)",
            cursor: busyDesignVoice ? "not-allowed" : "pointer", opacity: busyDesignVoice ? 0.6 : 1,
          }}
        >
          {busyDesignVoice ? "声を作っています…" : "声を作る"}
        </button>
        <input
          ref={voiceCloneInputRef}
          type="file"
          accept="audio/mpeg,audio/wav,audio/mp4,audio/x-m4a,audio/m4a,audio/ogg"
          style={{ display: "none" }}
          aria-hidden="true"
          tabIndex={-1}
          onChange={handleVoiceCloneInputChange}
        />
        <button
          onClick={() => voiceCloneInputRef.current?.click()}
          style={{
            alignSelf: "flex-start", fontSize: 14.5, fontWeight: 700, padding: "10px 18px", borderRadius: 12, minHeight: 44,
            border: "1px solid var(--border)", background: "transparent", color: "var(--foreground)", cursor: "pointer",
          }}
        >
          自分の声をクローンする
        </button>
      </div>
      {premiumConfirming && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px 14px", borderRadius: 12, border: `1px solid ${AGENT_BORDER}`, background: AGENT_SOFT }}>
          <div style={{ fontSize: 13.5, color: "var(--foreground)", lineHeight: 1.6 }}>
            高品質な画像の生成には、通常の生成より高い費用がかかります。生成してよろしいですか？
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={handlePremiumConfirm}
              style={{
                fontSize: 13.5, fontWeight: 700, padding: "8px 16px", borderRadius: 10, minHeight: 40,
                border: "none", background: AGENT, color: "#fff", cursor: "pointer",
              }}
            >
              生成する
            </button>
            <button
              onClick={handlePremiumCancel}
              style={{
                fontSize: 13.5, fontWeight: 700, padding: "8px 16px", borderRadius: 10, minHeight: 40,
                border: "1px solid var(--border)", background: "transparent", color: "var(--muted-foreground)", cursor: "pointer",
              }}
            >
              やめる
            </button>
          </div>
        </div>
      )}
    </CardShell>
  );
}

// 画像候補の生成〜採用。生成はエージェントツール経由にしない(画像URL群はツール結果の
// 500字に収まらない)ため、直接バックエンドを叩く。3つの状態(生成中/完了/失敗)は
// 必ずどれかで確定させ、無限スピナーを残さない。
function AvatarCandidatesCard({
  card,
  msgId,
  onGenerate,
  onGeneratePremium,
  onAdopt,
}: {
  card: Extract<Card, { kind: "avatarCandidates" }>;
  msgId: number;
  onGenerate: (configId: string, name: string, promptInput: AvatarPromptInput) => void | Promise<void>;
  onGeneratePremium: (configId: string, name: string, promptInput: AvatarPromptInput) => void | Promise<void>;
  onAdopt: (cardMsgId: number, configId: string, imageUrl: string) => void | Promise<void>;
}) {
  const [adopting, setAdopting] = useState<string | null>(null);
  // W3-3: premiumはヘッダ・再生成先の出し分けにのみ使う。再生成(「もう一度試す」
  // 「別の候補を見る」)は費用の再確認を挟まない — この2ボタンはユーザーが直前に
  // 明示的に選んだ「高品質生成」の続き操作であり、U-17が指す新規の依頼ではない。
  // card.promptInputはgenerateAvatarCandidates/generatePremiumAvatarCandidateが
  // 生成開始時に複製した値。無い(=旧カードとの後方互換)場合はhuman/bust/smile/simpleの
  // 既存既定にフォールバックする。
  const retryPromptInput: AvatarPromptInput = card.promptInput ?? { type: "human", composition: "bust", expression: "smile", background: "simple" };
  const retry = () => void (card.premium ? onGeneratePremium(card.configId, card.name, retryPromptInput) : onGenerate(card.configId, card.name, retryPromptInput));

  if (card.status === "generating") {
    return (
      <CardShell hd={<><span>{card.premium ? "💎" : "🎨"}</span>{card.premium ? "高品質な画像を生成しています" : "新しい画像を生成しています"}</>}>
        <div style={{ fontSize: 14, color: "var(--muted-foreground)", lineHeight: 1.7 }}>
          {card.premium ? "1〜2分ほどかかることがあります。このまま他の操作もできます。" : "数十秒かかることがあります。このまま他の操作もできます。"}
        </div>
      </CardShell>
    );
  }

  if (card.status === "failed") {
    return (
      <CardShell
        tone="bad"
        hd={<><span>{card.premium ? "💎" : "🎨"}</span>{card.premium ? "高品質な画像を生成できませんでした" : "画像を生成できませんでした"}</>}
        foot={
          <div style={{ padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
            <button
              onClick={retry}
              style={{
                fontSize: 13.5, fontWeight: 700, padding: "7px 16px", borderRadius: 999, minHeight: 36,
                border: `1px solid ${AGENT_BORDER}`, background: AGENT_SOFT, color: AGENT, cursor: "pointer",
              }}
            >
              もう一度試す
            </button>
          </div>
        }
      >
        {card.message && <div style={{ fontSize: 15, color: "var(--foreground)", lineHeight: 1.7 }}>{card.message}</div>}
      </CardShell>
    );
  }

  const handleAdopt = (imageUrl: string) => {
    setAdopting(imageUrl);
    void Promise.resolve(onAdopt(msgId, card.configId, imageUrl)).finally(() => setAdopting(null));
  };

  return (
    <CardShell
      tone="good"
      hd={<><span>{card.premium ? "💎" : "🎨"}</span>{card.premium ? "高品質な候補です" : "新しい候補です"}</>}
      foot={
        !card.adoptedUrl ? (
          <div style={{ padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
            <button
              onClick={retry}
              style={{
                fontSize: 13.5, fontWeight: 700, padding: "7px 16px", borderRadius: 999, minHeight: 36,
                border: "1px solid var(--border)", background: "transparent", color: "var(--muted-foreground)", cursor: "pointer",
              }}
            >
              別の候補を見る
            </button>
          </div>
        ) : undefined
      }
    >
      {card.message && <div style={{ fontSize: 13, color: "var(--muted-foreground)" }}>{card.message}</div>}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {(card.images ?? []).map((url) => {
          const isAdopted = card.adoptedUrl === url;
          const disabled = !!card.adoptedUrl || adopting !== null;
          return (
            <div key={url} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
              <img
                src={url}
                alt="アバター候補"
                style={{
                  width: 96, height: 96, borderRadius: 12, objectFit: "cover",
                  border: isAdopted ? `2px solid ${AGENT}` : "1px solid var(--border)",
                }}
              />
              <button
                onClick={() => handleAdopt(url)}
                disabled={disabled}
                style={{
                  fontSize: 12.5, fontWeight: 700, padding: "5px 12px", borderRadius: 999, minHeight: 32,
                  border: isAdopted ? "none" : "1px solid var(--border)",
                  background: isAdopted ? AGENT : "transparent",
                  color: isAdopted ? "#fff" : "var(--muted-foreground)",
                  cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled && !isAdopted ? 0.5 : 1,
                }}
              >
                {isAdopted ? "これに決定" : adopting === url ? "反映中…" : "これにする"}
              </button>
            </div>
          );
        })}
      </div>
    </CardShell>
  );
}

// 声の候補〜採用。match-voice はテキストの候補(id/title/description/score)のみを
// 返し、音声プレビューURLを持たない(旧UIウィザードのStudioVoiceSectionも試聴機能を
// 持たない。Fish Audio検索APIの応答に含まれないため)。名前とスコアを頼りに選ぶ形になる。
function AvatarVoiceCard({
  card,
  msgId,
  onMatch,
  onAdopt,
  onDesign,
  onAdoptDesigned,
}: {
  card: Extract<Card, { kind: "avatarVoiceCandidates" }>;
  msgId: number;
  onMatch: (configId: string, description: string) => void | Promise<void>;
  onAdopt: (cardMsgId: number, configId: string, voiceId: string) => void | Promise<void>;
  onDesign: (configId: string, instruction: string) => void | Promise<void>;
  onAdoptDesigned: (cardMsgId: number, configId: string, candidateId: string) => void | Promise<void>;
}) {
  const [adopting, setAdopting] = useState<string | null>(null);
  // GID 1217084040141851: mode省略時(既存カード)は"match"扱いで従来どおり動く。
  const isDesign = card.mode === "design";
  const isClone = card.mode === "clone";

  if (card.status === "matching") {
    return (
      <CardShell hd={<><span>🔊</span>{isClone ? "音声クローンを作成しています" : isDesign ? "声を作っています" : "合う声を探しています"}</>}>
        {isClone && card.fileName && <Field k="ファイル" v={card.fileName} />}
        <div style={{ fontSize: 14, color: "var(--muted-foreground)", lineHeight: 1.7 }}>
          {isClone ? "作成には30〜60秒ほどかかります。このまま他の操作もできます。" : "少し時間がかかることがあります。このまま他の操作もできます。"}
        </div>
      </CardShell>
    );
  }

  if (card.status === "failed") {
    return (
      <CardShell
        tone="bad"
        hd={<><span>🔊</span>{isClone ? "音声クローンを作成できませんでした" : isDesign ? "声を作成できませんでした" : "声を検索できませんでした"}</>}
        foot={
          isClone ? (
            // クローンはファイル添付が起点のため、テキストの説明を使ったonMatch/onDesignの
            // 「もう一度試す」は成立しない(再度ファイルを選ぶ操作がボタンの外にある)。
            <CardActionsNote note="会話はそのまま続けられます。別の音声ファイルを試すか、既存の声から探す・作ることもお使いいただけます。" />
          ) : (
            <div style={{ padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
              <button
                onClick={() =>
                  void (isDesign ? onDesign(card.configId, card.description) : onMatch(card.configId, card.description))
                }
                style={{
                  fontSize: 13.5, fontWeight: 700, padding: "7px 16px", borderRadius: 999, minHeight: 36,
                  border: `1px solid ${AGENT_BORDER}`, background: AGENT_SOFT, color: AGENT, cursor: "pointer",
                }}
              >
                もう一度試す
              </button>
            </div>
          )
        }
      >
        {isClone && card.fileName && <Field k="ファイル" v={card.fileName} />}
        {card.message && <div style={{ fontSize: 15, color: "var(--foreground)", lineHeight: 1.7 }}>{card.message}</div>}
      </CardShell>
    );
  }

  if (isClone) {
    // POST /voice-clone は単発でvoice_idを確定・保存するため、match/designのような
    // 候補一覧からの採用ステップが無い。status="done"に達した時点でadoptedVoiceIdは
    // 既に確定している。
    return (
      <CardShell tone="good" hd={<><span>✅</span>音声クローンを作成しました</>}>
        {card.fileName && <Field k="ファイル" v={card.fileName} />}
        <div style={{ fontSize: 14, color: "var(--muted-foreground)", lineHeight: 1.7 }}>
          このアバターの声を新しいクローンに切り替えました。
        </div>
      </CardShell>
    );
  }

  const handleAdopt = (voiceId: string) => {
    setAdopting(voiceId);
    void Promise.resolve(onAdopt(msgId, card.configId, voiceId)).finally(() => setAdopting(null));
  };
  const handleAdoptDesigned = (candidateId: string) => {
    setAdopting(candidateId);
    void Promise.resolve(onAdoptDesigned(msgId, card.configId, candidateId)).finally(() => setAdopting(null));
  };

  return (
    <CardShell
      tone="good"
      hd={<><span>🔊</span>{isDesign ? "声の候補ができました" : "声の候補です"}</>}
      foot={
        <CardActionsNote
          note={
            isDesign
              ? "試聴してから選べます。採用すると声を作り直せなくなるので、聴いてからお決めください。"
              : "音声のプレビューは提供されていません。名前と説明を参考にお選びください。"
          }
        />
      }
    >
      {card.message && <div style={{ fontSize: 13, color: "var(--muted-foreground)" }}>{card.message}</div>}
      {isDesign ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {(card.audioCandidates ?? []).map((cand, i) => {
            // 採用後はどの候補を選んだか区別できないため(adoptedVoiceIdはFishの永続モデルID、
            // candidate.idはVoice Design内部の一時ID)、いずれか1件を採用したら全候補を確定表示にする。
            const adoptedAny = !!card.adoptedVoiceId;
            const disabled = adoptedAny || adopting !== null;
            return (
              <div
                key={cand.id}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap",
                  padding: "10px 14px", borderRadius: 10,
                  border: "1px solid var(--border)",
                  background: "transparent",
                }}
              >
                <div style={{ minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: "var(--foreground)" }}>候補{i + 1}</span>
                  <audio controls src={`data:audio/wav;base64,${cand.audioBase64}`} style={{ height: 32, maxWidth: 220 }} />
                </div>
                <button
                  onClick={() => handleAdoptDesigned(cand.id)}
                  disabled={disabled}
                  style={{
                    flexShrink: 0, fontSize: 12.5, fontWeight: 700, padding: "7px 14px", borderRadius: 999, minHeight: 36,
                    border: adoptedAny ? "none" : "1px solid var(--border)",
                    background: adoptedAny ? AGENT : "transparent",
                    color: adoptedAny ? "#fff" : "var(--muted-foreground)",
                    cursor: disabled ? "not-allowed" : "pointer",
                    opacity: disabled && !adoptedAny ? 0.5 : 1,
                  }}
                >
                  {adoptedAny ? "決定済み" : adopting === cand.id ? "反映中…" : "この声にする"}
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {(card.recommendations ?? []).map((rec) => {
            const isAdopted = card.adoptedVoiceId === rec.id;
            const disabled = !!card.adoptedVoiceId || adopting !== null;
            return (
              <div
                key={rec.id}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
                  padding: "10px 14px", borderRadius: 10,
                  border: isAdopted ? `1px solid ${AGENT}` : "1px solid var(--border)",
                  background: isAdopted ? AGENT_SOFT : "transparent",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: "var(--foreground)" }}>{rec.title}</span>
                    <span style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{Math.round(rec.score * 100)}%</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: "var(--muted-foreground)", marginTop: 2 }}>{rec.description}</div>
                </div>
                <button
                  onClick={() => handleAdopt(rec.id)}
                  disabled={disabled}
                  style={{
                    flexShrink: 0, fontSize: 12.5, fontWeight: 700, padding: "7px 14px", borderRadius: 999, minHeight: 36,
                    border: isAdopted ? "none" : "1px solid var(--border)",
                    background: isAdopted ? AGENT : "transparent",
                    color: isAdopted ? "#fff" : "var(--muted-foreground)",
                    cursor: disabled ? "not-allowed" : "pointer",
                    opacity: disabled && !isAdopted ? 0.5 : 1,
                  }}
                >
                  {isAdopted ? "これに決定" : adopting === rec.id ? "反映中…" : "この声にする"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </CardShell>
  );
}

// PDF取り込みカード。旧UIのPDFタブと同じ3点(ファイル名・送信の進捗%・結果)を、
// 会話の流れの中で見せる。成功時の見た目は他の書き込み操作の成功カードと同じ緑系に揃える。
function PdfUploadCard({ card }: { card: Extract<Card, { kind: "pdfUpload" }> }) {
  if (card.status === "uploading") {
    const pct = card.progress ?? 0;
    return (
      <CardShell hd={<><span>📄</span>PDFを受け取っています</>}>
        <Field k="ファイル" v={card.fileName} />
        <div>
          <div
            role="progressbar"
            aria-label="PDFの送信の進みぐあい"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            style={{ width: "100%", height: 6, borderRadius: 999, background: "var(--muted, rgba(120,120,140,0.15))", overflow: "hidden" }}
          >
            <div style={{ height: "100%", borderRadius: 999, background: AGENT, width: `${pct}%`, transition: "width 0.2s ease" }} />
          </div>
          <div style={{ marginTop: 5, fontSize: 12.5, color: "var(--muted-foreground)", fontVariantNumeric: "tabular-nums" }}>{pct}%</div>
        </div>
      </CardShell>
    );
  }

  if (card.status === "success") {
    return (
      <CardShell tone="good" hd={<><span>📚</span>PDFを受け取りました</>}>
        <Field k="ファイル" v={card.fileName} />
        {card.message && <div style={{ fontSize: 14, color: "var(--muted-foreground)", lineHeight: 1.7 }}>{card.message}</div>}
      </CardShell>
    );
  }

  return (
    <CardShell
      tone="bad"
      hd={<><span>📄</span>PDFを受け取れませんでした</>}
      foot={<CardActionsNote note="会話はそのまま続けられます。もう一度ファイルを送るか、内容を文章で教えてください。" />}
    >
      <Field k="ファイル" v={card.fileName} />
      {card.message && <div style={{ fontSize: 15, color: "var(--foreground)", lineHeight: 1.7 }}>{card.message}</div>}
    </CardShell>
  );
}

// W3-1(docs/COPILOT_UI_PARITY.md §3.1 #8): 写真アップロードの3状態(送っている/受け取った/
// 受け取れなかった)。PdfUploadCardと同じ作法(無限スピナーを残さない)。進捗率は
// FileReader+単発PATCHのため取れず(PDFのXHR進捗とは異なる)、送信中は不定表示にする。
function AvatarPhotoUploadCard({ card }: { card: Extract<Card, { kind: "avatarPhotoUpload" }> }) {
  if (card.status === "uploading") {
    return (
      <CardShell hd={<><span>🖼️</span>写真を受け取っています</>}>
        <Field k="ファイル" v={card.fileName} />
      </CardShell>
    );
  }

  if (card.status === "success") {
    return (
      <CardShell tone="good" hd={<><span>✅</span>アバター画像を差し替えました</>}>
        {card.imageUrl && (
          <img
            src={card.imageUrl}
            alt="アップロードした写真"
            style={{ width: 96, height: 96, borderRadius: 12, objectFit: "cover", alignSelf: "flex-start" }}
          />
        )}
        <Field k="ファイル" v={card.fileName} />
      </CardShell>
    );
  }

  return (
    <CardShell
      tone="bad"
      hd={<><span>🖼️</span>写真を反映できませんでした</>}
      foot={<CardActionsNote note="会話はそのまま続けられます。別の写真を試すか、AIでの生成もお使いいただけます。" />}
    >
      <Field k="ファイル" v={card.fileName} />
      {card.message && <div style={{ fontSize: 15, color: "var(--foreground)", lineHeight: 1.7 }}>{card.message}</div>}
    </CardShell>
  );
}

function CardActionsNote({ note }: { note: string }) {
  // ボタン自体はメッセージのchipsが担うため、ここは補足文のみ
  return (
    <div style={{ padding: "10px 18px", borderTop: "1px solid var(--border)", background: "var(--muted, rgba(120,120,140,0.06))", fontSize: 13, color: "var(--muted-foreground)" }}>
      {note}
    </div>
  );
}
