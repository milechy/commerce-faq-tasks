"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.hybridSearch = hybridSearch;
const elasticsearch_1 = require("@elastic/elasticsearch");
const esUrl = process.env.ES_URL;
const BUDGET = Number(process.env.HYBRID_TIMEOUT_MS || 600);
const ALLOW_MOCK = process.env.HYBRID_MOCK_ON_FAILURE === '1';
const es = esUrl ? new elasticsearch_1.Client({
    node: esUrl,
    headers: {
        accept: 'application/vnd.elasticsearch+json; compatible-with=8',
        'content-type': 'application/vnd.elasticsearch+json; compatible-with=8'
    }
}) : null;
// const pg = undefined;
const normZ = (xs) => {
    const m = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length);
    const s = Math.sqrt(v || 1);
    return (x) => (x - m) / (s || 1);
};
async function hybridSearch(q) {
    const t0 = Date.now();
    const notes = [];
    if (!es) {
        if (ALLOW_MOCK) {
            notes.push('es:null => mock');
            return {
                items: [
                    { id: 'mock-es', text: `ES mock for: ${q}`, score: 1.0, source: 'es' },
                    { id: 'mock-pg', text: `PG mock for: ${q}`, score: 0.8, source: 'pg' },
                ],
                ms: Date.now() - t0,
                note: notes.join(' | ')
            };
        }
        return { items: [], ms: Date.now() - t0, note: 'es:null and mock disabled' };
    }
    let esHits = [];
    try {
        const esRes = await es.search({
            index: 'docs',
            size: 50,
            query: { match: { text: q } }
        });
        esHits = (esRes.hits?.hits || []).map((h) => ({
            id: h._id, text: h._source?.text, score: h._score, source: 'es'
        }));
    }
    catch (e) {
        notes.push(`es_error:${e.message || String(e)}`);
    }
    // 念のため、0件なら固定クエリで再試行（投入確認）
    if (esHits.length === 0) {
        try {
            const probe = await es.search({
                index: 'docs',
                size: 5,
                query: { match: { text: '返品 送料' } }
            });
            const probeHits = (probe.hits?.hits || []).map((h) => ({
                id: h._id, text: h._source?.text, score: h._score, source: 'es'
            }));
            if (probeHits.length > 0) {
                esHits = probeHits;
                notes.push('probe:fallback_query_used');
            }
            else {
                notes.push('probe:no_hits');
            }
        }
        catch (e) {
            notes.push(`probe_error:${e.message || String(e)}`);
        }
    }
    if (esHits.length === 0 && ALLOW_MOCK) {
        return {
            items: [
                { id: 'mock-es', text: `ES mock for: ${q}`, score: 1.0, source: 'es' },
                { id: 'mock-pg', text: `PG mock for: ${q}`, score: 0.8, source: 'pg' },
            ],
            ms: Date.now() - t0,
            note: `fallback (budget=${BUDGET}ms) | ` + notes.join(' | ')
        };
    }
    // z-scoreで正規化（将来PG経路とマージする前提のままにしておく）
    const zES = normZ(esHits.map(h => h.score));
    const merged = esHits.map((h, i) => ({ ...h, z: zES(h.score) }))
        .sort((a, b) => b.z - a.z)
        .slice(0, 80)
        .map(({ z, ...rest }) => rest);
    return { items: merged, ms: Date.now() - t0, note: notes.join(' | ') || undefined };
}
