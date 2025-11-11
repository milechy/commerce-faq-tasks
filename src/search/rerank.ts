// src/search/rerank.ts
export type Item = { id: string; text: string; score: number; source: 'es'|'pg' };
export type RerankResult = { items: Item[]; ce_ms: number };

// --- Optional ONNX loader (scaffold) ---
let onnxLoaded = false;
let onnxError: string | null = null;

/** Attempt to load ONNX model if CE_MODEL_PATH is set and onnxruntime-node is available.
 *  NOTE: This scaffold intentionally does not run real CE inference yet (tokenizer未接続)。
 *  It prepares the session and keeps dummy re-ranking for safety.
 */
export async function warmupCE(): Promise<{ ok: boolean; engine: string; model?: string; error?: string }>{
  const modelPath = process.env.CE_MODEL_PATH;
  if (!modelPath) {
    onnxLoaded = false;
    onnxError = 'CE_MODEL_PATH not set';
    return { ok: false, engine: 'dummy', error: onnxError };
  }
  try {
    // 動的 import（存在しない環境でも落ちない）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ort = require('onnxruntime-node') as typeof import('onnxruntime-node');
    // セッションを開くだけ（推論はまだ行わない）
    // 本番では tokenizer → input_ids/attention_mask 生成後に run() を呼ぶ
    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      // 最小限の最適化（環境差で失敗しにくく）
      graphOptimizationLevel: 'all'
    } as any);
    // すぐ破棄せずヒープ上で保持する場合は、グローバルに退避
    // ここではロード可否の検証のみ行い、即 close はしない（GC へ）
    void session; // keep allocated
    onnxLoaded = true;
    onnxError = null;
    return { ok: true, engine: 'onnx', model: modelPath };
  } catch (e: any) {
    onnxLoaded = false;
    onnxError = String(e?.message || e);
    return { ok: false, engine: 'dummy', error: onnxError };
  }
}

export function ceStatus(){
  return { onnxLoaded, onnxError, engine: onnxLoaded ? 'onnx' : 'dummy' };
}

// --- 現行: 軽量ダミーCE（ONNX準備が整うまでのフォールバック） ---
export async function rerank(q: string, items: Item[], topK = 5): Promise<RerankResult> {
  const t0 = Date.now();
  // ダミー: クエリ語の包含数 + 元スコアのわずかな寄与
  const qTokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = items
    .map((it) => {
      const textL = (it.text || '').toLowerCase();
      const matches = qTokens.reduce((acc, t) => acc + Number(textL.includes(t)), 0);
      const ce = matches / Math.max(1, qTokens.length) + (it.score || 0) * 1e-6;
      return { ...it, __ce: ce } as Item & { __ce: number };
    })
    .sort((a, b) => (b.__ce - a.__ce) || (b.score - a.score))
    .slice(0, Math.max(1, topK))
    .map(({ __ce, ...rest }) => rest);

  return { items: scored, ce_ms: Date.now() - t0 };
}