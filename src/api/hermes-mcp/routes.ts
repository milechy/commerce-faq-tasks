// src/api/hermes-mcp/routes.ts
// Phase75: Hermes Agent(CVR学習エージェント)向けMCPデータエンドポイント
//
// GET /v1/hermes-mcp/tenants        — 同意済みテナントID一覧
// GET /v1/hermes-mcp/conversations  — 会話メッセージ検索(同意済みテナントのみ)
//
// 認証: Bearer HERMES_MCP_API_KEY(hermesMcpAuthMiddleware、定数時間比較)。
// 呼び出し元は Hermes Agent VPS(135.181.194.34)上の stdio MCP サーバーラッパー。
//
// 設計上の要: 同意チェックは他の何よりも先に行う。tenant_id が
// listHermesConsentingTenantIds() に含まれない限り、絶対にデータへ到達させない。

import type { Express, Request, Response } from "express";
import { hermesMcpAuthMiddleware } from "./hermesMcpAuth";
import {
  isHermesDataConsentGranted,
  listHermesConsentingTenantIds,
  shareConsentSqlPredicate,
} from "../../lib/hermesConsent";
import { searchConversations } from "./hermesMcpRepository";
import { getRuleEffect } from "../admin/analytics/ruleEffect";
import { getPool } from "../../lib/db";
import { createNotification } from "../../lib/notifications";
import { logger } from "../../lib/logger";
import { periodToJstRangeIso } from "../../lib/billing/tenantEconomics";
import { computeExpectedBilling } from "../../lib/billing/stripeSync";
import { computeUpsellSignals, isValidUpsellSignal } from "../../lib/billing/upsellSignals";
import { PLAN_LADDER } from "../../lib/billing/planPricing";

const MAX_QUERY_LEN = 200;
const MAX_TEXT_LEN = 2000;

// GET /proposals のページング。既存 GET /conversations の作法(hermesMcpRepository.ts の
// MAX_LIMIT/DEFAULT_LIMIT)に合わせる。
const PROPOSALS_MAX_LIMIT = 200;
const PROPOSALS_DEFAULT_LIMIT = 50;

// GET /proposals で「効果を計算する」提案数の上限。
// getRuleEffect(ruleEffect.ts) は1回の呼び出しで最大 CANDIDATE_SESSION_LIMIT(5000)
// セッションを before/after 双方から読み、各セッションごとに
// conversation_evaluations/chat_messages/conversion_attributions への相関サブクエリを
// 実行する重いDiD集計。status='active' の全件(PROPOSALS_MAX_LIMIT=200まで)に
// 無制限に適用すると、Hermesが毎晩無人cronから叩く1リクエストが最悪
// 200件 × 5000セッションぶんの本番DB走査になり、誰も見ていない時間帯に
// 本番DBを殴る形になる。
// 現状Hermesのactive提案数は一桁見込みで、DEFAULT_LIMIT=50の1ページ全件に
// effectを付けるのが自然かも検討したが、「今は少数」を前提に上限を作らないと
// 増えた時に気づける場所が無いままになるため、明示的にキャップする。
// 10件なら現実的な当面の件数を十分にカバーしつつ、想定外に承認済み提案が
// 積み上がった場合でも1リクエストあたり最大 10 × 5000セッションに頭打ちできる。
const PROPOSALS_EFFECT_LIMIT = 10;

// 「effectが未計算(上限超過でスキップ)」であることを示すマーカー。
// pending/rejected の effect: null (=効果測定の対象外) と区別するために使う。
// 両方 null にすると Hermes が「効果ゼロ」と誤読しうるため、意図的に別の形にする。
interface ProposalEffectNotComputed {
  status: "not_computed";
  // upsell_not_measurable: D8-2 の営業提案は承認しても is_active が立たず
  // 本番プロンプトに入らないため、before/after の DiD が原理的に成立しない。
  // 「効果ゼロ」ではなく「測れない」ことを Hermes に伝える。
  reason: "effect_limit_exceeded" | "upsell_not_measurable";
}

type HermesProposalScope = "global" | "tenant";
const VALID_PROPOSAL_SCOPES: readonly HermesProposalScope[] = ["global", "tenant"];

// D8-2: 提案の種別。省略時は従来どおり behavior(応答方針)。
type HermesProposalType = "behavior" | "upsell";
const VALID_PROPOSAL_TYPES: readonly HermesProposalType[] = ["behavior", "upsell"];

export function registerHermesMcpRoutes(app: Express): void {
  app.use("/v1/hermes-mcp", hermesMcpAuthMiddleware);

  // ----------------------------------------------------------------
  // GET /v1/hermes-mcp/tenants
  // ----------------------------------------------------------------
  app.get("/v1/hermes-mcp/tenants", async (_req: Request, res: Response) => {
    try {
      const tenantIds = await listHermesConsentingTenantIds();
      return res.json({ tenantIds });
    } catch (err) {
      logger.warn({ err }, "[hermes-mcp] list tenants failed");
      return res.status(500).json({ error: "internal_error" });
    }
  });

  // ----------------------------------------------------------------
  // GET /v1/hermes-mcp/conversations
  // ----------------------------------------------------------------
  app.get("/v1/hermes-mcp/conversations", async (req: Request, res: Response) => {
    const tenantId = req.query["tenant_id"];
    if (!tenantId || typeof tenantId !== "string") {
      return res.status(400).json({ error: "tenant_id required" });
    }

    // 同意チェックを最優先で実行(他の何よりも先)。
    // 未同意テナントには、存在確認すら与えないよう 403 で統一する。
    const consented = await isHermesDataConsentGranted(tenantId);
    if (!consented) {
      return res.status(403).json({ error: "tenant_not_consented" });
    }

    const rawQuery = req.query["query"];
    const query =
      typeof rawQuery === "string" && rawQuery.trim().length > 0
        ? rawQuery.slice(0, MAX_QUERY_LEN)
        : undefined;

    const rawMinScore = req.query["min_judge_score"];
    let minJudgeScore: number | undefined;
    if (typeof rawMinScore === "string" && rawMinScore.trim() !== "") {
      const parsed = Number(rawMinScore);
      if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
        return res.status(400).json({ error: "invalid_min_judge_score" });
      }
      minJudgeScore = parsed;
    }

    const convertedOnly = req.query["converted_only"] === "true";

    const rawLimit = req.query["limit"];
    let limit: number | undefined;
    if (typeof rawLimit === "string" && rawLimit.trim() !== "") {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 200) {
        return res.status(400).json({ error: "invalid_limit" });
      }
      limit = parsed;
    }

    try {
      const conversations = await searchConversations({
        tenantId,
        query,
        minJudgeScore,
        convertedOnly,
        limit,
      });
      return res.json({ conversations });
    } catch (err) {
      logger.warn({ err }, "[hermes-mcp] search conversations failed");
      return res.status(500).json({ error: "internal_error" });
    }
  });

  // ----------------------------------------------------------------
  // POST /v1/hermes-mcp/proposals
  // Hermes Agent(外部)がCVR改善提案を投稿するためのエンドポイント。
  // system_prompt等は一切自動書き換えしない(提案→人間承認ゲート)。
  // ----------------------------------------------------------------
  // ----------------------------------------------------------------
  // GET /v1/hermes-mcp/tenant-economics
  //
  // ★このレスポンスに金額を1つも載せない★
  // 返すのは数量・率・enum だけで、*_jpy / *_cents / margin / cost / profit という
  // キーは存在しない。Hermes は外部VPSのLLMエージェントであり、その出力は
  // テナントにも届く。渡さなければ漏れる経路が物理的に存在しない
  // (src/api/admin/CLAUDE.md「金額・件数を LLM の生成文に通さない」)。
  // 金額は承認後に upsellRenderer が決定的コードでレンダリングする。
  // この不変条件は routes.test.ts が正規表現で固定している。
  // ----------------------------------------------------------------
  app.get("/v1/hermes-mcp/tenant-economics", async (req: Request, res: Response) => {
    const tenantId = req.query["tenant_id"];
    if (!tenantId || typeof tenantId !== "string") {
      return res.status(400).json({ error: "tenant_id required" });
    }

    // 同意チェックを最優先(他の何よりも先)。未同意には存在確認すら与えない。
    const consented = await isHermesDataConsentGranted(tenantId);
    if (!consented) {
      return res.status(403).json({ error: "tenant_not_consented" });
    }

    const rawPeriod = req.query["period"];
    if (typeof rawPeriod !== "string" || !/^\d{4}(0[1-9]|1[0-2])$/.test(rawPeriod)) {
      return res.status(400).json({ error: "invalid_period" });
    }

    try {
      const { from, to } = periodToJstRangeIso(rawPeriod);
      const pool = getPool();
      const planRow = await pool.query<{ plan: string | null }>(
        `SELECT plan FROM tenants WHERE id = $1`,
        [tenantId],
      );
      if (planRow.rows.length === 0) {
        // 未同意と同じく「不存在」に倒す(テナントの存在有無を与えない)。
        return res.status(403).json({ error: "tenant_not_consented" });
      }
      const plan = planRow.rows[0]!.plan ?? null;

      const { textUnits, avatarMinutes } = await computeExpectedBilling(pool, tenantId, from, to, plan);
      const s = computeUpsellSignals({ plan, textUnits, avatarMinutes });

      return res.json({
        tenant_id: tenantId,
        period_yyyymm: rawPeriod,
        period_from: from,
        period_to: to,
        boundary: "jst_calendar_month",
        plan,
        usage: {
          text_conversations: textUnits,
          avatar_minutes: avatarMinutes,
          text_overage: s.overage.textConversations,
          avatar_overage_minutes: s.overage.avatarMinutes,
        },
        // 込み枠の無いプランは null。0% と混同させない。
        utilization_pct: s.utilizationPct,
        next_plan_candidate: s.nextPlanCandidate,
        utilization_pct_on_next_plan: s.utilizationPctOnNextPlan,
        signals: s.signals,
      });
    } catch (err) {
      logger.warn({ err }, "[hermes-mcp] tenant economics failed");
      return res.status(500).json({ error: "internal_error" });
    }
  });

  app.post("/v1/hermes-mcp/proposals", async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const {
      scope, tenant_id, title, rationale, suggested_action, evidence, dedup_key,
      proposal_type, upsell,
    } = body as {
      scope?: unknown;
      tenant_id?: unknown;
      title?: unknown;
      rationale?: unknown;
      suggested_action?: unknown;
      evidence?: unknown;
      dedup_key?: unknown;
      proposal_type?: unknown;
      upsell?: unknown;
    };

    if (typeof scope !== "string" || !VALID_PROPOSAL_SCOPES.includes(scope as HermesProposalScope)) {
      return res.status(400).json({ error: "invalid_scope" });
    }
    if (scope === "tenant" && (typeof tenant_id !== "string" || !tenant_id)) {
      return res.status(400).json({ error: "tenant_id required for scope=tenant" });
    }
    if (scope === "global" && tenant_id !== undefined) {
      return res.status(400).json({ error: "tenant_id must be omitted for scope=global" });
    }
    if (typeof title !== "string" || !title.trim() || title.length > MAX_TEXT_LEN) {
      return res.status(400).json({ error: "invalid_title" });
    }
    if (typeof rationale !== "string" || !rationale.trim() || rationale.length > MAX_TEXT_LEN) {
      return res.status(400).json({ error: "invalid_rationale" });
    }
    if (typeof suggested_action !== "string" || !suggested_action.trim() || suggested_action.length > MAX_TEXT_LEN) {
      return res.status(400).json({ error: "invalid_suggested_action" });
    }
    if (typeof dedup_key !== "string" || !dedup_key.trim()) {
      return res.status(400).json({ error: "invalid_dedup_key" });
    }
    if (evidence !== undefined && (typeof evidence !== "object" || evidence === null || Array.isArray(evidence))) {
      return res.status(400).json({ error: "invalid_evidence" });
    }

    // D8-2: 種別。省略時は従来どおり behavior(既存 Hermes の後方互換)。
    const proposalType: HermesProposalType =
      proposal_type === undefined ? "behavior" : (proposal_type as HermesProposalType);
    if (!VALID_PROPOSAL_TYPES.includes(proposalType)) {
      return res.status(400).json({ error: "invalid_proposal_type" });
    }

    // アップセルは必ず特定テナント宛。global に紛れ込むと全テナントへ営業提案が出る。
    if (proposalType === "upsell" && scope !== "tenant") {
      return res.status(400).json({ error: "upsell_requires_tenant_scope" });
    }

    let upsellPayload: { signal: string; current_plan: string; recommended_plan: string; period_yyyymm: string } | null = null;
    if (proposalType === "upsell") {
      if (typeof upsell !== "object" || upsell === null || Array.isArray(upsell)) {
        return res.status(400).json({ error: "upsell_required" });
      }
      const u = upsell as Record<string, unknown>;
      if (!isValidUpsellSignal(u["signal"])) {
        return res.status(400).json({ error: "invalid_upsell_signal" });
      }
      if (typeof u["current_plan"] !== "string" || !PLAN_LADDER.includes(u["current_plan"])) {
        return res.status(400).json({ error: "invalid_plan" });
      }
      if (typeof u["recommended_plan"] !== "string" || !PLAN_LADDER.includes(u["recommended_plan"])) {
        return res.status(400).json({ error: "invalid_plan" });
      }
      if (typeof u["period_yyyymm"] !== "string" || !/^\d{4}(0[1-9]|1[0-2])$/.test(u["period_yyyymm"])) {
        return res.status(400).json({ error: "invalid_period" });
      }
      upsellPayload = {
        signal: u["signal"] as string,
        current_plan: u["current_plan"] as string,
        recommended_plan: u["recommended_plan"] as string,
        period_yyyymm: u["period_yyyymm"] as string,
      };
    }

    // 同意チェック(defense in depth): search_conversationsは既に同意済みテナントしか
    // 返さないが、Hermes側の実装ミス・改ざんに備えてここでも必ず再検証する。
    if (scope === "tenant") {
      const consented = await isHermesDataConsentGranted(tenant_id as string);
      if (!consented) {
        return res.status(403).json({ error: "tenant_not_consented" });
      }
    }

    // Hermes が古いスナップショットを元に提案してくることがある。
    // 「Starter → Standard」の提案が届いた時点で既に Growth だった、という
    // 誤提案をテナントに見せないよう、現プランと突き合わせて弾く。
    if (upsellPayload) {
      const cur = await getPool().query<{ plan: string | null }>(
        `SELECT plan FROM tenants WHERE id = $1`,
        [tenant_id as string],
      );
      const actualPlan = cur.rows[0]?.plan ?? null;
      if (actualPlan !== upsellPayload.current_plan) {
        return res.status(409).json({
          error: "plan_mismatch",
          // 実プラン名は同意済みテナントにのみ返る情報なので開示してよい。
          actual_plan: actualPlan,
        });
      }
    }

    // R6: 提案の受け皿を1つにする。hermes_strategy_proposals を承認導線として
    // 育てず、Judge提案と同じ tuning_rules に着地させる(source='hermes',
    // is_active=false, status='pending')。承認は既存の
    // approveTuningRule/rejectTuningRule/updateRule(D8で is_active との
    // 整合性を保証済み)がそのまま使える。
    //
    // trigger_pattern には title をそのまま使う。Hermes の title は
    // 「保証期間の即答」のような短い要約であり、matchesTriggerPattern の
    // キーワード一致には必ずしも最適ではない(insertTuningRuleFromSuggestion
    // の是正と同じ既知の限界)。承認者は copilot-preview 等で承認時に
    // trigger_pattern を編集できる。
    //
    // scope='global' は tuning_rules の既存の慣習(tenant_id='global')に
    // 合わせる(getActiveRulesForTenant が tenant_id=$1 OR tenant_id='global'
    // で読む)。
    const tenantIdValue = scope === "tenant" ? (tenant_id as string) : "global";

    // ★upsell の trigger_pattern はサーバが決定的に組み立てる★
    // uniq_tuning_rules_tenant_trigger (tenant_id, trigger_pattern) が効いており、
    // 現行の ON CONFLICT は (tenant_id, dedup_key) しか見ない。アップセルは
    // 「毎月同じ文言を同じテナントへ」が構造的に起きるため、Hermes の title を
    // そのまま使うと dedup_key 違い × trigger_pattern 同じ で 23505 が頻発する。
    // 月とシグナルを含めた決定的なキーにすれば、別月は別行・同月同シグナルは
    // dedup_key 側で弾かれる、と衝突が構造的に起きない。
    //
    // trigger_pattern は本来キーワード一致(matchesTriggerPattern)用の列だが、
    // upsell 行は DB 制約 tuning_rules_upsell_never_active_check により
    // is_active=true になれず、getActiveRulesForTenant に載らないため
    // マッチング経路に到達しない。Hermes の title は evidence 側に保存する。
    const triggerPattern = upsellPayload
      ? `upsell:${upsellPayload.period_yyyymm}:${upsellPayload.signal}`
      : (title as string);

    const evidenceJson = JSON.stringify({
      ...(evidence as Record<string, unknown> | undefined),
      rationale,
      ...(upsellPayload
        ? {
            // 金額は保存しない。価格改定で保存済みの金額が嘘になるため、
            // 表示のたびに upsellRenderer が単価から組み立てる。
            upsell: upsellPayload,
            hermes_title: title,
          }
        : {}),
    });

    try {
      const pool = getPool();
      const result = await pool.query<{ id: number }>(
        `INSERT INTO tuning_rules
           (tenant_id, trigger_pattern, expected_behavior, priority, is_active,
            source, status, evidence, dedup_key, proposal_type)
         VALUES ($1, $2, $3, 0, false, 'hermes', 'pending', $4::jsonb, $5, $6)
         ON CONFLICT (tenant_id, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [tenantIdValue, triggerPattern, suggested_action, evidenceJson, dedup_key, proposalType],
      );

      const insertedId = result.rows[0]?.id ?? null;
      if (insertedId === null) {
        return res.json({ duplicate: true });
      }

      try {
        await createNotification({
          // ★upsell は投稿時にテナントへ送らない★
          // 未承認の営業提案がテナントに届くのを防ぐ(運営が採否を決めてから、
          // 承認経路側で client_admin へ通知する)。
          // 既存の「scope で宛先を分ける」形からの意図的な逸脱。
          recipientRole:
            proposalType === "upsell" || scope === "global" ? "super_admin" : "client_admin",
          recipientTenantId:
            proposalType !== "upsell" && scope === "tenant" ? (tenant_id as string) : undefined,
          type: "hermes_proposal",
          title,
          message: rationale,
          // R6: 実在するルートのみを指す。Hermes提案は tuning_rules の
          // 承認一覧(AIReportTab / copilot-preview get_tuning_rules)に
          // Judge提案と同じ形で並ぶ。global scope はテナント固有ページが
          // 無いためテナント一覧へ誘導する。
          link: scope === "global" ? "/admin/tenants" : `/admin/tenants/${tenant_id as string}`,
          metadata: { tuning_rule_id: insertedId, dedup_key, scope },
        });
      } catch (err) {
        logger.warn({ err }, "[hermes-mcp] proposal notification failed (non-fatal)");
      }

      return res.status(201).json({ proposal_id: String(insertedId), duplicate: false });
    } catch (err) {
      // uniq_tuning_rules_tenant_trigger (tenant_id, trigger_pattern) との衝突。
      // ON CONFLICT は (tenant_id, dedup_key) しか見ないため、dedup_key が違って
      // trigger_pattern が同じだとここへ落ちる。重複時に成功を装わないよう、
      // 既存の重複表現({duplicate:true})に揃える。
      // ★23505 のときだけ★ — 他の例外まで duplicate に丸めると本当の失敗が消える。
      if ((err as { code?: string })?.code === "23505") {
        return res.json({ duplicate: true });
      }
      logger.warn({ err }, "[hermes-mcp] insert proposal failed");
      return res.status(500).json({ error: "internal_error" });
    }
  });

  // ----------------------------------------------------------------
  // GET /v1/hermes-mcp/proposals
  // Hermesが過去に投稿した自分の提案の判断結果(pending/active/rejected)を
  // 読み戻すための学習ループの口。R6により提案は hermes_strategy_proposals
  // ではなく tuning_rules(source='hermes') に着地しているため、ここでも
  // tuning_rules を読む(受け皿を1つに保つ。第2の永続化経路を作らない)。
  //
  // 越境防止: scope='tenant' の行(tenant_id != 'global')は同意済みテナントの
  // ものだけ返す。同意判定は必ず shareConsentSqlPredicate() を使い、生SQLで
  // 判定ロジックを再実装しない(過去にJSとSQLの判定が食い違いタダ乗りが成立した
  // 経緯があるため。詳細は hermesConsent.ts の shareConsentSqlPredicate 参照)。
  // scope='global' の行(tenant_id='global')は同意済みテナントの会話を横断
  // 分析した結果に基づく(migration_phase74_hermes_strategy_proposals.sql の
  // 設計コメント参照)ため、無条件に返してよい。
  // ----------------------------------------------------------------
  app.get("/v1/hermes-mcp/proposals", async (req: Request, res: Response) => {
    const rawLimit = req.query["limit"];
    let limit = PROPOSALS_DEFAULT_LIMIT;
    if (typeof rawLimit === "string" && rawLimit.trim() !== "") {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > PROPOSALS_MAX_LIMIT) {
        return res.status(400).json({ error: "invalid_limit" });
      }
      limit = parsed;
    }

    try {
      const pool = getPool();
      const result = await pool.query<{
        id: number;
        tenant_id: string;
        trigger_pattern: string;
        status: string;
        dedup_key: string | null;
        approved_at: string | null;
        rejected_at: string | null;
        created_at: string;
        proposal_type: string;
      }>(
        `SELECT id, tenant_id, trigger_pattern, status, dedup_key, approved_at, rejected_at, created_at, proposal_type
           FROM tuning_rules tr
          WHERE tr.source = 'hermes'
            AND (
              tr.tenant_id = 'global'
              OR EXISTS (
                SELECT 1 FROM tenants t
                 WHERE t.id = tr.tenant_id
                   AND ${shareConsentSqlPredicate("t.features")}
              )
            )
          ORDER BY tr.created_at DESC
          LIMIT $1`,
        [limit],
      );

      // 採用後の効果測定: 既存の DiD 効果集計(getRuleEffect、
      // /v1/admin/analytics/rule-effect/:ruleId と同じロジック)を再利用する
      // (実装を2箇所に持たない)。status='active'(承認済み)の提案のみ
      // before/afterのafter区間が存在するため対象にする。
      //
      // PROPOSALS_EFFECT_LIMIT件を超えたら計算をスキップし、代わりに
      // ProposalEffectNotComputed を返す(pending/rejectedのeffect: nullとは
      // 区別できる形にする。上限内であれば直列(Promise.allにしない)で1件ずつ
      // 実行し、無人cronからの呼び出しに対して瞬間的な同時実行数を作らない)。
      const proposals: Array<{
        proposal_id: string;
        scope: HermesProposalScope;
        proposal_type: string;
        tenant_id: string | undefined;
        title: string;
        status: string;
        dedup_key: string | null;
        decided_at: string | null;
        created_at: string;
        effect: Awaited<ReturnType<typeof getRuleEffect>> | ProposalEffectNotComputed | null;
      }> = [];

      let effectComputedCount = 0;
      for (const row of result.rows) {
        const scope: HermesProposalScope = row.tenant_id === "global" ? "global" : "tenant";

        let effect: Awaited<ReturnType<typeof getRuleEffect>> | ProposalEffectNotComputed | null = null;
        if (row.proposal_type === "upsell") {
          // 承認されても本番プロンプトに入らないので after 区間が存在しない。
          // getRuleEffect(最大5000セッション走査)を回すのは完全な無駄。
          effect = { status: "not_computed", reason: "upsell_not_measurable" };
        } else if (row.status === "active") {
          if (effectComputedCount < PROPOSALS_EFFECT_LIMIT) {
            effect = await getRuleEffect(pool, row.id);
            effectComputedCount += 1;
          } else {
            effect = { status: "not_computed", reason: "effect_limit_exceeded" };
          }
        }

        proposals.push({
          proposal_id: String(row.id),
          proposal_type: row.proposal_type,
          scope,
          tenant_id: scope === "tenant" ? row.tenant_id : undefined,
          title: row.trigger_pattern,
          status: row.status,
          dedup_key: row.dedup_key,
          decided_at: row.approved_at ?? row.rejected_at ?? null,
          created_at: row.created_at,
          effect,
        });
      }

      return res.json({ proposals });
    } catch (err) {
      logger.warn({ err }, "[hermes-mcp] list proposals failed");
      return res.status(500).json({ error: "internal_error" });
    }
  });
}
