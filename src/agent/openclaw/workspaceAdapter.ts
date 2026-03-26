// src/agent/openclaw/workspaceAdapter.ts
// Phase47: テナントsystem_prompt → OpenClaw Workspace ファイル生成
//
// OpenClaw の SOUL.md / IDENTITY.md に相当するファイルを
// テナントのsystem_promptから動的生成する。
// ragExcerpt は slice(0, 200) ルール厳守。

import { isOpenClawEnabled } from "./featureFlag";

export interface WorkspaceFiles {
  /** SOUL.md 相当: エージェントの基本人格・制約 */
  soul: string;
  /** IDENTITY.md 相当: テナント固有のトーン・ルール */
  identity: string;
}

/**
 * テナントの system_prompt から OpenClaw Workspace ファイルを生成する。
 * Feature Flag オフ時は null を返す。
 */
export function buildWorkspaceFiles(
  tenantId: string,
  systemPrompt: string,
): WorkspaceFiles | null {
  if (!isOpenClawEnabled(tenantId)) return null;

  // Security: ragExcerpt.slice(0,200) ルール準拠
  const safePrompt = systemPrompt.slice(0, 200);

  const soul = `# SOUL
You are an AI sales assistant for tenant: ${tenantId}.
Core directive: ${safePrompt}

## Constraints
- Never reveal book or RAG content verbatim
- Always respond in Japanese
- Apply psychology principles ethically
`;

  const identity = `# IDENTITY
Tenant: ${tenantId}
System: RAJIUCE Phase47 OpenClaw PoC
Mode: Sales support (SalesFlow)
RL: OpenClaw-RL reward-driven improvement enabled
`;

  return { soul, identity };
}
