// tests/api/middleware/langDetect.test.ts
// Phase33: 言語検出ミドルウェアのテスト

import { langDetectMiddleware } from "../../../src/api/middleware/langDetect";

function makeReq(overrides: Record<string, any> = {}): any {
  return {
    query: {},
    headers: {},
    ...overrides,
  };
}

const res = {} as any;
const next = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
});

describe("langDetectMiddleware", () => {
  test("?lang=ja sets req.lang to ja", () => {
    const req = makeReq({ query: { lang: "ja" } });
    langDetectMiddleware(req, res, next);
    expect(req.lang).toBe("ja");
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("?lang=en sets req.lang to en", () => {
    const req = makeReq({ query: { lang: "en" } });
    langDetectMiddleware(req, res, next);
    expect(req.lang).toBe("en");
  });

  test("unknown ?lang falls through to Accept-Language", () => {
    const req = makeReq({
      query: { lang: "fr" },
      headers: { "accept-language": "en-US,en;q=0.9" },
    });
    langDetectMiddleware(req, res, next);
    expect(req.lang).toBe("en");
  });

  test("Accept-Language: en-US picks en", () => {
    const req = makeReq({ headers: { "accept-language": "en-US,en;q=0.9,ja;q=0.8" } });
    langDetectMiddleware(req, res, next);
    expect(req.lang).toBe("en");
  });

  test("Accept-Language: ja picks ja", () => {
    const req = makeReq({ headers: { "accept-language": "ja,en;q=0.9" } });
    langDetectMiddleware(req, res, next);
    expect(req.lang).toBe("ja");
  });

  test("Accept-Language with only unsupported lang falls back to ja", () => {
    const req = makeReq({ headers: { "accept-language": "fr,de;q=0.8" } });
    langDetectMiddleware(req, res, next);
    expect(req.lang).toBe("ja");
  });

  test("tenantConfig.defaultLang=en is used when no query/header", () => {
    const req = makeReq({}) as any;
    req.tenantConfig = { defaultLang: "en" };
    langDetectMiddleware(req, res, next);
    expect(req.lang).toBe("en");
  });

  test("fallback to ja when nothing is set", () => {
    const req = makeReq();
    langDetectMiddleware(req, res, next);
    expect(req.lang).toBe("ja");
  });

  test("?lang is case-insensitive", () => {
    const req = makeReq({ query: { lang: "EN" } });
    langDetectMiddleware(req, res, next);
    expect(req.lang).toBe("en");
  });

  test("always calls next()", () => {
    const req = makeReq();
    langDetectMiddleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
