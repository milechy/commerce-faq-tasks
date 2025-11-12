"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.warmupCE = warmupCE;
exports.ceStatus = ceStatus;
exports.rerank = rerank;
// src/search/rerank.ts
const node_perf_hooks_1 = require("node:perf_hooks");
// --- Optional ONNX loader (scaffold) ---
let onnxLoaded = false;
let onnxError = null;
/** Attempt to load ONNX model if CE_MODEL_PATH is set and onnxruntime-node is available.
 *  NOTE: This scaffold intentionally does not run real CE inference yet (tokenizer未接続)。
 *  It prepares the session and keeps dummy re-ranking for safety.
 */
async function warmupCE() {
    const modelPath = process.env.CE_MODEL_PATH;
    if (!modelPath) {
        onnxLoaded = false;
        onnxError = 'CE_MODEL_PATH not set';
        return { ok: false, engine: 'dummy', error: onnxError };
    }
    try {
        // 動的 import（存在しない環境でも落ちない）
        // @ts-ignore - onnxruntime-node type declarations are not installed
        const ort = require('onnxruntime-node');
        // セッションを開くだけ（推論はまだ行わない）
        // 本番では tokenizer → input_ids/attention_mask 生成後に run() を呼ぶ
        const session = await ort.InferenceSession.create(modelPath, {
            executionProviders: ['cpu'],
            // 最小限の最適化（環境差で失敗しにくく）
            graphOptimizationLevel: 'all'
        });
        // すぐ破棄せずヒープ上で保持する場合は、グローバルに退避
        // ここではロード可否の検証のみ行い、即 close はしない（GC へ）
        void session; // keep allocated
        onnxLoaded = true;
        onnxError = null;
        return { ok: true, engine: 'onnx', model: modelPath };
    }
    catch (e) {
        onnxLoaded = false;
        onnxError = String(e?.message || e);
        return { ok: false, engine: 'dummy', error: onnxError };
    }
}
function ceStatus() {
    return { onnxLoaded, onnxError, engine: onnxLoaded ? 'onnx' : 'dummy' };
}
// --- 現行: 軽量ダミーCE（ONNX準備が整うまでのフォールバック） ---
async function rerank(q, items, topK = 5) {
    const t0 = node_perf_hooks_1.performance.now();
    // ダミー: クエリ語の包含数 + 元スコアのわずかな寄与
    const qTokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = items
        .map((it) => {
        const textL = (it.text || '').toLowerCase();
        const matches = qTokens.reduce((acc, t) => acc + Number(textL.includes(t)), 0);
        const ce = matches / Math.max(1, qTokens.length) + (it.score || 0) * 1e-6;
        return { ...it, __ce: ce };
    })
        .sort((a, b) => (b.__ce - a.__ce) || (b.score - a.score))
        .slice(0, Math.max(1, topK))
        .map(({ __ce, ...rest }) => rest);
    const elapsed = node_perf_hooks_1.performance.now() - t0;
    return { items: scored, ce_ms: Math.max(1, Math.round(elapsed)) };
}
