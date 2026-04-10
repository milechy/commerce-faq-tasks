// src/search/rerank.ts
import { performance } from "node:perf_hooks";
import { getCeEngine } from "./ceEngine";
import type { CeEngineStatus } from "./ceEngine";

// 重要：インスタンス自体は ceEngine 側の singleton に寄せる。
// ここでは import 時に初期化しない（process.env がセットされる前に固定される事故を避ける）。
// ただし getCeEngine() が実装都合で都度インスタンス生成してしまう場合でも、
// このモジュール内では同一インスタンスを使い回して状態（onnxLoaded/error）を安定させる。
let _ce: ReturnType<typeof getCeEngine> | null = null;
let _engine: string | null = null;

/**
 * Jest などのテスト用に、rerank.ts 側のモジュールスコープキャッシュをリセットする。
 * 本番コードからは呼ばない前提。
 */
export function __resetCeForTests(): void {
  _ce = null;
  _engine = null;
}

// Read env lazily (at first access) and then pin the resolved values in module-scoped state.
// This avoids "module imported before env is set" issues in tests/dev, while still preventing flapping.
function readEnvEngine(): "onnx" | "dummy" {
  return String(process.env.CE_ENGINE ?? "")
    .trim()
    .toLowerCase() === "onnx"
    ? "onnx"
    : "dummy";
}

function readEnvNumber(key: string): number | undefined {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : undefined;
}

function readEnvMinQueryChars(): number | undefined {
  return readEnvNumber("CE_MIN_QUERY_CHARS");
}

function readEnvCandidates(): number | undefined {
  return readEnvNumber("CE_CANDIDATES");
}

function ce() {
  if (_ce) return _ce;
  _ce = getCeEngine();

  // Seed the label from env so /ce/status is stable even before ceEngine.status() is safe to call.
  _engine = _engine ?? readEnvEngine();

  // Fix the engine label on first access so that status()/rerank gating
  // cannot flap if ceEngine resolves engine name lazily.
  try {
    _engine = (_ce.status() as CeEngineStatus).engine;
  } catch {
    _engine = _engine ?? null;
  }

  return _ce;
}

// Legacy CE status shape — some older implementations may expose onnxError / onnx_error
type LegacyCeStatus = CeEngineStatus & { onnxError?: string | null; onnx_error?: string | null };

function stableStatus(): CeEngineStatus {
  try {
    const st = ce().status() as LegacyCeStatus;
    // Some ceEngine implementations may expose errors as `onnxError` (legacy)
    // while newer ones use `error`. Normalize to `error` for internal use.
    const normalizedError = st.error ?? st.onnxError ?? st.onnx_error ?? null;

    const engine = (_engine ?? st.engine) === "onnx" ? "onnx" : "dummy";
    // Once we have a stable label, keep it pinned.
    _engine = _engine ?? engine;

    return {
      ...st,
      // Keep engine label stable even if ceEngine resolves lazily.
      // Also normalize to the supported labels we expose via the HTTP API.
      engine,
      // Normalized error key used by gating and HTTP wrappers.
      error: normalizedError,
    };
  } catch (e) {
    // If status() ever throws, treat it as "not ready" but keep the configured label if we have one.
    const resolvedEngine = (_engine ?? readEnvEngine()) === "onnx" ? "onnx" : "dummy";
    return {
      engine: resolvedEngine,
      onnxLoaded: false,
      error: String((e as Error)?.message ?? String(e) ?? "status error"),
      config: { candidates: readEnvCandidates() ?? 24, minQueryChars: readEnvMinQueryChars() ?? 8, maxBatchSize: 16 },
      modelPath: null,
      warmedUp: false,
    };
  }
}

export type Item = {
  id: string;
  text: string;
  score: number;
  source: "es" | "pg" | "pgvector";
};

export type RerankResult = {
  items: Item[];
  ce_ms: number;
  engine: "heuristic" | "ce" | "ce+fallback";
};

export type CeFlag = "ce:active" | "ce:skipped";

// Convert rerank result into the flag exposed in `meta.flags`.
// - `ce` / `ce+fallback` means the CE path was selected (even if it later fell back).
// - `heuristic` means CE was not used.
export function ceFlagFromRerankResult(
  r: Pick<RerankResult, "engine">
): CeFlag {
  return r.engine === "ce" || r.engine === "ce+fallback"
    ? "ce:active"
    : "ce:skipped";
}

function scoreHeuristic(q: string, it: Item): number {
  const qTokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (qTokens.length === 0) return (it.score || 0) * 1e-6;

  const textL = (it.text || "").toLowerCase();
  const matches = qTokens.reduce(
    (acc, t) => acc + Number(textL.includes(t)),
    0
  );

  // 主にマッチ率を優先しつつ、元スコアをごく弱く足す
  return matches / qTokens.length + (it.score || 0) * 1e-6;
}

/**
 * 現在のクエリ・候補数・CEエンジン状態から、CE を使うかどうかを判定する。
 */
function shouldUseCE(
  q: string,
  candidates: number,
  status: ReturnType<typeof stableStatus>
): boolean {
  const qLen = q.trim().length;

  const minChars = Math.max(
    1,
    status.config?.minQueryChars ?? readEnvMinQueryChars() ?? 8
  );

  if (qLen < minChars) return false;
  if (candidates <= 1) return false;

  if (status.engine !== "onnx") return false;
  if (status.error) return false;

  // ★ onnxLoaded は gate にしない（lazy load は scoreBatch 側に任せる）
  return true;
}

/**
 * /ce/warmup 用のラッパー。
 * 既存のレスポンス shape（ok / engine / model / error）を維持しつつ、
 * 内部では CeEngineStatus を使用する。
 */
export async function warmupCE(): Promise<{
  ok: boolean;
  engine: string;
  model?: string;
  error?: string;
}> {
  const status = await ce().warmup();

  // Keep the engine label stable even if load fails.
  const engine = _engine ?? status.engine;
  const ok = engine === "onnx" && status.onnxLoaded && !status.error;

  return {
    ok,
    engine,
    model: status.modelPath ?? undefined,
    error: status.error ?? undefined,
  };
}

/**
 * /ce/status 用のラッパー。
 * 既存のレスポンス shape（onnxLoaded / onnxError / engine）を維持する。
 */
export function ceStatus() {
  const st = stableStatus();

  // NOTE: /ce/status must be side-effect free.
  // Warmup (model load) is initiated explicitly via /ce/warmup, or implicitly when rerank calls scoreBatch.
  // stableStatus() normalizes legacy onnxError/onnx_error into .error already.
  const onnxError = st.error;

  return {
    onnxLoaded: Boolean(st.onnxLoaded),
    onnxError,
    // Prefer pinned engine label; if unset, fall back to current env.
    engine:
      (_engine ?? st.engine ?? readEnvEngine()) === "onnx"
        ? "onnx"
        : "dummy",
  };
}

// --- rerank 本体 ---
// 二段階構造:
// - Stage1: 軽量 heuristic で全件をスコアリングし、CE_CANDIDATES まで down-sample
// - Stage2: Cross-Encoder で Stage1 上位の候補だけ再ランク（CE が有効な場合）
export async function rerank(
  q: string,
  items: Item[],
  topK = 5
): Promise<RerankResult> {
  if (!items.length) {
    return { items: [], ce_ms: 0, engine: "heuristic" };
  }

  const safeTopK = Math.max(1, topK);

  // Stage1: heuristic で全件スコアリング
  const scoredAll = items
    .map((it) => {
      const ceScore = scoreHeuristic(q, it);
      return { ...it, __ce: ceScore } as Item & { __ce: number };
    })
    .sort((a, b) => b.__ce - a.__ce || b.score - a.score);

  const status = stableStatus();
  const ceCandidates = Math.max(
    1,
    status.config?.candidates ?? readEnvCandidates() ?? 24
  );
  const candidateLimit = Math.min(ceCandidates, scoredAll.length);
  const stage1Candidates = scoredAll.slice(0, candidateLimit);

  const useCE = shouldUseCE(q, candidateLimit, status);

  let finalItems: Item[];
  let engineLabel: RerankResult["engine"] = "heuristic";
  let ceMs = 0;

  if (useCE) {
    try {
      const texts = stage1Candidates.map((it) => it.text);
      const ceT0 = performance.now();
      const scores = await ce().scoreBatch(q, texts);
      ceMs = Math.max(1, Math.round(performance.now() - ceT0));

      const withCeScores = stage1Candidates
        .map((it, idx) => ({
          ...it,
          __ce:
            typeof scores[idx] === "number" ? scores[idx] : it.__ce,
        }))
        .sort((a, b) => b.__ce - a.__ce || b.score - a.score);

      finalItems = withCeScores
        .slice(0, safeTopK)
        .map(({ __ce: _ce, ...rest }) => rest as Item);
      engineLabel = "ce";
    } catch {
      // CE に失敗した場合は Stage1 の heuristic 結果にフォールバック
      finalItems = stage1Candidates
        .slice(0, safeTopK)
        .map(({ __ce: _ce, ...rest }) => rest as Item);
      engineLabel = "ce+fallback";
    }
  } else {
    // CE を使わない場合: Stage1 の heuristic 上位からそのまま topK を返す
    finalItems = scoredAll
      .slice(0, safeTopK)
      .map(({ __ce: _ce, ...rest }) => rest as Item);
    engineLabel = "heuristic";
  }

  return {
    items: finalItems,
    ce_ms: ceMs,
    engine: engineLabel,
  };
}
