// tests/agent/observability/phase22Logging.test.ts

import pino from "pino";
import {
  logPhase22Event,
  type Phase22EventName,
} from "../../../src/agent/observability/phase22EventLogger";

describe("Phase22 Logging Completeness Tests", () => {
  let logs: any[];
  let logger: pino.Logger;

  beforeEach(() => {
    logs = [];
    logger = pino({
      level: "info",
      transport: {
        target: "pino/file",
        options: {
          destination: 1,
        },
      },
    });

    // Mock logger to capture logs
    logger.info = jest.fn((obj: any, msg?: string) => {
      logs.push({ ...obj, msg });
    }) as any;
  });

  const basePayload = {
    tenantId: "test-tenant",
    conversationId: "test-conv",
    correlationId: "test-corr",
  };

  describe("Flow Events", () => {
    test("should log flow.enter_state event", () => {
      logPhase22Event(logger, {
        ...basePayload,
        event: "flow.enter_state",
        meta: { state: "clarify", from: "answer" },
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "flow.enter_state",
          tenantId: "test-tenant",
          conversationId: "test-conv",
          correlationId: "test-corr",
          meta: expect.objectContaining({ state: "clarify" }),
        }),
        "phase22.flow.enter_state"
      );
    });

    test("should log flow.exit_state event", () => {
      logPhase22Event(logger, {
        ...basePayload,
        event: "flow.exit_state",
        meta: { from: "answer", to: "clarify" },
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "flow.exit_state",
          tenantId: "test-tenant",
          conversationId: "test-conv",
          meta: expect.objectContaining({ from: "answer", to: "clarify" }),
        }),
        "phase22.flow.exit_state"
      );
    });

    test("should log flow.terminal_reached event", () => {
      logPhase22Event(logger, {
        ...basePayload,
        event: "flow.terminal_reached",
        meta: { terminalReason: "completed" },
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "flow.terminal_reached",
          meta: expect.objectContaining({ terminalReason: "completed" }),
        }),
        "phase22.flow.terminal_reached"
      );
    });

    test("should log flow.loop_detected event", () => {
      logPhase22Event(logger, {
        ...basePayload,
        event: "flow.loop_detected",
        meta: { loopType: "state_pattern", pattern: ["answer", "clarify"] },
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "flow.loop_detected",
          meta: expect.objectContaining({ loopType: "state_pattern" }),
        }),
        "phase22.flow.loop_detected"
      );
    });
  });

  describe("Avatar Events", () => {
    test("should log avatar.requested event", () => {
      logPhase22Event(logger, {
        ...basePayload,
        event: "avatar.requested",
        meta: { provider: "lemon_slice", readinessTimeoutMs: 1500 },
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "avatar.requested",
          meta: expect.objectContaining({ provider: "lemon_slice" }),
        }),
        "phase22.avatar.requested"
      );
    });

    test("should log avatar.ready event", () => {
      logPhase22Event(logger, {
        ...basePayload,
        event: "avatar.ready",
        meta: { provider: "lemon_slice", readinessMs: 450 },
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "avatar.ready",
        }),
        "phase22.avatar.ready"
      );
    });

    test("should log avatar.failed event", () => {
      logPhase22Event(logger, {
        ...basePayload,
        event: "avatar.failed",
        meta: { provider: "lemon_slice", error: "Connection timeout" },
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "avatar.failed",
          meta: expect.objectContaining({ error: "Connection timeout" }),
        }),
        "phase22.avatar.failed"
      );
    });

    test("should log avatar.fallback_to_text event", () => {
      logPhase22Event(logger, {
        ...basePayload,
        event: "avatar.fallback_to_text",
        meta: { reason: "timeout", timeoutMs: 1500 },
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "avatar.fallback_to_text",
          meta: expect.objectContaining({ reason: "timeout" }),
        }),
        "phase22.avatar.fallback_to_text"
      );
    });

    test("should log avatar.disabled_by_flag event", () => {
      logPhase22Event(logger, {
        ...basePayload,
        event: "avatar.disabled_by_flag",
        meta: { flag: "FF_AVATAR_ENABLED", value: false },
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "avatar.disabled_by_flag",
        }),
        "phase22.avatar.disabled_by_flag"
      );
    });

    test("should log avatar.disabled_by_kill_switch event", () => {
      logPhase22Event(logger, {
        ...basePayload,
        event: "avatar.disabled_by_kill_switch",
        meta: { reason: "Cost threshold exceeded" },
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "avatar.disabled_by_kill_switch",
          meta: expect.objectContaining({ reason: "Cost threshold exceeded" }),
        }),
        "phase22.avatar.disabled_by_kill_switch"
      );
    });

    test("should log avatar.forced_off_pii event", () => {
      logPhase22Event(logger, {
        ...basePayload,
        event: "avatar.forced_off_pii",
        meta: { piiReasons: ["payment_billing", "order_tracking"] },
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "avatar.forced_off_pii",
          meta: expect.objectContaining({
            piiReasons: expect.arrayContaining(["payment_billing"]),
          }),
        }),
        "phase22.avatar.forced_off_pii"
      );
    });
  });

  describe("Event Structure Validation", () => {
    test("all events should include required base fields", () => {
      const events: Phase22EventName[] = [
        "flow.enter_state",
        "flow.exit_state",
        "flow.terminal_reached",
        "flow.loop_detected",
        "avatar.requested",
        "avatar.ready",
        "avatar.failed",
        "avatar.fallback_to_text",
        "avatar.disabled_by_flag",
        "avatar.disabled_by_kill_switch",
        "avatar.forced_off_pii",
      ];

      events.forEach((event) => {
        logPhase22Event(logger, {
          ...basePayload,
          event,
          meta: {},
        });

        expect(logger.info).toHaveBeenCalledWith(
          expect.objectContaining({
            event,
            tenantId: "test-tenant",
            conversationId: "test-conv",
            correlationId: "test-corr",
            meta: expect.any(Object),
          }),
          expect.stringContaining(`phase22.${event}`)
        );
      });

      expect(logger.info).toHaveBeenCalledTimes(events.length);
    });

    test("should handle missing optional meta", () => {
      logPhase22Event(logger, {
        ...basePayload,
        event: "avatar.requested",
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "avatar.requested",
          meta: {},
        }),
        "phase22.avatar.requested"
      );
    });

    test("should preserve custom meta fields", () => {
      logPhase22Event(logger, {
        ...basePayload,
        event: "flow.terminal_reached",
        meta: {
          terminalReason: "completed",
          customField: "custom-value",
          nestedMeta: { key: "value" },
        },
      });

      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          meta: expect.objectContaining({
            terminalReason: "completed",
            customField: "custom-value",
            nestedMeta: { key: "value" },
          }),
        }),
        "phase22.flow.terminal_reached"
      );
    });
  });

  describe("Event Naming Convention", () => {
    test("flow events should follow phase22.flow.* pattern", () => {
      const flowEvents: Phase22EventName[] = [
        "flow.enter_state",
        "flow.exit_state",
        "flow.terminal_reached",
        "flow.loop_detected",
      ];

      flowEvents.forEach((event) => {
        logPhase22Event(logger, {
          ...basePayload,
          event,
        });

        expect(logger.info).toHaveBeenCalledWith(
          expect.any(Object),
          expect.stringMatching(/^phase22\.flow\./)
        );
      });
    });

    test("avatar events should follow phase22.avatar.* pattern", () => {
      const avatarEvents: Phase22EventName[] = [
        "avatar.requested",
        "avatar.ready",
        "avatar.failed",
        "avatar.fallback_to_text",
        "avatar.disabled_by_flag",
        "avatar.disabled_by_kill_switch",
        "avatar.forced_off_pii",
      ];

      avatarEvents.forEach((event) => {
        logPhase22Event(logger, {
          ...basePayload,
          event,
        });

        expect(logger.info).toHaveBeenCalledWith(
          expect.any(Object),
          expect.stringMatching(/^phase22\.avatar\./)
        );
      });
    });
  });

  describe("PHASE22.md Compliance", () => {
    test("should support all required flow events from PHASE22.md", () => {
      const requiredFlowEvents: Phase22EventName[] = [
        "flow.enter_state",
        "flow.exit_state",
        "flow.terminal_reached",
        "flow.loop_detected",
      ];

      requiredFlowEvents.forEach((event) => {
        expect(() => {
          logPhase22Event(logger, {
            ...basePayload,
            event,
          });
        }).not.toThrow();
      });
    });

    test("should support all required avatar events from PHASE22.md", () => {
      const requiredAvatarEvents: Phase22EventName[] = [
        "avatar.requested",
        "avatar.ready",
        "avatar.failed",
        "avatar.fallback_to_text",
        "avatar.disabled_by_flag",
      ];

      requiredAvatarEvents.forEach((event) => {
        expect(() => {
          logPhase22Event(logger, {
            ...basePayload,
            event,
          });
        }).not.toThrow();
      });
    });
  });
});
