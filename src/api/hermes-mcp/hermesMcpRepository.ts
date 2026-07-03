// src/api/hermes-mcp/hermesMcpRepository.ts
// Phase75: Hermes Agent(CVR学習エージェント)向けMCPデータアクセス層
//
// 重要: ここで返すデータは同意済みテナントのみを対象にすること。
// 同意チェック自体はこのファイルでは行わない(呼び出し側 routes.ts の責務)。
// このファイルは「同意済みと確認された tenantId」を渡された前提で動く。

import { getPool } from "../../lib/db";

export interface HermesConversationMessage {
  sessionId: string; // chat_sessions.session_id (アプリ側の文字列ID)
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  judgeScore: number | null;
  converted: boolean;
}

export interface SearchConversationsParams {
  tenantId: string;
  query?: string;
  minJudgeScore?: number;
  convertedOnly?: boolean;
  limit?: number;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * 同意済みテナントの会話メッセージを検索する。
 * - minJudgeScore: conversation_evaluations.score(TEXTのsession_idで結合) >= 指定値のセッションのみ
 * - convertedOnly: conversion_attributions(UUIDのsession_idで結合)に紐づくセッションのみ
 * - query: content の ILIKE 部分一致
 */
export async function searchConversations(
  params: SearchConversationsParams,
): Promise<HermesConversationMessage[]> {
  const pool = getPool();
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const conditions: string[] = [`s.tenant_id = $1`];
  const args: unknown[] = [params.tenantId];

  if (params.query?.trim()) {
    args.push(`%${params.query.trim()}%`);
    conditions.push(`m.content ILIKE $${args.length}`);
  }

  if (params.minJudgeScore !== undefined) {
    args.push(params.minJudgeScore);
    conditions.push(
      `EXISTS (SELECT 1 FROM conversation_evaluations ce WHERE ce.session_id = s.session_id AND ce.score >= $${args.length})`,
    );
  }

  if (params.convertedOnly) {
    conditions.push(
      `EXISTS (SELECT 1 FROM conversion_attributions ca WHERE ca.session_id = s.id)`,
    );
  }

  args.push(limit);
  const limitPlaceholder = `$${args.length}`;

  const result = await pool.query<{
    session_id: string;
    role: "user" | "assistant";
    content: string;
    created_at: string;
    judge_score: number | null;
    converted: boolean;
  }>(
    `SELECT
       s.session_id,
       m.role,
       m.content,
       m.created_at,
       (SELECT MAX(ce.score) FROM conversation_evaluations ce WHERE ce.session_id = s.session_id) AS judge_score,
       EXISTS (SELECT 1 FROM conversion_attributions ca WHERE ca.session_id = s.id) AS converted
     FROM chat_messages m
     JOIN chat_sessions s ON s.id = m.session_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY m.created_at DESC
     LIMIT ${limitPlaceholder}`,
    args,
  );

  return result.rows.map((row) => ({
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    judgeScore: row.judge_score !== null ? Number(row.judge_score) : null,
    converted: row.converted,
  }));
}
