import type { Pool } from "pg";
import { checkGa4Connection } from "./ga4Client";
import { logger } from "../logger";

export type Ga4StatusValue =
  | "not_configured"
  | "pending"
  | "connected"
  | "error"
  | "timeout"
  | "permission_revoked";

export interface Ga4HealthResult {
  status: Ga4StatusValue;
  errorMessage?: string;
  connectedAt?: Date;
}

const TEST_TIMEOUT_MS = 10_000;

export async function runGa4HealthCheck(
  tenantId: string,
  propertyId: string,
  db: Pool,
): Promise<Ga4HealthResult> {
  logger.info({ tenantId, propertyId }, "[ga4HealthCheck] starting");

  let result: Ga4HealthResult;

  try {
    const checkPromise = checkGa4Connection(propertyId);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), TEST_TIMEOUT_MS),
    );

    const check = await Promise.race([checkPromise, timeoutPromise]);

    if (check.status === "not_configured") {
      result = { status: "not_configured" };
    } else if (check.status === "ok") {
      result = { status: "connected", connectedAt: new Date() };
    } else {
      const errMsg = check.error ?? "unknown";
      const status: Ga4StatusValue = errMsg === "permission_denied"
        ? "permission_revoked"
        : "error";
      result = { status, errorMessage: errMsg };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === "timeout") {
      result = { status: "timeout", errorMessage: "Connection timed out after 10s" };
    } else {
      result = { status: "error", errorMessage: message.slice(0, 200) };
    }
  }

  await persistHealthResult(tenantId, propertyId, result, db);
  return result;
}

async function persistHealthResult(
  tenantId: string,
  propertyId: string,
  result: Ga4HealthResult,
  db: Pool,
): Promise<void> {
  try {
    // Update tenant GA4 status
    const updates: string[] = ["ga4_status = $1", "updated_at = NOW()"];
    const params: unknown[] = [result.status, tenantId];

    if (result.errorMessage !== undefined) {
      updates.push(`ga4_error_message = $${params.length + 1}`);
      params.splice(params.length - 1, 0, result.errorMessage);
    }
    if (result.status === "connected" && result.connectedAt) {
      updates.push(`ga4_connected_at = $${params.length}`);
      params.splice(params.length - 1, 0, result.connectedAt);
    }
    if (result.status === "connected") {
      updates.push(`ga4_last_sync_at = NOW()`);
    }

    await db.query(
      `UPDATE tenants SET ${updates.join(", ")} WHERE id = $${params.length}`,
      params,
    );

    // Insert test history
    await db.query(
      `INSERT INTO ga4_test_history
         (tenant_id, test_type, success, error_message, tested_at)
       VALUES ($1, 'measurement_protocol', $2, $3, NOW())`,
      [tenantId, result.status === "connected", result.errorMessage ?? null],
    );

    // Log action
    await db.query(
      `INSERT INTO ga4_connection_logs
         (tenant_id, action, status, message, metadata, triggered_by)
       VALUES ($1, 'connection_test', $2, $3, $4, 'user')`,
      [
        tenantId,
        result.status === "connected" ? "success" : "failure",
        result.errorMessage ?? result.status,
        JSON.stringify({ propertyId }),
      ],
    );
  } catch (err) {
    logger.warn({ err, tenantId }, "[ga4HealthCheck] failed to persist result");
  }
}
