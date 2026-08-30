// src/agent/psychology/principleSearch.ts
// Phase44: 書籍チャンクからの心理学原則検索
// pgvector faq_embeddings テーブルで metadata.source=book かつ principle を持つ行をベクトル検索

import { Pool } from 'pg';
import { getPool as _getDefaultPool } from '../../lib/db';
import { embedText } from '../llm/openaiEmbeddingClient';
import {
  PRINCIPLE_FIELDS,
  buildFieldSelect,
  buildPrincipleWhereClause,
} from './principleSchemaMap';
import { PRINCIPLE_MAX_DISTANCE } from '../config/ragLimits';
// P1: 心理学原則チャンク(source='book' = 'global' 由来)の合流をテナント別オプトインで制御。
import { shouldIncludeGlobalKnowledge } from '../../search/globalKnowledgeFlag';

export interface PrincipleChunk {
  chunkId: number;
  principle: string;
  situation: string;    // slice(0, 200) 適用済み
  example: string;      // slice(0, 200) 適用済み
  contraindication: string; // slice(0, 200) 適用済み
}

/** 1回の検索で返す最大件数。buildPrinciplePrompt も先頭3件しか使わない。 */
const PRINCIPLE_TOP_K = 3;

function getPool(db?: InstanceType<typeof Pool>): InstanceType<typeof Pool> {
  return db ?? _getDefaultPool();
}

/**
 * 直近の会話文から、適用できそうな心理学原則チャンクをベクトル近傍検索で取得する。
 *
 * ★2026-08-29: 原則名の完全一致からベクトル検索へ変更した★
 * 旧実装は `metadata->>'principle' = ANY($2)` で、principleDetector.ts の統制語彙
 * (アンカリング効果/損失回避/社会的証明/希少性/コミットメントと一貫性/フレーミング効果/
 * 返報性 の7語)と完全一致する行だけを引いていた。しかし書籍から実際に抽出される
 * principle は「相手の注意を引くことで受付突破」「権威付け」「適切なタイミング」のような
 * 自由記述で、本番91件のうち統制語彙と一致するものは**1件も無かった**(実測)。
 * 書籍ごとに contentAnalyzer が動的にスキーマを決める設計(.claude/rules/knowledge.md
 * 「書籍だけで2系統ある」参照)である以上、統制語彙との完全一致は構造的に成立しない。
 *
 * ★situation ではなく会話文そのもので引く理由★
 * 「いつ使うか」を表す situation で引くのが素直に見えるが、本番実データでは situation の
 * 大半が「電話での営業」「テレアポ」「営業や電話でのコミュニケーション」と、書籍1冊の
 * テーマの言い換えに収束しており(91件中84種だが意味的にはほぼ同一)、弁別性が無い。
 * 一方 principle は具体的な打ち手を表しており弁別性が高い。埋め込みベクトル自体は
 * 経路1(embedAndStore)が question+answer から作っているため、会話文を投げると
 * 「その場面で使う打ち手」が上位に来る(実測: 「受付で断られてしまいます」→
 * 「相手の注意を引くことで受付突破」が1位)。
 *
 * ★2026-08-29: 書籍スキーマを psychology_book 決め打ちから複数対応へ変更した★
 * 書籍の構造化フィールドは contentAnalyzer.ts が書籍ごとに選ぶため、
 * psychology_book のキー名(principle/situation/...)を SQL に直接埋めると、
 * sales_manual と判定された書籍が丸ごと原則注入から外れる。実際に本番の
 * book_id=6(81件)が全て `principle IS NOT NULL` で落ちていた。
 * 対応表は principleSchemaMap.ts に集約し、SQL はそこから組み立てる。
 *
 * tenant_id は当該テナント または共有の 'global' テナントを対象とする
 * （他RAG経路 pgvector / langRouter / knowledgeSearchUtil と一貫: `tenant_id = $1 OR 'global'`）。
 * 各テキストフィールドに ragExcerpt.slice(0, 200) を適用（書籍内容漏洩防止）。
 *
 * ★2026-08-29: 距離の足切りを追加した★
 * 足切りが無いと無関係な質問でも常に上位 PRINCIPLE_TOP_K 件が注入されていた。
 * 閾値 PRINCIPLE_MAX_DISTANCE の根拠(実測データ)は ragLimits.ts のコメント参照。
 *
 * @param queryText 直近のユーザー発話。空文字なら検索せず空配列を返す。
 */
export async function searchPrincipleChunks(
  tenantId: string,
  queryText: string,
  db?: InstanceType<typeof Pool>,
): Promise<PrincipleChunk[]> {
  const trimmed = (queryText ?? '').trim();
  if (!trimmed) {
    return [];
  }

  const pool = getPool(db);

  try {
    // 原価は可視化するが課金対象にはしない(書籍構造化と同じ扱い。embedAndStore 参照)。
    const embedding = await embedText(trimmed, { tenantId, billable: false });
    if (!embedding || embedding.length === 0) return [];
    const embedLiteral = `[${embedding.join(',')}]`;

    interface RawRow {
      id: number;
      principle: string | null;
      situation: string | null;
      example: string | null;
      contraindication: string | null;
    }

    // SELECT 句・WHERE 句は principleSchemaMap.ts の対応表から機械生成する
    // (スキーマ追加時に SQL を手で書き換えないため)。id は論理フィールドではなく
    // 固定列なので PRINCIPLE_FIELDS には含めない。
    const selectClause = PRINCIPLE_FIELDS.map(buildFieldSelect).join(',\n        ');

    // P1: 共有 'global' 書籍チャンクをこのテナントの回答へ注入してよいかを判定する。
    // 既定(env 未設定)は従来どおり global を含める。opt-in 有効かつ allowlist 外なら
    // 自テナントの book チャンクのみに絞る(= 他社/社内書籍の外部露出を止める)。
    const tenantScope = shouldIncludeGlobalKnowledge(tenantId)
      ? `tenant_id = $1 OR tenant_id = 'global'`
      : `tenant_id = $1`;

    const result = await pool.query<RawRow>(
      `SELECT
        id,
        ${selectClause}
       FROM faq_embeddings
       WHERE (${tenantScope})
         AND metadata->>'source' = 'book'
         AND ${buildPrincipleWhereClause()}
         AND (is_excluded_from_search IS NULL OR is_excluded_from_search = false)
         AND embedding <-> $2::vector <= $4
       ORDER BY embedding <-> $2::vector
       LIMIT $3`,
      [tenantId, embedLiteral, PRINCIPLE_TOP_K, PRINCIPLE_MAX_DISTANCE],
    );

    // ★2026-08-29: id を Number() で正規化してから chunkId に詰める★
    // faq_embeddings.id は bigint(OID 20)。node-postgres は精度落ち防止のため
    // OID 20 を既定で文字列として返す(このリポジトリに setTypeParser(20, ...)
    // によるグローバル上書きは無い。lib/db.ts 参照)。一方 PrincipleChunk.chunkId
    // の型宣言は number。ここで row.id をそのまま代入すると型は number・実行時は
    // string というズレが生じ、searchAgent.ts 側の Set<number> 照合
    // (`principleChunkIds.has(Number(it.id))` / `rerankedChunkIds.has(String(chunk.chunkId))`)
    // が静かに壊れ、通常検索と原則注入の両方でヒットしたチャンクの injected フラグが
    // 常に false のまま記録から消えていた。id は faq_embeddings の主キー(NOT NULL)
    // であり必ず数値文字列として返るため、Number(row.id) が NaN になることは無い。
    // NaN 用の代替値は用意しない(未定義の代替 id を割り当てると別チャンクとの
    // 誤一致を招くため、ここは変換失敗を握りつぶさずそのまま Number() に委ねる)。
    return result.rows.map((row: RawRow) => ({
      chunkId: Number(row.id),
      // ragExcerpt.slice(0, 200) ルール遵守: 全フィールドに適用
      principle: (row.principle ?? "").slice(0, 200),
      situation: (row.situation ?? "").slice(0, 200),
      example: (row.example ?? "").slice(0, 200),
      contraindication: (row.contraindication ?? "").slice(0, 200),
    }));
  } catch {
    // 埋め込み失敗・DBエラー時は空配列を返す（書籍内容をログに出力しない）
    return [];
  }
}
