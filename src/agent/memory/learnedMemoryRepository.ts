// src/agent/memory/learnedMemoryRepository.ts
// Phase71-A: learned_memory テーブルのリポジトリ (save / search)
//
// evaluationRepository.ts のファクトリ + 遅延 pool 解決パターンを踏襲。
// text / answer は faq_embeddings と同様に AES-256-GCM で暗号化して保存する。

import { Pool } from "pg";
import { getPool as _getDefaultPool } from "../../lib/db";
import { encryptText, decryptText } from "../../lib/crypto/textEncrypt";

export interface LearnedMemoryEntry {
  id?: number;
  tenantId: string;
  question: string;
  answer: string;
  embedding: number[];
  sourceSessionId: string;
  judgeScore: number;
  /**
   * GID 1217972798328871 (H-6): memoryDistiller.ts が `promoted_by: "auto" | "manual"` を
   * 必ず入れる (どちらの経路で昇格したかの後追い用)。このリポジトリ層は中身を解釈せず
   * そのまま JSONB へ保存するだけ (第2の判定ロジックを作らない)。
   */
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

/** 検索結果。searchAgent のマージに合わせた形 (id/text/score/metadata)。 */
export interface LearnedMemoryHit {
  id: string;
  /** RAG コンテキストに注入する本文 (= 蒸留された応答)。 */
  text: string;
  score: number;
  source: "learned";
  metadata: Record<string, unknown>;
}

export interface LearnedMemorySearchParams {
  tenantId: string;
  embedding: number[];
  topK?: number;
  /** スコアに掛ける重み (curated FAQ より優先させないため)。 */
  weight?: number;
}

export function createLearnedMemoryRepository(pool?: InstanceType<typeof Pool>) {
  // pool 解決は実 DB 呼び出し時まで遅延 (DATABASE_URL 無しのテスト環境を許容)
  function getPool(): InstanceType<typeof Pool> {
    return pool ?? _getDefaultPool();
  }

  return {
    /**
     * H-11 (GID 1217973238377692): (tenant_id, source_session_id) が既に
     * learned_memory に存在するかどうかだけを調べる。saveLearnedMemory の
     * ON CONFLICT (tenant_id, source_session_id) と同じキーで引く(判定が
     * 2箇所に割れないようにするため)。
     *
     * memoryDistiller.distillAndSave が、Groq蒸留・埋め込み(どちらも外部API課金)を
     * 呼ぶ前の事前チェックとして使う。ON CONFLICT DO NOTHING 自体は競合(同時多重
     * リクエスト)に対する最終防壁として引き続き残す。
     */
    async isSessionAlreadyPromoted(
      tenantId: string,
      sourceSessionId: string,
    ): Promise<boolean> {
      const result = await getPool().query(
        `SELECT 1 FROM learned_memory
         WHERE tenant_id = $1 AND source_session_id = $2
         LIMIT 1`,
        [tenantId, sourceSessionId],
      );
      return result.rows.length > 0;
    },

    /**
     * 蒸留した Q&A を learned_memory に保存する。
     * (tenant_id, source_session_id) が既存なら何もしない (ON CONFLICT DO NOTHING)。
     * @returns 挿入されたら true、重複でスキップされたら false
     */
    async saveLearnedMemory(entry: LearnedMemoryEntry): Promise<boolean> {
      const embeddingLiteral = `[${entry.embedding.join(",")}]`;
      const result = await getPool().query(
        `INSERT INTO learned_memory
           (tenant_id, question, answer, embedding, source_session_id, judge_score, metadata)
         VALUES ($1, $2, $3, $4::vector, $5, $6, $7::jsonb)
         ON CONFLICT (tenant_id, source_session_id) DO NOTHING
         RETURNING id`,
        [
          entry.tenantId,
          encryptText(entry.question),
          encryptText(entry.answer),
          embeddingLiteral,
          entry.sourceSessionId,
          entry.judgeScore,
          JSON.stringify(entry.metadata ?? {}),
        ],
      );
      return result.rows.length > 0;
    },

    /**
     * クエリ埋め込みに近い learned_memory を取得する。
     *
     * - テナント分離: tenant_id = $1 のみ (verbatim 内容は横断共有しない)。
     * - is_active = true のみ。
     * - スコアは faq_embeddings (pgvectorSearch) と同じ正規化式に揃え、
     *   weight を掛けて curated FAQ より優先しないようにする。
     */
    async searchLearnedMemory(
      params: LearnedMemorySearchParams,
    ): Promise<LearnedMemoryHit[]> {
      const { tenantId, embedding, topK = 5, weight = 1 } = params;
      if (!embedding || embedding.length === 0) return [];

      const embeddingLiteral = `[${embedding.join(",")}]`;
      const result = await getPool().query(
        `SELECT
           id::text,
           question,
           answer,
           judge_score,
           source_session_id,
           1 - (embedding <-> $1::vector) / 2 AS score
         FROM learned_memory
         WHERE tenant_id = $2
           AND is_active = true
         ORDER BY embedding <-> $1::vector
         LIMIT $3`,
        [embeddingLiteral, tenantId, topK],
      );

      type Row = {
        id: string;
        question: string | null;
        answer: string | null;
        judge_score: number;
        source_session_id: string;
        score: number;
      };

      return (result.rows as Row[]).map((row) => {
        const rawScore =
          typeof row.score === "number" ? row.score : Number(row.score) || 0;
        const clamped = Math.max(0, Math.min(1, rawScore));
        return {
          id: `learned:${row.id}`,
          text: decryptText(row.answer ?? ""),
          score: clamped * weight,
          source: "learned" as const,
          metadata: {
            source: "learned",
            question: decryptText(row.question ?? ""),
            judge_score: row.judge_score,
            source_session_id: row.source_session_id,
          },
        };
      });
    },
  };
}
