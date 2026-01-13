// src/agent/http/presentation/lemonSliceAdapter.ts

import crypto from "crypto";
import type { Logger } from "pino";
import type { AdapterMeta } from "../../../api/contracts/agentDialog";

export type LemonSliceProbeInput = {
  tenantId: string;
  sessionId?: string;
  locale: "ja" | "en";
  /**
   * PII 導線では avatar を使わない（接続も probe もしない）
   */
  piiMode?: boolean;
};

function newCorrelationId(): string {
  return crypto.randomBytes(8).toString("hex");
}

function readAvatarFlags() {
  const enabled = (process.env.FF_AVATAR_ENABLED ?? "false") === "true";
  const forceOff = (process.env.FF_AVATAR_FORCE_OFF ?? "false") === "true";
  return { avatarEnabled: enabled, avatarForceOff: forceOff };
}

function readKillSwitch() {
  const enabled = (process.env.KILL_SWITCH_AVATAR ?? "false") === "true";
  const reason = process.env.KILL_SWITCH_REASON ?? undefined;
  return { enabled, reason };
}

function resolveReadinessUrl(): string | undefined {
  // 明示 URL があれば優先
  const explicit = process.env.LEMON_SLICE_READINESS_URL;
  if (explicit && explicit.trim().length > 0) return explicit.trim();

  // endpoint があるなら /health を叩く（プロジェクト都合で変更可）
  const endpoint = process.env.LEMON_SLICE_ENDPOINT;
  if (!endpoint || endpoint.trim().length === 0) return undefined;

  const base = endpoint.trim().replace(/\/+$/, "");
  return `${base}/health`;
}

async function probeHttpReadiness(params: {
  url: string;
  timeoutMs: number;
}): Promise<{ ok: boolean; status?: number; error?: string }> {
  const { url, timeoutMs } = params;

  // Node 20+ なら fetch がある想定。ない場合は fallback 扱い。
  if (typeof (globalThis as any).fetch !== "function") {
    return { ok: false, error: "fetch_unavailable" };
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
    });

    if (!res.ok) {
      return { ok: false, status: res.status, error: "non_2xx" };
    }

    return { ok: true, status: res.status };
  } catch (e: any) {
    const msg =
      e?.name === "AbortError"
        ? "timeout"
        : typeof e?.message === "string"
        ? e.message
        : "unknown_error";
    return { ok: false, error: msg };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Phase22 (PR2b):
 * 接続層（UI/adapter）側の readiness/failed/fallback ログを出すための probe。
 *
 * - presentation-only（失敗しても dialog 実行に影響させない）
 * - **UI に "ready" を返さない方針**のため、戻り status は requested/disabled/skipped_pii/fallback/failed のみにする
 * - readiness を確認できた場合でも meta.status は requested のまま（UI に成功表示させない）
 */
export async function maybeProbeLemonSliceReadiness(
  input: LemonSliceProbeInput,
  logger: Logger
): Promise<AdapterMeta> {
  const correlationId = newCorrelationId();
  const provider: AdapterMeta["provider"] = "lemon_slice";

  const baseLog = {
    tenantId: input.tenantId,
    sessionId: input.sessionId,
    locale: input.locale,
    correlationId,
    provider,
  };

  // PII 導線はスキップ（PR2b）
  if (input.piiMode === true) {
    const meta: AdapterMeta = {
      provider,
      status: "skipped_pii",
      reason: "pii_mode",
      correlationId,
    };
    logger.info({ ...baseLog, meta }, "phase22.adapter.avatar.skipped_pii");
    return meta;
  }

  // フラグ/キルスイッチで disabled
  const flags = readAvatarFlags();
  if (!flags.avatarEnabled) {
    const meta: AdapterMeta = {
      provider,
      status: "disabled",
      reason: "disabled_by_flag",
      correlationId,
    };
    logger.info({ ...baseLog, meta }, "phase22.adapter.avatar.disabled");
    return meta;
  }
  if (flags.avatarForceOff) {
    const meta: AdapterMeta = {
      provider,
      status: "disabled",
      reason: "force_off",
      correlationId,
    };
    logger.info({ ...baseLog, meta }, "phase22.adapter.avatar.disabled");
    return meta;
  }

  const kill = readKillSwitch();
  if (kill.enabled) {
    const meta: AdapterMeta = {
      provider,
      status: "disabled",
      reason: kill.reason ? `kill_switch:${kill.reason}` : "kill_switch",
      correlationId,
    };
    logger.info({ ...baseLog, meta }, "phase22.adapter.avatar.disabled");
    return meta;
  }

  // readiness URL が無いなら fallback
  const readinessUrl = resolveReadinessUrl();
  if (!readinessUrl) {
    const meta: AdapterMeta = {
      provider,
      status: "fallback",
      reason: "no_readiness_url",
      correlationId,
    };
    logger.info({ ...baseLog, meta }, "phase22.adapter.avatar.fallback");
    return meta;
  }

  // requested を基準にし、probe 結果に応じて failed/fallback へ
  const timeoutMs = Number(process.env.AVATAR_READINESS_TIMEOUT_MS ?? 1500);

  logger.info(
    { ...baseLog, readinessUrl, timeoutMs },
    "phase22.adapter.avatar.readiness_start"
  );

  const probed = await probeHttpReadiness({ url: readinessUrl, timeoutMs });

  if (probed.ok) {
    // PR2b: "ready" をレスポンスには載せない（UI が成功表示しないため）
    const meta: AdapterMeta = {
      provider,
      status: "requested",
      reason: "readiness_ok",
      correlationId,
    };
    logger.info(
      { ...baseLog, readinessUrl, httpStatus: probed.status, meta },
      "phase22.adapter.avatar.readiness_ok"
    );
    return meta;
  }

  // fetch が無い等は fallback、HTTP 失敗/timeout は failed 扱い
  if (probed.error === "fetch_unavailable") {
    const meta: AdapterMeta = {
      provider,
      status: "fallback",
      reason: "fetch_unavailable",
      correlationId,
    };
    logger.info({ ...baseLog, meta }, "phase22.adapter.avatar.fallback");
    return meta;
  }

  const meta: AdapterMeta = {
    provider,
    status: "failed",
    reason:
      probed.error === "timeout"
        ? "timeout"
        : probed.status
        ? `http_${probed.status}`
        : probed.error ?? "failed",
    correlationId,
  };

  logger.info(
    { ...baseLog, readinessUrl, httpStatus: probed.status, meta },
    "phase22.adapter.avatar.readiness_failed"
  );
  return meta;
}
