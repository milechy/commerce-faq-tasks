// src/agent/openclaw/featureFlag.ts
// Phase47: OpenClaw Feature Flag
// OPENCLAW_TENANTS=carnation  （カンマ区切りで複数指定可）
// OPENCLAW_ENABLED=true       （マスタースイッチ）

export function isOpenClawEnabled(tenantId: string): boolean {
  if (process.env.OPENCLAW_ENABLED !== "true") return false;
  const allowed = (process.env.OPENCLAW_TENANTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.includes(tenantId);
}
