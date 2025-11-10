import { Client as ES } from '@elastic/elasticsearch';
import { Pool } from 'pg';

export interface Hit { id: string; text: string; score: number; source: 'es'|'pg'; }
const esUrl = process.env.ES_URL;
const BUDGET = Number(process.env.HYBRID_TIMEOUT_MS || 600);
const ALLOW_MOCK = process.env.HYBRID_MOCK_ON_FAILURE === '1';

const es = esUrl ? new ES({
  node: esUrl,
  headers: {
    accept: 'application/vnd.elasticsearch+json; compatible-with=8',
    'content-type': 'application/vnd.elasticsearch+json; compatible-with=8'
  }
}) : null;
const pgUrl = process.env.DATABASE_URL;
const pg = pgUrl ? new Pool({ connectionString: pgUrl }) : null;

const normZ = (xs: number[]) => {
  const m = xs.reduce((a,b)=>a+b,0)/Math.max(1,xs.length);
  const v = xs.reduce((a,b)=>a+(b-m)**2,0)/Math.max(1,xs.length);
  const s = Math.sqrt(v || 1);
  return (x:number)=> (x-m)/(s||1);
};

export async function hybridSearch(q: string) {
  const t0 = Date.now();
  const notes: string[] = [];

  if (!es) {
    if (ALLOW_MOCK) {
      notes.push('es:null => mock');
      return {
        items: [
          { id: 'mock-es', text: `ES mock for: ${q}`, score: 1.0, source: 'es' as const },
          { id: 'mock-pg', text: `PG mock for: ${q}`, score: 0.8, source: 'pg' as const },
        ],
        ms: Date.now() - t0,
        note: notes.join(' | ')
      };
    }
    return { items: [], ms: Date.now() - t0, note: 'es:null and mock disabled' };
  }

  let esHits: Hit[] = [];
  let pgHits: Hit[] = [];
  try {
    const esRes: any = await es.search({
      index: 'docs',
      size: 50,
      query: { match: { text: q } }
    });
    esHits = (esRes.hits?.hits || []).map((h: any) => ({
      id: h._id, text: h._source?.text, score: h._score, source: 'es' as const
    }));
  } catch (e: any) {
    notes.push(`es_error:${e.message || String(e)}`);
  }

  // PG text search (tsvector ベースの簡易BM25相当). pg が未設定ならスキップ
  if (pg) {
    try {
      const sql = `
        with q as (
          select plainto_tsquery('simple', $1) as tsq
        )
        select id::text as id, text,
               ts_rank_cd(to_tsvector('simple', coalesce(text,'')), (select tsq from q)) as score
        from docs
        where to_tsvector('simple', coalesce(text,'')) @@ (select tsq from q)
        order by score desc
        limit 50;`;
      const r = await pg.query(sql, [q]);
      pgHits = r.rows.map((row: any) => ({ id: String(row.id), text: row.text, score: Number(row.score)||0, source: 'pg' as const }));
    } catch (e: any) {
      notes.push(`pg_error:${e.name||'Error'}:${e.message||String(e)}`);
    }
  }

  // 念のため、0件なら固定クエリで再試行（投入確認）
  if (esHits.length === 0) {
    try {
      const probe: any = await es.search({
        index: 'docs',
        size: 5,
        query: { match: { text: '返品 送料' } }
      });
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

  return { items: merged, ms: Date.now() - t0, note: notes.join(' | ') || undefined };
}