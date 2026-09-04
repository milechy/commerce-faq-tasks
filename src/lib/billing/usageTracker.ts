// src/lib/billing/usageTracker.ts
// Phase32: API使用量の非同期記録（fire-and-forget）

import type pino from 'pino';
import { calculateLLMCostCents, calculateBillingAmountCents,
  calculateBaseCostCents, normalizeModelKey, NON_BILLABLE_FEATURES,
  FEATURE_BILLING_DIMENSION } from './costCalculator';
import { queryTenantPlanResult, type TenantPlan } from './planFeatures';
import { planMultiplier } from './planPricing';

// DBのusage_logs_feature_used_check制約(migration_sai_agent_feature.sql /
// migration_admin_tooling_feature.sql)と一致させる。
// admin_guide / feedback_ai / book_analysis / book_structurize はDB側の制約には既に
// 含まれていたがTS型に無く未使用だった値（GID 1216944049264977 で配線）。
// admin_tuning / admin_ai_assist / admin_engagement_suggest / admin_option_estimator は
// GID 1216944003337186 で新設（いずれもNON_BILLABLE_FEATURES、原価可視化のみが目的）。
// agent_search は [A2A-1a] で新設（/agent.search・/agent/search の外部エージェント連携API）。
// これまで 'chat' に相乗りして計上していたが、他機能と原価を混ぜずに可視化するため分離した。
// ★billable=trueのまま維持すること★ NON_BILLABLE_FEATURES には入れない
// （外部API課金は '会話' と同じ課金対象。costCalculator.ts の END_USER_FEATURES と
// stripeSync.ts の text_units 集計SQLにも 'chat' の兄弟として追加済み。この2箇所を
// 追随させないと、Growth/Standardプランのテナントで agent_search 分が
// 一切請求されなくなる — CLAUDE.md 禁止55と同じ「複数箇所を同時に直す」種類の罠）。
// ★値そのものは costCalculator.ts の FEATURE_BILLING_DIMENSION が唯一の定義元★
// ここはそのキーから導出するだけ。新しい featureUsed を足すときは、あちらの map に
// 課金次元を宣言する以外に方法が無い（宣言しないとこの型に現れず trackUsage に渡せない）。
// 依存の向きは usageTracker → costCalculator の一方向。逆向きに import しないこと。
export type FeatureUsed = keyof typeof FEATURE_BILLING_DIMENSION;

export interface TrackUsageParams {
  tenantId: string;
  requestId: string;
  /**
   * この行が属する会話（chat_sessions.session_id）。テキストは「会話」単位で請求するため
   * （.claude/rules/billing.md §7 / CLAUDE.md 禁止56）、同一会話の複数リクエストを
   * stripeSync.computeExpectedBilling が1単位にまとめる鍵になる。
   *
   * 会話の概念がある経路（/api/chat）だけが渡す。管理系（admin_*）は会話ではないので渡さない。
   * アバター経路（POST /api/internal/usage ← avatar-agent/agent.py）は LiveKit の room 名しか
   * 知らず R2C の session_id を受け取れない（2026-08-26 時点）。アバターは分単位で請求するため
   * グルーピングを必要とせず、当面 undefined のままで支障が無い。
   *
   * 未指定なら NULL 記録。請求側は NULL 行を従来どおり 1行=1単位 として数える（取りこぼさない）。
   */
  sessionId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  featureUsed: FeatureUsed;
  /** マージン倍率の上書き（省略時は MARGIN_MULTIPLIER を使用） */
  marginOverride?: number;
  /** Phase40: Fish Audio TTSに送ったテキストのUTF-8バイト数 */
  ttsTextBytes?: number;
  /** GID 1217083837550852: 実際に使用したFish Audio TTSモデル名（原価計算にのみ使う。DB列は追加しない） */
  ttsModel?: string;
  /** Phase40: Lemonsliceのクレジット消費量 */
  avatarCredits?: number;
  /** Phase40: LiveKitセッション時間（ミリ秒） */
  avatarSessionMs?: number;
  /** Phase42: Anamセッション時間（秒） */
  anam_session_seconds?: number;
  /** Phase53: 生成画像枚数 */
  imageCount?: number;
  /**
   * Subtask 3: 同一リクエスト内の追加 LLM 呼び出し（マルチステップ planner 等）を
   * モデル別の実レートで本行のコストに内包する（別 usage_log を作らず請求リクエスト数を保つ）。
   */
  extraLlmUsages?: Array<{ model: string; inputTokens: number; outputTokens: number }>;
  /** Phase3 (Sai接続ブリッジ): Agent Sが実行したステップ数（社内原価集計のみ） */
  saiAgentSteps?: number;
  /** GID 1216944049264977: Qwen OCRで処理したページ数 */
  ocrPages?: number;
  /** GID 1216944049264977: Fish Audio ASR呼び出し回数（通常1リクエスト=1)。asrAudioSeconds未指定時のフォールバックのみに使う */
  asrRequestCount?: number;
  /** GID 1217083837550916: Fish Audio ASRの実測音声長(秒)。原価計算にのみ使う。DB列は追加しない */
  asrAudioSeconds?: number;
  /** GID 1217084040137242: Fish Audio Voice Design 呼び出し回数（成功リクエストのみ計上） */
  voiceDesignRequestCount?: number;
  /** GID 1216944049264977: Magnificアップスケール実行回数 */
  magnificUpscaleCount?: number;
  /** GID 1216944049264977: Flux 2 Pro 画像生成枚数 */
  fluxImageCount?: number;
  /** GID 1216944049264977: LemonSliceアバター登録（プロビジョニング）回数 */
  lemonsliceRegistrationCount?: number;
  /**
   * GID 1216944003337186: この行をStripe請求数量（billedQuantity）の対象にするか。
   * 省略時は featureUsed が NON_BILLABLE_FEATURES に含まれるかどうかで自動判定する
   * （明示的に渡した場合はそちらが優先される）。cost_total_cents は billable に関わらず
   * 常に計算・記録される（原価の可視化自体は billable=false でも行う）。
   */
  billable?: boolean;
}

let _pool: any | null = null;
let _logger: pino.Logger | null = null;

export function initUsageTracker(pool: any, logger: pino.Logger): void {
  _pool = pool;
  _logger = logger;
  _billingPlanCache.clear();
}

// ─── 請求用プラン解決（利用時点の倍率を焼き付けるため） ──────────────────────
//
// ★planFeatures.ts の getTenantPlan / tenantPlanCache を流用してはいけない★
// あちらは機能ゲート用で、取得失敗時に free_ad(=倍率0) へ倒す fail-safe を持つ。
// その値を usage_logs に焼き付けると、DB が一瞬詰まっただけでその分の請求が
// 恒久的に 0 円で固着し、後から見分けがつかなくなる（売上が静かに消える）。
//
// ここでは queryTenantPlanResult（確定できなければ null を返す。planFeatures.ts が
// 「機能ゲート用と実装を共有しない」ために独立させている関数）を使い、
// 確定できなかった場合は列を NULL のままにする。NULL 行は stripeSync 側で
// 従来どおり tenants.plan 由来の倍率にフォールバックする（挙動を変えない）。
interface BillingPlanCacheEntry {
  plan: TenantPlan;
  expiresAt: number;
}

/** 確定したプランのみを保持する。null(未確定)はキャッシュしない — 障害が尾を引かないように。 */
const _billingPlanCache: Map<string, BillingPlanCacheEntry> = new Map();

/**
 * planFeatures.ts の getTenantPlan と同じ 60 秒。
 * usage_logs への書き込みは最高トラフィック経路なので、毎行 SELECT は避ける。
 * プラン変更が最大60秒だけ旧倍率で焼かれるが、月次の請求額に対しては誤差。
 */
const BILLING_PLAN_CACHE_TTL_MS = 60 * 1000;

/**
 * プラン変更直後に呼び、以後の利用記録に新しい倍率を焼き付ける。
 * planFeatures.invalidateTenantPlanCache と対で呼ぶこと（キャッシュは2つある）。
 * 同一プロセス内のみ有効なのも同様（現構成は単一プロセスなので実質は即時）。
 */
export function invalidateBillingPlanCache(tenantId: string): void {
  _billingPlanCache.delete(tenantId);
}

/** テスト用: キャッシュを空にする。 */
export function _resetBillingPlanCacheForTest(): void {
  _billingPlanCache.clear();
}

async function _resolvePlanForBilling(tenantId: string): Promise<TenantPlan | null> {
  const now = Date.now();
  const cached = _billingPlanCache.get(tenantId);
  if (cached && cached.expiresAt > now) {
    return cached.plan;
  }

  const plan = await queryTenantPlanResult(_pool, tenantId);
  if (plan !== null) {
    _billingPlanCache.set(tenantId, { plan, expiresAt: now + BILLING_PLAN_CACHE_TTL_MS });
  }
  return plan;
}

// GID 1217808323836843: tenant_id が未解決のまま計上されると、/admin/billing の
// テナント別利用状況に「unknown」として溜まり続け、従量課金として請求できない
// 利用が静かに積み上がる。呼び出し元の実装ミス（tenantId をスコープに持ちながら
// 渡し忘れる等）を早期に気づけるよう warn を1回出す。
// ここで例外を投げると計上の失敗が本番機能を止めかねないため、あくまで警告に留める。
const UNRESOLVED_TENANT_IDS: ReadonlySet<string> = new Set(['unknown', '']);

function isUnresolvedTenantId(tenantId: string | undefined | null): boolean {
  return tenantId == null || UNRESOLVED_TENANT_IDS.has(tenantId);
}

function warnIfTenantUnresolved(params: TrackUsageParams): void {
  if (!isUnresolvedTenantId(params.tenantId)) return;
  _logger?.warn(
    {
      requestId: params.requestId,
      featureUsed: params.featureUsed,
      model: params.model,
      tenantId: params.tenantId ?? null,
    },
    '[usageTracker] trackUsage: tenantId unresolved — recorded as unknown tenant (billing gap; caller should pass a real tenantId)'
  );
}

/**
 * 使用量をDBに非同期で記録する（fire-and-forget）。
 * setImmediate で遅延実行するため API レスポンス速度に影響しない。
 */
export function trackUsage(params: TrackUsageParams): void {
  warnIfTenantUnresolved(params);
  setImmediate(() => {
    void _insertUsageLog(params);
  });
}

async function _insertUsageLog(params: TrackUsageParams): Promise<void> {
  if (!_pool) {
    _logger?.warn({ requestId: params.requestId }, '[usageTracker] pool not initialized, skipping');
    return;
  }

  const {
    tenantId, requestId, sessionId, model, inputTokens, outputTokens,
    featureUsed, marginOverride, ttsTextBytes, ttsModel, avatarCredits, avatarSessionMs, imageCount,
    anam_session_seconds, extraLlmUsages, saiAgentSteps,
    ocrPages, asrRequestCount, asrAudioSeconds, voiceDesignRequestCount, magnificUpscaleCount, fluxImageCount, lemonsliceRegistrationCount,
    billable,
  } = params;

  // GID 1216944003337186: billable未指定時はfeatureUsedから自動判定する。
  const isBillable = billable ?? !NON_BILLABLE_FEATURES.has(featureUsed);

  // Subtask 3: 追加 LLM（planner 等）に価格表に無いモデルが来た場合、コストは 0 計上になる。
  // env override 等で発生しうるため、サイレント未課金を避けるべく可視化ログを出す。
  if (extraLlmUsages) {
    for (const e of extraLlmUsages) {
      if ((e.inputTokens > 0 || e.outputTokens > 0) && !normalizeModelKey(e.model)) {
        _logger?.warn(
          { requestId, model: e.model },
          '[usageTracker] extra LLM model has no price entry — cost recorded as 0 (add to LLM_COSTS)',
        );
      }
    }
  }

  let costLlmCents = 0;
  let costTotalCents = 0;
  // マージン前の実原価。粗利（売上 − API原価）の原価側になる。
  // null は「未記録」を意味する列なので、算出できなければ 0 ではなく null を書く
  // （0 を書くと「原価ゼロ」と区別できなくなる。plan_multiplier と同じ流儀）。
  let costBaseCents: number | null = null;
  try {
    // 引数リストを2度書かない（片方にだけ新項目を足す事故を防ぐ）。
    const usageRecord = {
      model, inputTokens, outputTokens, marginOverride,
      ttsTextBytes, ttsModel, avatarCredits, avatarSessionMs,
      featureUsed, imageCount, anam_session_seconds, extraLlmUsages, saiAgentSteps,
      ocrPages, asrRequestCount, asrAudioSeconds, voiceDesignRequestCount, magnificUpscaleCount, fluxImageCount, lemonsliceRegistrationCount,
    };
    costLlmCents   = calculateLLMCostCents({ model, inputTokens, outputTokens, extraLlmUsages });
    costTotalCents = calculateBillingAmountCents(usageRecord);
    // marginOverride は原価に影響しない（マージン倍率にしか効かない）ので、
    // 同じレコードをそのまま渡してよい。
    costBaseCents  = calculateBaseCostCents(usageRecord);
  } catch (err) {
    _logger?.warn({ err, requestId }, '[usageTracker] cost calculation error, defaulting to 0');
  }

  // Subtask 3: cost に planner 分（extraLlmUsages）を内包したので、永続化する
  // input_tokens / output_tokens にも planner トークンを合算し、コストとトークンの
  // 整合性を保つ（トークンあたりコスト分析が破綻しないようにする）。
  const totalInputTokens =
    inputTokens + (extraLlmUsages?.reduce((s, e) => s + e.inputTokens, 0) ?? 0);
  const totalOutputTokens =
    outputTokens + (extraLlmUsages?.reduce((s, e) => s + e.outputTokens, 0) ?? 0);

  // プラン倍率を「利用時点」で確定させる（migration_usage_logs_plan_snapshot.sql）。
  // 確定できなければ null のまま書き、stripeSync 側の従来フォールバックに委ねる。
  let planAtUsage: TenantPlan | null = null;
  try {
    planAtUsage = await _resolvePlanForBilling(tenantId);
  } catch (err) {
    // queryTenantPlanResult は内部で catch するため通常ここには来ないが、
    // 万一落ちても利用記録そのものは残す（記録が消える方が損害が大きい）。
    _logger?.warn({ err, requestId }, '[usageTracker] plan resolution failed, storing NULL plan');
  }
  const planMultiplierAtUsage = planAtUsage === null ? null : planMultiplier(planAtUsage);

  try {
    await _pool.query(
      // ★不変条件★ request_id は UNIQUE + ON CONFLICT DO NOTHING の冪等キーとして
      // 課金計上を左右する。ここに渡す requestId は必ず「サーバ生成の値」であること
      // （HTTP経路は request-id.ts が req.requestId をサーバ新規採番する。
      // 再実行dedupが要る内部経路は book-structurize:${bookId} 等の決定的キーを渡す）。
      // クライアント制御ヘッダ(X-Request-ID)を再利用した固定IDを渡すと、2回目以降が
      // ON CONFLICT で握り潰され計上・請求から黙って消える（[P0] 課金回避）。
      // 新しい列は末尾に足す（billable / plan / plan_multiplier と同じ流儀）。
      // 途中に差し込むと以降の $n が全てずれ、位置で検証している既存テストが
      // 一斉に嘘の値を見に行くことになる。
      `INSERT INTO usage_logs
         (tenant_id, request_id, model, input_tokens, output_tokens,
          feature_used, cost_llm_cents, cost_total_cents,
          tts_text_bytes, avatar_credits, avatar_session_ms, anam_session_seconds, billable,
          plan, plan_multiplier, session_id, cost_base_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (request_id) DO NOTHING`,
      [tenantId, requestId, model, totalInputTokens, totalOutputTokens,
       featureUsed, costLlmCents, costTotalCents,
       ttsTextBytes ?? null, avatarCredits ?? null, avatarSessionMs ?? null,
       anam_session_seconds ?? null, isBillable,
       planAtUsage, planMultiplierAtUsage, sessionId ?? null, costBaseCents]
    );
    _logger?.debug(
      { tenantId, requestId, costLlmCents, costTotalCents, billable: isBillable },
      '[usageTracker] logged'
    );
  } catch (err) {
    // migration_usage_logs_plan_snapshot.sql / migration_usage_logs_session_id.sql が
    // 未適用だと 42703(undefined_column) で
    // 全リクエストの INSERT が落ち、利用記録も請求も無言で止まる。
    // この事故はこのリポジトリで既に2回起きている（chat_sessions.visitor_id ほか）ため、
    // 旧カラム構成へ1回だけフォールバックして記録の消失だけは防ぐ。
    // 倍率の焼き付けも会話の紐付けも効かない（= 遡及請求の穴とリクエスト単位請求が残る）ので
    // error で鳴らす。
    if ((err as { code?: string })?.code === '42703') {
      _logger?.error(
        { err, requestId, tenantId },
        '[usageTracker] usage_logs に plan/plan_multiplier/session_id/cost_base_cents のいずれかの列が無い — ' +
        'migration_usage_logs_plan_snapshot.sql / migration_usage_logs_session_id.sql / ' +
        'migration_usage_logs_cost_base.sql のいずれかが未適用。' +
        '旧カラムで記録を継続するが、プラン倍率は焼き付けられず請求が遡及し、' +
        '会話単位の請求も効かない状態のまま。至急 migration を適用すること'
      );
      try {
        await _pool.query(
          `INSERT INTO usage_logs
             (tenant_id, request_id, model, input_tokens, output_tokens,
              feature_used, cost_llm_cents, cost_total_cents,
              tts_text_bytes, avatar_credits, avatar_session_ms, anam_session_seconds, billable)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (request_id) DO NOTHING`,
          [tenantId, requestId, model, totalInputTokens, totalOutputTokens,
           featureUsed, costLlmCents, costTotalCents,
           ttsTextBytes ?? null, avatarCredits ?? null, avatarSessionMs ?? null,
           anam_session_seconds ?? null, isBillable]
        );
      } catch (fallbackErr) {
        _logger?.error({ err: fallbackErr, requestId, tenantId }, '[usageTracker] fallback insert failed');
      }
      return;
    }
    // DB エラーはログするが API レスポンスには影響させない
    _logger?.error({ err, requestId, tenantId }, '[usageTracker] db insert failed');
  }
}
