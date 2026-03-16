import { Client as ES } from "@elastic/elasticsearch";
// eslint-disable-next-line @typescript-eslint/no-var-requires
// @ts-ignore - pg has no bundled types in this project, treat as any
const { Pool } = require("pg") as { Pool: any };
import { decryptText } from "../lib/crypto/textEncrypt";

// Phase33 C: 言語別インデックス解決
import { toSupportedLang, resolveFallbackIndices, DEFAULT_LANG, type SupportedLang } from "./langIndex";

export interface Hit {
  id: string;
  text: string;
  score: number;
  source: "es" | "pg";
}
const BUDGET = Number(process.env.HYBRID_TIMEOUT_MS || 600);
const ALLOW_MOCK = process.env.HYBRID_MOCK_ON_FAILURE === "1";
// Phase33 C: フィーチャーフラグ（LANG_SEARCH_ENABLED=1 で有効化）
const LANG_SEARCH_ENABLED = process.env.LANG_SEARCH_ENABLED === "1";
const pgUrl = process.env.DATABASE_URL;
const pg = pgUrl ? new Pool({ connectionString: pgUrl }) : null;

const normZ = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length);
  const s = Math.sqrt(v || 1);
  return (x: number) => (x - m) / (s || 1);
};

export async function hybridSearch(
  q: string,
  tenantId?: string,
  lang?: unknown // Phase33 C: SupportedLang に変換（不正値は DEFAULT_LANG）
) {
  const t0 = Date.now();
  const notes: string[] = [];

  // Phase33 C: 言語別インデックス解決
  const resolvedLang: SupportedLang = LANG_SEARCH_ENABLED
    ? toSupportedLang(lang ?? DEFAULT_LANG)
    : DEFAULT_LANG;

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

  if (!es) {
    // デバッグ用: 実際にこのコードが使われているかを判別するための一時的な note
    const baseNote = `es:null-debug-v2 esUrl=${
      esUrl || "undefined"
    } ALLOW_MOCK=${String(ALLOW_MOCK)}`;

    if (ALLOW_MOCK) {
      return {
        items: [
          {
            id: "mock-es",
            text: `ES mock for: ${q}`,
            score: 1.0,
            source: "es" as const,
          },
          {
            id: "mock-pg",
            text: `PG mock for: ${q}`,
            score: 0.8,
            source: "pg" as const,
          },
        ],
        ms: Date.now() - t0,
        note: baseNote + " | mock-used",
      };
    }

    return {
      items: [],
      ms: Date.now() - t0,
      note: baseNote,
    };
  }

  let esElapsedMs: number | undefined;
  let esHits: Hit[] = [];
  let pgHits: Hit[] = [];
  try {
    const tEs0 = Date.now();

    // Phase33 C: 言語別インデックスにフォールバック付きで検索
    const esIndices = LANG_SEARCH_ENABLED && tenantId
      ? resolveFallbackIndices(tenantId, resolvedLang)
      : [`faq_${tenantId ?? "demo"}`];
    const esIndex = esIndices[0]; // まずプライマリを試す

    const esRes: any = await es.search(
      {
        index: esIndex,
        size: 50,
        query: tenantId
          ? {
              bool: {
                must: { multi_match: { query: q, fields: ["question", "answer", "text"] } },
                filter: {
                  bool: {
                    should: [
                      { term: { tenant_id: tenantId } },
                      { term: { tenant_id: "global" } },
                    ],
                    minimum_should_match: 1,
                  },
                },
              },
            }
          : { multi_match: { query: q, fields: ["question", "answer", "text"] } },
      },
      { requestTimeout: BUDGET }
    );
    const tEs1 = Date.now();
    esElapsedMs = tEs1 - tEs0;
    esHits = (esRes.hits?.hits || []).map((h: any) => ({
      id: h._id,
      text: decryptText(h._source?.text ?? ""),
      score: h._score,
      source: "es" as const,
    }));
  } catch (e: any) {
    const esErrCode = (e as any)?.meta?.statusCode ?? (e as any)?.statusCode;
    notes.push(`es_error:${e.message || String(e)}`);

    // Phase33 C: 言語別インデックスが存在しない場合（404）、旧インデックスにフォールバック
    if (LANG_SEARCH_ENABLED && esErrCode === 404 && tenantId) {
      const fallbackIndex = `faq_${tenantId}`;
      try {
        const fbRes: any = await es.search(
          {
            index: fallbackIndex,
            size: 50,
            query: {
              bool: {
                must: { multi_match: { query: q, fields: ["question", "answer", "text"] } },
                filter: { term: { tenant_id: tenantId } },
              },
            },
          },
          { requestTimeout: BUDGET }
        );
        esHits = (fbRes.hits?.hits || []).map((h: any) => ({
          id: h._id,
          text: decryptText(h._source?.text ?? ""),
          score: h._score,
          source: "es" as const,
        }));
        if (esHits.length > 0) {
          notes.push(`es_lang_fallback:${fallbackIndex} hits=${esHits.length}`);
        }
      } catch (fbErr: any) {
        notes.push(`es_fallback_error:${fbErr.message || String(fbErr)}`);
      }
    }
  }

  // PG text search
  // Phase7: pgvector 経路に一本化したため、ここでの FTS（docs テーブル）は無効化。
  // pgHits は空のままにし、必要な場合は searchPgVector を利用する。
  if (pg) {
    notes.push("pg_fts:disabled_phase7_use_pgvector");
  }

  // 念のため、0件なら固定クエリで再試行（投入確認）
  if (esHits.length === 0 && !notes.some((n) => n.startsWith("es_error:"))) {
    try {
      const tProbe0 = Date.now();
      const probe: any = await es.search(
        {
          index: `faq_${tenantId ?? "demo"}`,
          size: 5,
          query: tenantId
            ? {
                bool: {
                  must: { multi_match: { query: "返品 送料", fields: ["question", "answer", "text"] } },
                  filter: {
                    bool: {
                      should: [
                        { term: { tenant_id: tenantId } },
                        { term: { tenant_id: "global" } },
                      ],
                      minimum_should_match: 1,
                    },
                  },
                },
              }
            : { multi_match: { query: "返品 送料", fields: ["question", "answer", "text"] } },
        },
        { requestTimeout: BUDGET }
      );
      const tProbe1 = Date.now();
      const probeMs = tProbe1 - tProbe0;
      notes.push(`probe_ms=${probeMs}`);
      const probeHits = (probe.hits?.hits || []).map((h: any) => ({
        id: h._id,
        text: decryptText(h._source?.text ?? ""),
        score: h._score,
        source: "es" as const,
      }));
      if (probeHits.length > 0) {
        esHits = probeHits;
        notes.push("probe:fallback_query_used");
      } else {
        notes.push("probe:no_hits");
      }
    } catch (e: any) {
      notes.push(`probe_error:${e.message || String(e)}`);
    }
  }

  if (esHits.length + pgHits.length === 0 && ALLOW_MOCK) {
    return {
      items: [
        {
          id: "mock-es",
          text: `ES mock for: ${q}`,
          score: 1.0,
          source: "es" as const,
        },
        {
          id: "mock-pg",
          text: `PG mock for: ${q}`,
          score: 0.8,
          source: "pg" as const,
        },
      ],
      ms: Date.now() - t0,
      note: `fallback (budget=${BUDGET}ms) | ` + notes.join(" | "),
    };
  }

  // z-scoreで正規化（将来PG経路とマージする前提のままにしておく）
  const zES = normZ(esHits.map((h) => h.score));
  const zPG = normZ(pgHits.map((h) => h.score));
  const merged = [
    ...esHits.map((h) => ({ ...h, z: zES(h.score) })),
    ...pgHits.map((h) => ({ ...h, z: zPG(h.score) })),
  ]
    .sort((a, b) => b.z - a.z)
    .filter((h, i, self) => self.findIndex((x) => x.id === h.id) === i)
    .slice(0, 80)
    .map(({ z, ...rest }) => rest);

  const elapsed = Date.now() - t0;
  const metricsNote = [
    `search_ms=${elapsed}`,
    `es_ms=${esElapsedMs ?? "na"}`,
    `es_hits=${esHits.length}`,
    `pg_hits=${pgHits.length}`,
    LANG_SEARCH_ENABLED ? `lang=${resolvedLang}` : null,
  ].filter(Boolean).join(" ");

  const noteJoined = [notes.join(" | "), metricsNote]
    .filter(Boolean)
    .join(" | ");

  return { items: merged, ms: elapsed, note: noteJoined || undefined };
}
