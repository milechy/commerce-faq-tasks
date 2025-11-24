// src/search/rerank.ts
import { performance } from 'node:perf_hooks'
export type Item = { id: string; text: string; score: number; source: 'es'|'pg' };
export type RerankResult = {
  items: Item[];
  ce_ms: number;
  engine: 'heuristic' | 'ce' | 'ce+fallback';
};

// --- Optional ONNX loader (scaffold) ---
let onnxLoaded = false;
let onnxError: string | null = null;

const CE_CANDIDATES = Math.max(
  1,
  Number.isFinite(Number(process.env.CE_CANDIDATES))
    ? Number(process.env.CE_CANDIDATES)
    : 24,
);

const MIN_QUERY_CHARS_FOR_CE = Math.max(
  0,
  Number.isFinite(Number(process.env.CE_MIN_QUERY_CHARS))
    ? Number(process.env.CE_MIN_QUERY_CHARS)
    : 8,
);

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
    // @ts-ignore - onnxruntime-node type declarations are not installed
    const ort = require('onnxruntime-node') as any;
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

function scoreHeuristic(q: string, it: Item): number {
  const qTokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (qTokens.length === 0) return (it.score || 0) * 1e-6;

  const textL = (it.text || '').toLowerCase();
  const matches = qTokens.reduce((acc, t) => acc + Number(textL.includes(t)), 0);
  // 主にマッチ率を優先しつつ、元スコアをごく弱く足す
  return matches / qTokens.length + (it.score || 0) * 1e-6;
}

function shouldUseCE(q: string, candidates: number): boolean {
  const qLen = q.trim().length;
  if (!onnxLoaded) return false; // まだ本物のCEは接続されていない
  if (qLen < MIN_QUERY_CHARS_FOR_CE) return false;
  if (candidates <= 1) return false;
  return true;
}

// --- 現行: 軽量ダミーCE（ONNX準備が整うまでのフォールバック） ---
// 二段階構造:
// - Stage1: 軽量 heuristic で全件をスコアリングし、CE_CANDIDATES まで down-sample
// - Stage2: （将来）Cross-Encoder で Stage1 上位の候補だけ再ランク
export async function rerank(q: string, items: Item[], topK = 5): Promise<RerankResult> {
  const t0 = performance.now();

  if (!items.length) {
    return { items: [], ce_ms: 0, engine: 'heuristic' };
  }

  const safeTopK = Math.max(1, topK);

  // Stage1: heuristic で全件スコアリング
  const scoredAll = items
    .map((it) => {
      const ce = scoreHeuristic(q, it);
      return { ...it, __ce: ce } as Item & { __ce: number };
    })
    .sort((a, b) => (b.__ce - a.__ce) || (b.score - a.score));

  // CE に渡す候補数（現状はまだ heuristic のみに使用するが、構造は二段階にしておく）
  const candidateLimit = Math.min(CE_CANDIDATES, scoredAll.length);
  const stage1Candidates = scoredAll.slice(0, candidateLimit);

  // 将来的な CE 導入のためのフラグ（現状は常に false になる可能性が高い）
  const useCE = shouldUseCE(q, candidateLimit);

  let finalItems: Item[];
  let engine: 'heuristic' | 'ce' | 'ce+fallback' = 'heuristic';

  if (useCE) {
    // TODO: ONNX Cross-Encoder を接続したらここで Stage2 を実装する。
    // 今はまだ tokenizer 未接続のため、安全に heuristic のみを使う。
    finalItems = stage1Candidates.slice(0, safeTopK).map(({ __ce, ...rest }) => rest);
    engine = 'heuristic';
  } else {
    // CE を使わない場合: Stage1 の上位からそのまま topK を返す
    finalItems = scoredAll.slice(0, safeTopK).map(({ __ce, ...rest }) => rest);
    engine = 'heuristic';
  }

  const elapsed = performance.now() - t0;
  return { items: finalItems, ce_ms: Math.max(1, Math.round(elapsed)), engine };
}