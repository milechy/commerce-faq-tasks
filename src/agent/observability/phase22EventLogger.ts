// src/agent/observability/phase22EventLogger.ts

import type pino from "pino";

export type Phase22EventName =
  | "flow.enter_state"
  | "flow.exit_state"
  | "flow.terminal_reached"
  | "flow.loop_detected"
  | "avatar.requested"
  | "avatar.ready"
  | "avatar.failed"
  | "avatar.fallback_to_text"
  | "avatar.disabled_by_flag"
  | "avatar.disabled_by_kill_switch"
  | "avatar.forced_off_pii";

export function logPhase22Event(
  logger: pino.Logger,
  payload: {
    event: Phase22EventName;
    tenantId: string;
    conversationId: string;
    correlationId: string;
    meta?: Record<string, any>;
  }
): void {
  logger.info(
    {
      event: payload.event,
      tenantId: payload.tenantId,
      conversationId: payload.conversationId,
      correlationId: payload.correlationId,
      meta: payload.meta ?? {},
    },
    `phase22.${payload.event}`
  );
}
