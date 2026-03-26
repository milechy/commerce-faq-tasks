// src/search/langRouter.ts
// Phase33 C: 検索時の言語ルーティング
//
// hybridSearch に lang パラメータを渡すためのラッパー。
// ESインデックスをクエリ言語に応じて切り替え、
// pgvector 検索も lang でフィルタする。

import { Client as ES } from "@elastic/elasticsearch";
import { pool as pg } from "../lib/db";

import {
  SupportedLang,
  DEFAULT_LANG,
  toSupportedLang,
  resolveFallbackIndices,
} from "./langIndex";

export type { SupportedLang };

const BUDGET = Number(process.env.HYBRID_TIMEOUT_MS || 600);

export interface LangRouterHit {
  id: string;
  text: string;
  score: number;
  source: "es" | "pgvector";
  lang: SupportedLang;
}

export interface LangRouterResult {
  items: LangRouterHit[];
  ms: number;
  lang: SupportedLang;
  note?: string;
}

export interface LangRouterParams {
  query: string;
  tenantId: string;
  lang?: unknown; // SupportedLang に変換する（不正値は DEFAULT_LANG）
  embedding?: number[]; // pgvector 検索用
  topK?: number;
}

function buildEsQuery(q: string, tenantId: string, lang: SupportedLang) {
  return {
    bool: {
      must: { multi_match: { query: q, fields: ["question", "answer", "text"] } },
      filter: [
        { term: { tenant_id: tenantId } },
        { term: { lang } },
      ],
    },
  };
}

function buildEsFallbackQuery(q: string, tenantId: string) {
  return {
    bool: {
      must: { multi_match: { query: q, fields: ["question", "answer", "text"] } },
      filter: { term: { tenant_id: tenantId } },
    },
  };
}

/**
 * 言語別ハイブリッド検索のメインエントリポイント。
 *
 * 動作:
 * 1. lang パラメータから SupportedLang を解決（不正値は DEFAULT_LANG）
 * 2. ES検索: faq_{tenantId}_{lang} インデックスをプライマリとし、
 *    ヒットなければ faq_{tenantId}（旧形式）にフォールバック
 * 3. pgvector検索: WHERE lang = $lang でフィルタ
 * 4. 両結果をマージして返す
 */
export async function langRouterSearch(
  params: LangRouterParams
): Promise<LangRouterResult> {
  const t0 = Date.now();
  const { query: q, tenantId, embedding, topK = 20 } = params;
  const lang = toSupportedLang(params.lang);
  const notes: string[] = [];

  const esUrl = process.env.ES_URL;
  const es = esUrl
    ? new ES({
        node: esUrl,
        headers: {
          accept: "application/vnd.elasticsearch+json; compatible-with=8",
          "content-type":
            "application/vnd.elasticsearch+json; compatible-with=8",
        },
      })
    : null;

  // --- ES 検索 ---
  let esHits: LangRouterHit[] = [];

  if (es) {
    const indices = resolveFallbackIndices(tenantId, lang);
    let hitFromFallback = false;

    for (const index of indices) {
      try {
        const isLangIndex = index === `faq_${tenantId}_${lang}`;
        const esQuery = isLangIndex
          ? buildEsQuery(q, tenantId, lang)
          : buildEsFallbackQuery(q, tenantId);

        const esRes: any = await es.search(
          { index, size: topK * 2, query: esQuery },
          { requestTimeout: BUDGET }
        );

        const hits = (esRes.hits?.hits || []).map((h: any) => ({
          id: h._id as string,
          text: h._source?.text as string,
          score: h._score as number,
          source: "es" as const,
          lang,
        }));

        if (hits.length > 0) {
          esHits = hits;
          if (!isLangIndex) {
            hitFromFallback = true;
            notes.push(`es:fallback_index=${index}`);
          } else {
            notes.push(`es:lang_index=${index} hits=${hits.length}`);
          }
          break;
        }
      } catch (e: any) {
        // インデックスが存在しない場合も含めてスキップし次のフォールバックへ
        const code = e?.meta?.statusCode ?? e?.statusCode;
        if (code === 404) {
          notes.push(`es:index_not_found=${index}`);
        } else {
          notes.push(`es:error=${e.message || String(e)}`);
        }
      }
    }

    if (!hitFromFallback && esHits.length === 0) {
      notes.push("es:no_hits");
    }
  } else {
    notes.push("es:not_configured");
  }

  // --- pgvector 検索（lang フィルタ付き）---
  let pgHits: LangRouterHit[] = [];

  if (pg && embedding && embedding.length > 0) {
    try {
      const embedLiteral = `[${embedding.join(",")}]`;

      // lang カラムが存在する場合はフィルタ、存在しない場合は全件検索（後方互換）
      const sql = `
        SELECT
          id::text AS id,
          text,
          COALESCE(lang, $3) AS lang,
          1 - (embedding <-> $1::vector) AS score
        FROM faq_embeddings
        WHERE tenant_id = $2
          AND (lang = $3 OR lang IS NULL)
        ORDER BY embedding <-> $1::vector
        LIMIT $4;
      `;

      const res = await pg.query(sql, [embedLiteral, tenantId, lang, topK]);
      pgHits = (res.rows || []).map((row: any) => ({
        id: String(row.id),
        text: row.text as string,
        score: typeof row.score === "number" ? row.score : Number(row.score) || 0,
        source: "pgvector" as const,
        lang: isSupportedLangValue(row.lang) ? row.lang : lang,
      }));

      notes.push(`pgvector:hits=${pgHits.length}`);
    } catch (e: any) {
      notes.push(`pgvector:error=${e.message || String(e)}`);
    }
  } else if (!embedding || embedding.length === 0) {
    notes.push("pgvector:no_embedding");
  } else {
    notes.push("pgvector:not_configured");
  }

  // --- マージ（重複排除、スコア降順）---
  const merged = [...esHits, ...pgHits]
    .filter((h, i, self) => self.findIndex((x) => x.id === h.id) === i)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return {
    items: merged,
    ms: Date.now() - t0,
    lang,
    note: notes.join(" | ") || undefined,
  };
}

function isSupportedLangValue(v: unknown): v is SupportedLang {
  return v === "ja" || v === "en";
}
