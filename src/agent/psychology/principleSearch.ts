// src/agent/psychology/principleSearch.ts
// Phase44: 書籍チャンクからの心理学原則検索
// pgvector faq_embeddings テーブルで metadata.source=book かつ principle 名フィルタ

import { Pool } from 'pg';
import { getPool as _getDefaultPool } from '../../lib/db';

export interface PrincipleChunk {
  principle: string;
  situation: string;    // slice(0, 200) 適用済み
  example: string;      // slice(0, 200) 適用済み
  contraindication: string; // slice(0, 200) 適用済み
}

function getPool(db?: InstanceType<typeof Pool>): InstanceType<typeof Pool> {
  return db ?? _getDefaultPool();
}

/**
 * pgvector の faq_embeddings テーブルから心理学原則チャンクを取得する。
 * metadata.source = 'book' かつ metadata.principle が principles 配列に含まれるレコードを検索。
 * 各テキストフィールドに ragExcerpt.slice(0, 200) を適用（書籍内容漏洩防止）。
 */
export async function searchPrincipleChunks(
  tenantId: string,
  principles: string[],
  db?: InstanceType<typeof Pool>,
): Promise<PrincipleChunk[]> {
  if (!principles || principles.length === 0) {
    return [];
  }

  const pool = getPool(db);

  try {
    interface RawRow {
      principle: string | null;
      situation: string | null;
      example: string | null;
      contraindication: string | null;
    }

    const result = await pool.query<RawRow>(
      `SELECT
        metadata->>'principle' as principle,
        metadata->>'situation' as situation,
        metadata->>'example' as example,
        metadata->>'contraindication' as contraindication
       FROM faq_embeddings
       WHERE tenant_id = $1
         AND metadata->>'source' = 'book'
         AND metadata->>'principle' = ANY($2)
       LIMIT 3`,
      [tenantId, principles],
    );

    return result.rows.map((row: RawRow) => ({
      // ragExcerpt.slice(0, 200) ルール遵守: 全フィールドに適用
      principle: (row.principle ?? "").slice(0, 200),
      situation: (row.situation ?? "").slice(0, 200),
      example: (row.example ?? "").slice(0, 200),
      contraindication: (row.contraindication ?? "").slice(0, 200),
    }));
  } catch {
    // DBエラー時は空配列を返す（書籍内容をログに出力しない）
    return [];
  }
}
