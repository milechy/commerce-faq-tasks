import type { NextFunction, Request, Response } from "express";
import { requestIdMiddleware } from "./request-id";

function mockReq(headers: Record<string, unknown> = {}): Request {
  return { headers } as unknown as Request;
}

function mockRes() {
  const res: Partial<Response> & { headers: Record<string, string> } = {
    headers: {},
  };
  res.setHeader = jest.fn((name: string, value: string) => {
    res.headers[name] = value;
    return res as Response;
  }) as unknown as Response["setHeader"];
  return res as Response & { headers: Record<string, string> };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("requestIdMiddleware", () => {
  it("受信ヘッダが無い場合はサーバ新規採番する", () => {
    const req = mockReq();
    const res = mockRes();
    const next = jest.fn() as unknown as NextFunction;

    requestIdMiddleware(req, res, next);

    expect(req.requestId).toMatch(UUID_RE);
    expect(res.headers["x-request-id"]).toBe(req.requestId);
    expect(req.clientTraceId).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("[P0] 受信 X-Request-ID を req.requestId に再利用しない（課金dedupキーをクライアントに握らせない）", () => {
    const clientId = "attacker-fixed-id";
    const req = mockReq({ "x-request-id": clientId });
    const res = mockRes();

    requestIdMiddleware(req, res, jest.fn() as unknown as NextFunction);

    expect(req.requestId).not.toBe(clientId);
    expect(req.requestId).toMatch(UUID_RE);
    // レスポンスにもサーバ採番IDを返す（受信値のエコーバックはしない）
    expect(res.headers["x-request-id"]).toBe(req.requestId);
    expect(res.headers["x-request-id"]).not.toBe(clientId);
  });

  it("受信 X-Request-ID はトレース相関用に clientTraceId としてのみ保持する", () => {
    const clientId = "upstream-lb-trace-123";
    const req = mockReq({ "x-request-id": clientId });
    const res = mockRes();

    requestIdMiddleware(req, res, jest.fn() as unknown as NextFunction);

    expect(req.clientTraceId).toBe(clientId);
    // clientTraceId は識別/課金には使わない値であり、requestId とは別物
    expect(req.clientTraceId).not.toBe(req.requestId);
  });

  it("[P0] 同一クライアントIDを固定して連投しても、各回のサーバ採番 request_id は毎回異なる（各回が計上対象になり計上すり抜け不可）", () => {
    const clientId = "same-fixed-id-every-time";
    const ids = new Set<string>();

    for (let i = 0; i < 50; i++) {
      const req = mockReq({ "x-request-id": clientId });
      requestIdMiddleware(
        req,
        mockRes(),
        jest.fn() as unknown as NextFunction,
      );
      ids.add(req.requestId);
    }

    // 固定ヘッダでも request_id は毎回ユニーク → usage_logs の
    // UNIQUE + ON CONFLICT DO NOTHING で握り潰されず各回INSERTされる
    expect(ids.size).toBe(50);
  });

  it("正当なリトライ（別々のHTTPリクエスト）は各回独立のIDを得る＝各回のLLM呼び出しを正しく計上できる", () => {
    // 会話単位の請求は session_id グルーピングで担保されるため（本ミドルウェアは非関与）、
    // request_id が毎回ユニークでも会話ベースの請求額は増えない。ここでは
    // 「リクエスト単位の計上が取りこぼされない」ことのみを担保する。
    const reqA = mockReq();
    const reqB = mockReq();
    requestIdMiddleware(reqA, mockRes(), jest.fn() as unknown as NextFunction);
    requestIdMiddleware(reqB, mockRes(), jest.fn() as unknown as NextFunction);

    expect(reqA.requestId).not.toBe(reqB.requestId);
  });

  it("長大な受信 X-Request-ID は clientTraceId で切り詰める（ログ肥大化/注入の緩和）", () => {
    const huge = "x".repeat(5000);
    const req = mockReq({ "x-request-id": huge });

    requestIdMiddleware(req, mockRes(), jest.fn() as unknown as NextFunction);

    expect(req.clientTraceId!.length).toBeLessThanOrEqual(200);
    // requestId は受信値に依存しない
    expect(req.requestId).toMatch(UUID_RE);
  });

  it("配列で複数の X-Request-ID が来ても req.requestId は受信値を採用しない", () => {
    // Express は同名ヘッダ複数時に string[] を渡すことがある。string 以外は無視する。
    const req = mockReq({ "x-request-id": ["a", "b"] });

    requestIdMiddleware(req, mockRes(), jest.fn() as unknown as NextFunction);

    expect(req.requestId).toMatch(UUID_RE);
    expect(req.requestId).not.toBe("a");
    expect(req.clientTraceId).toBeUndefined();
  });
});
