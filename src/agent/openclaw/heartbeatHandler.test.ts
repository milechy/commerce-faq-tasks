// src/agent/openclaw/heartbeatHandler.test.ts
// Phase47-D: heartbeatHandler テスト

import type {
  FlowSessionMeta,
  TerminalReason,
} from "../dialog/flowContextStore";
import { snapshotFlowSessionMetas } from "../dialog/flowContextStore";
import { sendSlackAlert } from "../../lib/alerts/slackNotifier";
import {
  evaluateHeartbeat,
  startOpenClawHeartbeat,
  stopOpenClawHeartbeat,
} from "./heartbeatHandler";

jest.mock("../dialog/flowContextStore", () => ({
  snapshotFlowSessionMetas: jest.fn(),
}));

jest.mock("../../lib/alerts/slackNotifier", () => ({
  sendSlackAlert: jest.fn(),
}));

const mockSnapshot = snapshotFlowSessionMetas as jest.MockedFunction<
  typeof snapshotFlowSessionMetas
>;
const mockSendSlackAlert = sendSlackAlert as jest.MockedFunction<
  typeof sendSlackAlert
>;

// 必須フィールドを最小で埋めた FlowSessionMeta ダミー
function makeMeta(terminalReason?: TerminalReason): FlowSessionMeta {
  return {
    state: "terminal",
    turnIndex: 1,
    sameStateRepeats: 0,
    clarifyRepeats: 0,
    confirmRepeats: 0,
    recentStates: [],
    terminalReason,
    lastUpdatedAt: new Date().toISOString(),
  };
}

function makeMetas(
  counts: Partial<Record<TerminalReason, number>>
): FlowSessionMeta[] {
  const metas: FlowSessionMeta[] = [];
  for (const [reason, count] of Object.entries(counts)) {
    for (let i = 0; i < (count ?? 0); i++) {
      metas.push(makeMeta(reason as TerminalReason));
    }
  }
  return metas;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSendSlackAlert.mockResolvedValue(undefined);
  process.env.OPENCLAW_ENABLED = "true";
});

afterEach(() => {
  stopOpenClawHeartbeat(); // interval + cooldown 状態リセット
  delete process.env.OPENCLAW_ENABLED;
  jest.useRealTimers();
});

describe("evaluateHeartbeat", () => {
  it("stall_rate 0.25 (>0.2) でアラート発火する", async () => {
    // 4件中 1件 aborted_loop_detected → stall_rate=0.25
    mockSnapshot.mockReturnValue(
      makeMetas({ aborted_loop_detected: 1, completed: 3 })
    );

    await evaluateHeartbeat();

    expect(mockSendSlackAlert).toHaveBeenCalledTimes(1);
    const message = mockSendSlackAlert.mock.calls[0][0];
    expect(message.ruleId).toBe("openclaw-heartbeat");
    // カウントとレートのみ（会話内容・PII を含めない）
    expect(message.details).toContain("stall_rate=0.250");
  });

  it("stall_rate 0.15 かつ abort_rate 0.2 では発火しない", async () => {
    // 20件中 stall 3 (0.15) / abort 4 (0.2)
    mockSnapshot.mockReturnValue(
      makeMetas({
        aborted_loop_detected: 3,
        aborted_user: 2,
        aborted_budget: 1,
        failed_safe_mode: 1,
        completed: 12,
        escalated_handoff: 1,
      })
    );

    await evaluateHeartbeat();

    expect(mockSendSlackAlert).not.toHaveBeenCalled();
  });

  it("abort_rate 0.35 (>0.3) でアラート発火する", async () => {
    // 20件中 abort 7 (aborted_user 3 + aborted_budget 2 + failed_safe_mode 2) → 0.35
    mockSnapshot.mockReturnValue(
      makeMetas({
        aborted_user: 3,
        aborted_budget: 2,
        failed_safe_mode: 2,
        completed: 13,
      })
    );

    await evaluateHeartbeat();

    expect(mockSendSlackAlert).toHaveBeenCalledTimes(1);
    expect(mockSendSlackAlert.mock.calls[0][0].details).toContain(
      "abort_rate=0.350"
    );
  });

  it("terminalReason 付きセッション 0 件なら発火しない", async () => {
    // terminalReason undefined のみ（進行中セッション）
    mockSnapshot.mockReturnValue([makeMeta(undefined), makeMeta(undefined)]);

    await evaluateHeartbeat();

    expect(mockSendSlackAlert).not.toHaveBeenCalled();
  });

  it("escalated_handoff / completed は両 rate から除外される", async () => {
    // 10件全部 escalated_handoff/completed → stall 0 / abort 0 → 発火しない
    mockSnapshot.mockReturnValue(
      makeMetas({ escalated_handoff: 5, completed: 5 })
    );

    await evaluateHeartbeat();

    expect(mockSendSlackAlert).not.toHaveBeenCalled();
  });

  it("cooldown: 発火直後の再 evaluate では再発火しない", async () => {
    mockSnapshot.mockReturnValue(
      makeMetas({ aborted_loop_detected: 1, completed: 1 })
    );

    await evaluateHeartbeat();
    await evaluateHeartbeat();

    expect(mockSendSlackAlert).toHaveBeenCalledTimes(1);
  });

  it("Slack 送信失敗は throw しない（non-blocking）", async () => {
    mockSnapshot.mockReturnValue(
      makeMetas({ aborted_loop_detected: 1, completed: 1 })
    );
    mockSendSlackAlert.mockRejectedValue(new Error("webhook down"));

    await expect(evaluateHeartbeat()).resolves.toBeUndefined();
  });
});

describe("startOpenClawHeartbeat", () => {
  it("グローバル Flag OFF なら interval を作らない", () => {
    jest.useFakeTimers();
    delete process.env.OPENCLAW_ENABLED;
    mockSnapshot.mockReturnValue(
      makeMetas({ aborted_loop_detected: 1, completed: 1 })
    );

    startOpenClawHeartbeat();
    jest.advanceTimersByTime(31 * 60 * 1000);

    expect(mockSnapshot).not.toHaveBeenCalled();
    expect(mockSendSlackAlert).not.toHaveBeenCalled();
  });

  it("グローバル Flag ON なら 30 分周期で evaluate される", () => {
    jest.useFakeTimers();
    mockSnapshot.mockReturnValue([]);

    startOpenClawHeartbeat();
    jest.advanceTimersByTime(31 * 60 * 1000);

    expect(mockSnapshot).toHaveBeenCalledTimes(1);
  });

  it("二重起動しても interval は 1 本のみ", () => {
    jest.useFakeTimers();
    mockSnapshot.mockReturnValue([]);

    startOpenClawHeartbeat();
    startOpenClawHeartbeat();
    jest.advanceTimersByTime(31 * 60 * 1000);

    expect(mockSnapshot).toHaveBeenCalledTimes(1);
  });
});
