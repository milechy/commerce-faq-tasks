import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { JudgeEvaluationSection } from "./JudgeEvaluationSection";
import { authFetch } from "../../../lib/api";
import type { Evaluation } from "./types";

vi.mock("../../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
  authFetch: vi.fn(),
}));

const mockedAuthFetch = authFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

beforeEach(() => {
  mockedAuthFetch.mockReset();
});

describe("JudgeEvaluationSection — 未評価時のトリガーUI", () => {
  it("evaluation が null かつ sessionId 未指定なら実行ボタンを出さない", () => {
    render(
      <JudgeEvaluationSection evaluation={null} isSuperAdmin={false} setEvaluation={vi.fn()} />
    );
    expect(screen.queryByText("今すぐ評価を実行")).toBeNull();
  });

  it("evaluation が null かつ sessionId 指定時は実行ボタンを出す", () => {
    render(
      <JudgeEvaluationSection
        evaluation={null}
        isSuperAdmin={false}
        setEvaluation={vi.fn()}
        sessionId="s1"
      />
    );
    expect(screen.getByText("今すぐ評価を実行")).toBeTruthy();
  });

  it("200: 成功時は evaluation を更新しエラーを出さない", async () => {
    const evaluation: Evaluation = {
      id: 1,
      score: 80,
      evaluated_at: "2026-01-01T00:00:00Z",
    };
    mockedAuthFetch.mockResolvedValue(jsonResponse(200, { evaluation }));
    const setEvaluation = vi.fn();
    render(
      <JudgeEvaluationSection
        evaluation={null}
        isSuperAdmin={false}
        setEvaluation={setEvaluation}
        sessionId="s1"
      />
    );
    fireEvent.click(screen.getByText("今すぐ評価を実行"));

    await waitFor(() => {
      expect(setEvaluation).toHaveBeenCalledWith(evaluation);
    });
    expect(mockedAuthFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/admin/evaluations/trigger"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ session_id: "s1" }),
      })
    );
  });

  it("404: セッション不在/他テナントの文言を表示する", async () => {
    mockedAuthFetch.mockResolvedValue(jsonResponse(404, { error: "セッションが見つかりません" }));
    render(
      <JudgeEvaluationSection
        evaluation={null}
        isSuperAdmin={false}
        setEvaluation={vi.fn()}
        sessionId="s1"
      />
    );
    fireEvent.click(screen.getByText("今すぐ評価を実行"));

    await waitFor(() => {
      expect(screen.getByText(/セッションが見つかりません/)).toBeTruthy();
    });
  });

  it("409: 評価済みの文言を表示する", async () => {
    mockedAuthFetch.mockResolvedValue(jsonResponse(409, { error: "already_evaluated" }));
    render(
      <JudgeEvaluationSection
        evaluation={null}
        isSuperAdmin={false}
        setEvaluation={vi.fn()}
        sessionId="s1"
      />
    );
    fireEvent.click(screen.getByText("今すぐ評価を実行"));

    await waitFor(() => {
      expect(screen.getByText(/既に評価済みです/)).toBeTruthy();
    });
  });

  it("422: 会話が短すぎる旨の文言を表示する", async () => {
    mockedAuthFetch.mockResolvedValue(
      jsonResponse(422, { error: "session_too_short", message: "会話が短すぎるため評価対象外です" })
    );
    render(
      <JudgeEvaluationSection
        evaluation={null}
        isSuperAdmin={false}
        setEvaluation={vi.fn()}
        sessionId="s1"
      />
    );
    fireEvent.click(screen.getByText("今すぐ評価を実行"));

    await waitFor(() => {
      expect(screen.getByText(/会話が短すぎるため評価対象外です/)).toBeTruthy();
    });
  });

  it("500: 内部エラー時は汎用の失敗文言を表示する", async () => {
    mockedAuthFetch.mockResolvedValue(jsonResponse(500, { error: "evaluation_failed" }));
    render(
      <JudgeEvaluationSection
        evaluation={null}
        isSuperAdmin={false}
        setEvaluation={vi.fn()}
        sessionId="s1"
      />
    );
    fireEvent.click(screen.getByText("今すぐ評価を実行"));

    await waitFor(() => {
      expect(screen.getByText(/評価の実行に失敗しました/)).toBeTruthy();
    });
  });

  it("実行中は連打してもリクエストが1回しか飛ばない", async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    mockedAuthFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );
    render(
      <JudgeEvaluationSection
        evaluation={null}
        isSuperAdmin={false}
        setEvaluation={vi.fn()}
        sessionId="s1"
      />
    );
    const button = screen.getByText("今すぐ評価を実行");
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(mockedAuthFetch).toHaveBeenCalledTimes(1);
    resolveFetch(jsonResponse(200, { evaluation: { id: 1, score: 90, evaluated_at: "2026-01-01T00:00:00Z" } }));
  });

  it("evaluation が存在する場合は実行ボタンを出さない", () => {
    const evaluation: Evaluation = {
      id: 1,
      score: 80,
      evaluated_at: "2026-01-01T00:00:00Z",
    };
    render(
      <JudgeEvaluationSection
        evaluation={evaluation}
        isSuperAdmin={false}
        setEvaluation={vi.fn()}
        sessionId="s1"
      />
    );
    expect(screen.queryByText("今すぐ評価を実行")).toBeNull();
  });
});
