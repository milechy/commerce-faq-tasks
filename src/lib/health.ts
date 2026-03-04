import { Client as ES } from "@elastic/elasticsearch";
import type { Request, Response } from "express";
import { ceStatus } from "../search/rerank";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Pool } = require("pg") as { Pool: any };

const HEALTH_TIMEOUT_MS = 2000;

interface ComponentHealth {
  ok: boolean;
  latencyMs?: number;
  engine?: string;
}

interface HealthResponse {
  status: "ok" | "degraded";
  timestamp: string;
  components: {
    es: ComponentHealth;
    pg: ComponentHealth;
    ce: ComponentHealth;
  };
}

async function checkEs(): Promise<ComponentHealth> {
  const esUrl = process.env.ES_URL;
  if (!esUrl) {
    return { ok: false };
  }
  const client = new ES({ node: esUrl });
  const t0 = Date.now();
  try {
    await Promise.race([
      client.ping(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), HEALTH_TIMEOUT_MS)
      ),
    ]);
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch {
    return { ok: false, latencyMs: Date.now() - t0 };
  }
}

async function checkPg(): Promise<ComponentHealth> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    return { ok: false };
  }
  const pool = new Pool({ connectionString: dbUrl, max: 1 });
  const t0 = Date.now();
  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), HEALTH_TIMEOUT_MS)
      ),
    ]);
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch {
    return { ok: false, latencyMs: Date.now() - t0 };
  } finally {
    pool.end().catch(() => undefined);
  }
}

function checkCe(): ComponentHealth {
  try {
    const st = ceStatus();
    return {
      ok: st.engine !== null,
      engine: st.engine,
    };
  } catch {
    return { ok: false };
  }
}

export async function healthHandler(_req: Request, res: Response): Promise<void> {
  const [es, pg] = await Promise.all([checkEs(), checkPg()]);
  const ce = checkCe();

  const allOk = es.ok && pg.ok && ce.ok;

  const body: HealthResponse = {
    status: allOk ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    components: { es, pg, ce },
  };

  res.status(allOk ? 200 : 503).json(body);
}
