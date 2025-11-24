import { Client as ES } from '@elastic/elasticsearch';
// eslint-disable-next-line @typescript-eslint/no-var-requires
// @ts-ignore - pg has no bundled types in this project, treat as any
const { Pool } = require('pg') as { Pool: any };

export interface Hit { id: string; text: string; score: number; source: 'es'|'pg'; }
const BUDGET = Number(process.env.HYBRID_TIMEOUT_MS || 600);
const ALLOW_MOCK = process.env.HYBRID_MOCK_ON_FAILURE === '1';
const pgUrl = process.env.DATABASE_URL;
const pg = pgUrl ? new Pool({ connectionString: pgUrl }) : null;

const normZ = (xs: number[]) => {
  const m = xs.reduce((a,b)=>a+b,0)/Math.max(1,xs.length);
  const v = xs.reduce((a,b)=>a+(b-m)**2,0)/Math.max(1,xs.length);
  const s = Math.sqrt(v || 1);
  return (x:number)=> (x-m)/(s||1);
};

export async function hybridSearch(q: string, tenantId?: string) {
  const t0 = Date.now();
  const notes: string[] = [];
  void tenantId; // reserved for future multi-tenant filtering

  const esUrl = process.env.ES_URL;
  const es = esUrl
    ? new ES({
        node: esUrl,
        headers: {
          accept: 'application/vnd.elasticsearch+json; compatible-with=8',
          'content-type':
            'application/vnd.elasticsearch+json; compatible-with=8',
        },
      })
    : null;

  if (!es) {
    // デバッグ用: 実際にこのコードが使われているかを判別するための一時的な note
    const baseNote = `es:null-debug-v2 esUrl=${esUrl || 'undefined'} ALLOW_MOCK=${String(
      ALLOW_MOCK,
    )}`;

    if (ALLOW_MOCK) {
      return {
        items: [
          {
            id: 'mock-es',
            text: `ES mock for: ${q}`,
            score: 1.0,
            source: 'es' as const,
          },
          {
            id: 'mock-pg',
            text: `PG mock for: ${q}`,
            score: 0.8,
            source: 'pg' as const,
          },
        ],
        ms: Date.now() - t0,
        note: baseNote + ' | mock-used',
      };
    }

    return {
      items: [],
      ms: Date.now() - t0,
      note: baseNote,
    };
  }

  let esHits: Hit[] = [];
  let pgHits: Hit[] = [];
  try {
    const esRes: any = await es.search({
  index: 'docs',
  size: 50,
  query: { match: { text: q } }
}, { requestTimeout: BUDGET });
    esHits = (esRes.hits?.hits || []).map((h: any) => ({
      id: h._id, text: h._source?.text, score: h._score, source: 'es' as const
    }));
  } catch (e: any) {
    notes.push(`es_error:${e.message || String(e)}`);
  }

  // PG text search
  // Phase7: pgvector 経路に一本化したため、ここでの FTS（docs テーブル）は無効化。
  // pgHits は空のままにし、必要な場合は searchPgVector を利用する。
  if (pg) {
    notes.push('pg_fts:disabled_phase7_use_pgvector');
  }

  // 念のため、0件なら固定クエリで再試行（投入確認）
  if (esHits.length === 0 && !notes.some((n) => n.startsWith('es_error:'))) {
    try {
      const probe: any = await es.search({
  index: 'docs',
  size: 5,
  query: { match: { text: '返品 送料' } }
}, { requestTimeout: BUDGET });
      const probeHits = (probe.hits?.hits || []).map((h: any) => ({
        id: h._id, text: h._source?.text, score: h._score, source: 'es' as const
      }));
      if (probeHits.length > 0) {
        esHits = probeHits;
        notes.push('probe:fallback_query_used');
      } else {
        notes.push('probe:no_hits');
      }
    } catch (e: any) {
      notes.push(`probe_error:${e.message || String(e)}`);
    }
  }

  if ((esHits.length + pgHits.length) === 0 && ALLOW_MOCK) {
    return {
      items: [
        { id: 'mock-es', text: `ES mock for: ${q}`, score: 1.0, source: 'es' as const },
        { id: 'mock-pg', text: `PG mock for: ${q}`, score: 0.8, source: 'pg' as const },
      ],
      ms: Date.now() - t0,
      note: `fallback (budget=${BUDGET}ms) | ` + notes.join(' | ')
    };
  }

  // z-scoreで正規化（将来PG経路とマージする前提のままにしておく）
  const zES = normZ(esHits.map(h=>h.score));
  const zPG = normZ(pgHits.map(h=>h.score));
  const merged = [
    ...esHits.map(h => ({ ...h, z: zES(h.score) })),
    ...pgHits.map(h => ({ ...h, z: zPG(h.score) }))
  ]
  .sort((a,b)=> b.z - a.z)
  .filter((h,i,self)=> self.findIndex(x=> x.id===h.id)===i)
  .slice(0, 80)
  .map(({z, ...rest}) => rest);

  const elapsed = Date.now() - t0;
  const metricsNote = [
    `search_ms=${elapsed}`,
    `es_hits=${esHits.length}`,
    `pg_hits=${pgHits.length}`,
  ].join(' ');

  const noteJoined = [notes.join(' | '), metricsNote].filter(Boolean).join(' | ');

  return { items: merged, ms: elapsed, note: noteJoined || undefined };
}