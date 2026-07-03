// src/api/hermes-mcp/proposalRepository.ts
// Phase74: Hermes Agent — hermes_strategy_proposals テーブルのリポジトリ
//
// 実物のHermes Agent(外部)が投稿するCVR改善提案の永続化・一覧・承認/却下。
// system_prompt等の自動適用は一切行わない(提案→人間承認ゲート)。

import { Pool } from "pg";
import { getPool as _getDefaultPool } from "../../lib/db";

export type HermesProposalScope = "global" | "tenant";
export type HermesProposalStatus = "pending" | "approved" | "rejected";

export interface HermesProposalInput {
  scope: HermesProposalScope;
  /** scope='tenant' のとき必須。scope='global' のときは必ずundefined/null。 */
  tenantId?: string | null;
  title: string;
  rationale: string;
  suggestedAction: string;
  evidence?: Record<string, unknown>;
  dedupKey: string;
  submittedBy?: string;
}

export interface HermesProposal {
  id: string;
  scope: HermesProposalScope;
  tenantId: string | null;
  title: string;
  rationale: string;
  suggestedAction: string;
  evidence: Record<string, unknown>;
  status: HermesProposalStatus;
  dedupKey: string;
  submittedBy: string;
  createdAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
}

export interface ListProposalsParams {
  scope?: HermesProposalScope;
  tenantId?: string;
  status?: HermesProposalStatus;
  limit?: number;
}

function assertScopeInvariant(scope: HermesProposalScope, tenantId?: string | null): void {
  if (scope === "global" && tenantId) {
    throw new Error(
      "hermes proposal invariant violation: scope='global' must not carry tenantId",
    );
  }
  if (scope === "tenant" && !tenantId) {
    throw new Error(
      "hermes proposal invariant violation: scope='tenant' requires tenantId",
    );
  }
}

type ProposalRow = {
  id: string;
  scope: HermesProposalScope;
  tenant_id: string | null;
  title: string;
  rationale: string;
  suggested_action: string;
  evidence: Record<string, unknown> | null;
  status: HermesProposalStatus;
  dedup_key: string;
  submitted_by: string;
  created_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
};

function toProposal(row: ProposalRow): HermesProposal {
  return {
    id: row.id,
    scope: row.scope,
    tenantId: row.tenant_id,
    title: row.title,
    rationale: row.rationale,
    suggestedAction: row.suggested_action,
    evidence: row.evidence ?? {},
    status: row.status,
    dedupKey: row.dedup_key,
    submittedBy: row.submitted_by,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

const SELECT_COLUMNS = `id::text, scope, tenant_id, title, rationale, suggested_action,
                evidence, status, dedup_key, submitted_by, created_at, decided_at, decided_by`;

export function createHermesProposalRepository(pool?: InstanceType<typeof Pool>) {
  function getPool(): InstanceType<typeof Pool> {
    return pool ?? _getDefaultPool();
  }

  return {
    /**
     * 提案を保存する。同一 dedup_key が pending で既存なら何もしない
     * (ON CONFLICT (dedup_key) WHERE status='pending' DO NOTHING = uniq_hermes_proposal_dedup 部分インデックス)。
     * @returns 挿入されたら true、重複でスキップされたら false
     */
    async insertProposal(input: HermesProposalInput): Promise<boolean> {
      assertScopeInvariant(input.scope, input.tenantId);

      const result = await getPool().query(
        `INSERT INTO hermes_strategy_proposals
           (scope, tenant_id, title, rationale, suggested_action, evidence, dedup_key, submitted_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         ON CONFLICT (dedup_key) WHERE status = 'pending' DO NOTHING
         RETURNING id`,
        [
          input.scope,
          input.tenantId ?? null,
          input.title,
          input.rationale,
          input.suggestedAction,
          JSON.stringify(input.evidence ?? {}),
          input.dedupKey,
          input.submittedBy ?? "hermes-agent",
        ],
      );
      return result.rows.length > 0;
    },

    /**
     * dedup_key から最新の提案IDを引く。insertProposal直後に通知メタデータへ
     * proposal_id を含めるためのヘルパー(追加専用、insertProposal自体の返り値は変えない)。
     */
    async findProposalIdByDedupKey(dedupKey: string): Promise<string | null> {
      const result = await getPool().query(
        `SELECT id::text FROM hermes_strategy_proposals
         WHERE dedup_key = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [dedupKey],
      );
      const row = result.rows[0] as { id: string } | undefined;
      return row?.id ?? null;
    },

    /**
     * IDから提案を1件取得する。Admin APIのapprove/rejectが、実行前に
     * scope/tenant_idを見て越境チェックするために使う。
     */
    async getProposalById(id: string): Promise<HermesProposal | null> {
      const result = await getPool().query(
        `SELECT ${SELECT_COLUMNS} FROM hermes_strategy_proposals WHERE id = $1`,
        [id],
      );
      const row = result.rows[0] as ProposalRow | undefined;
      return row ? toProposal(row) : null;
    },

    /**
     * 提案一覧を取得する。scope/tenantId/statusで絞り込み可能。
     * tenantIdを渡した場合、呼び出し側の越境チェック(role != super_admin等)は
     * ルーティング層(Admin API)の責務とする。
     */
    async listProposals(params: ListProposalsParams = {}): Promise<HermesProposal[]> {
      const conditions: string[] = [];
      const values: unknown[] = [];

      if (params.scope) {
        values.push(params.scope);
        conditions.push(`scope = $${values.length}`);
      }
      if (params.tenantId) {
        values.push(params.tenantId);
        conditions.push(`tenant_id = $${values.length}`);
      }
      if (params.status) {
        values.push(params.status);
        conditions.push(`status = $${values.length}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      values.push(params.limit ?? 100);

      const result = await getPool().query(
        `SELECT ${SELECT_COLUMNS}
         FROM hermes_strategy_proposals
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${values.length}`,
        values,
      );

      return (result.rows as ProposalRow[]).map(toProposal);
    },

    /**
     * 提案のステータスを更新する(承認/却下)。管理者の意思決定を記録するのみで、
     * system_prompt等の実適用はしない。
     */
    async updateProposalStatus(
      id: string,
      status: HermesProposalStatus,
      decidedBy: string,
    ): Promise<HermesProposal | null> {
      const result = await getPool().query(
        `UPDATE hermes_strategy_proposals
         SET status = $2, decided_at = NOW(), decided_by = $3
         WHERE id = $1
         RETURNING ${SELECT_COLUMNS}`,
        [id, status, decidedBy],
      );
      const row = result.rows[0] as ProposalRow | undefined;
      return row ? toProposal(row) : null;
    },
  };
}
