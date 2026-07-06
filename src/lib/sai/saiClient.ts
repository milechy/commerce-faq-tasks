// src/lib/sai/saiClient.ts
// Sai (Agent S) VPS への接続クライアント（Phase2: 接続ブリッジ）
//
// 重要: エージェントの自己申告(outcome)は信用しない設計。
// getTask() は常に final_screenshot_base64 を含んだ生のタスク状態を返すので、
// 呼び出し元（options routes）は必ず人間のレビュー（既存の /complete フロー）を
// 経由させること。ここでは自動完了判定を一切行わない。

import pino from 'pino';

const logger = pino();

const SAI_DEFAULT_MAX_STEPS = 15;

function baseUrl(): string {
  return process.env['SAI_API_BASE_URL'] ?? 'http://204.168.207.52:8787';
}

export type SaiTaskStatus = 'queued' | 'running' | 'complete';

export interface SaiTaskStep {
  step: number;
  action: string;
  reflection?: string;
  error?: string;
}

export interface SaiTask {
  status: SaiTaskStatus;
  steps: number;
  order_id?: string | null;
  description: string;
  max_steps: number;
  last_action?: string;
  outcome?: 'agent_reported_done' | 'agent_reported_fail' | 'step_limit_reached' | 'error' | 'unknown';
  steps_log?: SaiTaskStep[];
  final_screenshot_base64?: string;
  started_at?: number;
  finished_at?: number;
}

function apiKey(): string {
  const key = process.env['SAI_API_KEY'];
  if (!key) throw new Error('SAI_API_KEY not set');
  return key;
}

export async function submitSaiTask(opts: {
  description: string;
  orderId?: string;
  maxSteps?: number;
}): Promise<{ task_id: string; status: string }> {
  const res = await fetch(`${baseUrl()}/v1/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      description: opts.description,
      max_steps: opts.maxSteps ?? SAI_DEFAULT_MAX_STEPS,
      order_id: opts.orderId ?? null,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.warn({ status: res.status, body }, 'submitSaiTask: API error');
    throw new Error(`Sai API error: ${res.status}`);
  }

  return res.json() as Promise<{ task_id: string; status: string }>;
}

export async function getSaiTask(taskId: string): Promise<SaiTask> {
  const res = await fetch(`${baseUrl()}/v1/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    logger.warn({ status: res.status, body }, 'getSaiTask: API error');
    throw new Error(`Sai API error: ${res.status}`);
  }

  return res.json() as Promise<SaiTask>;
}
