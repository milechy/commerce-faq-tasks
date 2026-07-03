// src/api/admin/hermes/routes.ts
// Phase74: Hermes Agent — CVR改善提案の管理者向け承認ゲートAPI
//
// GET  /v1/admin/hermes/proposals             — 提案一覧(scope/tenant_id/statusで絞り込み)
// POST /v1/admin/hermes/proposals/:id/approve — 承認(意思決定の記録のみ)
// POST /v1/admin/hermes/proposals/:id/reject  — 却下
//
// 重要: このAPIはどのエンドポイントも system_prompt / system_prompt_variants を
// 自動書き換えしない。承認は「管理者が既存の PUT /v1/admin/variants を手動で叩く」
// 前段の意思決定を記録するだけ(提案→人間承認ゲート)。
//
// 認可: conversion routes (src/api/conversion/conversionRoutes.ts) の
// effectiveness ハンドラの越境チェックパターンを踏襲。
//   - client_admin は scope='tenant' かつ自テナントの提案のみ閲覧・決定可能
//   - scope='global'(同意済みテナント横断の分析)の提案は super_admin のみ閲覧・決定可能

import type { Express, Request, Response } from "express";
import type { Pool } from "pg";
import { supabaseAuthMiddleware } from "../../../admin/http/supabaseAuthMiddleware";
import { roleAuthMiddleware, requireRole } from "../../middleware/roleAuth";
import type { AuthenticatedUser } from "../../middleware/roleAuth";
import {
  createHermesProposalRepository,
  type HermesProposalScope,
  type HermesProposalStatus,
} from "../../hermes-mcp/proposalRepository";

const VALID_SCOPES: readonly HermesProposalScope[] = ["global", "tenant"];
const VALID_STATUSES: readonly HermesProposalStatus[] = ["pending", "approved", "rejected"];

const ADMIN_AUTH = [
  supabaseAuthMiddleware,
  roleAuthMiddleware,
  requireRole("super_admin", "client_admin"),
];

export function registerHermesProposalAdminRoutes(app: Express, db: Pool | null): void {
  app.use("/v1/admin/hermes", ...ADMIN_AUTH);

  const repo = createHermesProposalRepository(db ?? undefined);

  // ----------------------------------------------------------------
  // GET /v1/admin/hermes/proposals
  // ----------------------------------------------------------------
  app.get("/v1/admin/hermes/proposals", async (req: Request, res: Response) => {
    if (!db) return res.status(503).json({ error: "database_unavailable" });

    const user = (req as Request & { user?: AuthenticatedUser }).user;
    if (!user) return res.status(403).json({ error: "forbidden" });

    const queryScope = req.query["scope"] as string | undefined;
    const queryTenantId = req.query["tenant_id"] as string | undefined;
    const queryStatus = req.query["status"] as string | undefined;

    if (queryScope && !VALID_SCOPES.includes(queryScope as HermesProposalScope)) {
      return res.status(400).json({ error: "invalid_scope" });
    }
    if (queryStatus && !VALID_STATUSES.includes(queryStatus as HermesProposalStatus)) {
      return res.status(400).json({ error: "invalid_status" });
    }

    let scope = queryScope as HermesProposalScope | undefined;
    let tenantId = queryTenantId;

    if (user.role === "client_admin") {
      // client_admin は自テナントの tenant スコープ提案のみ閲覧可能
      // (scope='global' は同意済みテナント横断分析のため super_admin 専用)
      if (scope === "global") {
        return res.status(403).json({ error: "forbidden" });
      }
      if (tenantId && tenantId !== user.tenantId) {
        return res.status(403).json({ error: "forbidden" });
      }
      scope = "tenant";
      tenantId = user.tenantId ?? undefined;
    }

    try {
      const proposals = await repo.listProposals({
        scope,
        tenantId,
        status: queryStatus as HermesProposalStatus | undefined,
      });
      return res.json({ proposals });
    } catch {
      return res.status(500).json({ error: "internal_error" });
    }
  });

  // ----------------------------------------------------------------
  // POST /v1/admin/hermes/proposals/:id/approve
  // POST /v1/admin/hermes/proposals/:id/reject
  // ----------------------------------------------------------------
  function makeDecideHandler(status: "approved" | "rejected") {
    return async (req: Request, res: Response) => {
      if (!db) return res.status(503).json({ error: "database_unavailable" });

      const user = (req as Request & { user?: AuthenticatedUser }).user;
      if (!user) return res.status(403).json({ error: "forbidden" });

      const id = req.params["id"] as string;

      try {
        const proposal = await repo.getProposalById(id);
        if (!proposal) return res.status(404).json({ error: "not_found" });

        if (
          user.role === "client_admin" &&
          (proposal.scope !== "tenant" || proposal.tenantId !== user.tenantId)
        ) {
          return res.status(403).json({ error: "forbidden" });
        }

        const decidedBy = user.email || user.tenantId || "unknown";
        const updated = await repo.updateProposalStatus(id, status, decidedBy);
        if (!updated) return res.status(404).json({ error: "not_found" });

        return res.json({ proposal: updated });
      } catch {
        return res.status(500).json({ error: "internal_error" });
      }
    };
  }

  app.post("/v1/admin/hermes/proposals/:id/approve", makeDecideHandler("approved"));
  app.post("/v1/admin/hermes/proposals/:id/reject", makeDecideHandler("rejected"));
}
