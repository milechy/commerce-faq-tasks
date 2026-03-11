// tests/faqCrud.test.ts
// Phase30: FAQ CRUD API unit tests

import express from "express";
import type { Express } from "express";
import { registerFaqCrudRoutes } from "../src/api/admin/knowledge/faqCrudRoutes";

// ---------------------------------------------------------------------------
// Mock: embedText (openaiEmbeddingClient)
// ---------------------------------------------------------------------------
jest.mock("../src/agent/llm/openaiEmbeddingClient", () => ({
  embedText: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));

// ---------------------------------------------------------------------------
// Mock: global fetch for ES upsert / delete
// ---------------------------------------------------------------------------
const mockFetch = jest.fn().mockResolvedValue({ ok: true });
global.fetch = mockFetch as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Helpers: build a mock pg Pool
// ---------------------------------------------------------------------------
function makeMockDb(queryImpl: jest.Mock) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { query: queryImpl } as any;
}

// ---------------------------------------------------------------------------
// Helper: build minimal Express app with the routes registered
// ---------------------------------------------------------------------------
function buildApp(queryImpl: jest.Mock): Express {
  const app = express();
  app.use(express.json());
  const db = makeMockDb(queryImpl);
  registerFaqCrudRoutes(app, db);
  return app;
}

// ---------------------------------------------------------------------------
// Inline HTTP helper (avoids supertest dependency)
// Uses Node http module to send requests to the app's server
// ---------------------------------------------------------------------------
import * as http from "http";

function request(
  app: Express,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, () => {
      const addr = server.address() as { port: number };
      const port = addr.port;
      const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
      const reqHeaders: http.OutgoingHttpHeaders = {
        "x-tenant-id": "tenant-test",
        ...(opts.headers ?? {}),
      };
      if (bodyStr !== undefined) {
        reqHeaders["Content-Type"] = "application/json";
        reqHeaders["Content-Length"] = Buffer.byteLength(bodyStr);
      }
      const req = http.request(
        { hostname: "127.0.0.1", port, method, path, headers: reqHeaders },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            server.close();
            try {
              resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
            } catch {
              resolve({ status: res.statusCode ?? 0, body: data });
            }
          });
        }
      );
      req.on("error", (err) => {
        server.close();
        reject(err);
      });
      if (bodyStr !== undefined) req.write(bodyStr);
      req.end();
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /v1/admin/knowledge/faq", () => {
  it("returns paginated list with total", async () => {
    const fakeRow = {
      id: 1,
      tenant_id: "tenant-test",
      question: "Q1",
      answer: "A1",
      category: "inventory",
      tags: [],
      is_published: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const queryMock = jest
      .fn()
      // First call: COUNT
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      // Second call: SELECT items
      .mockResolvedValueOnce({ rows: [fakeRow] });

    const app = buildApp(queryMock);
    const res = await request(app, "GET", "/v1/admin/knowledge/faq");

    expect(res.status).toBe(200);
    const body = res.body as { items: unknown[]; total: number; limit: number; offset: number };
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  it("returns 400 when tenant header is missing", async () => {
    const queryMock = jest.fn();
    const app = buildApp(queryMock);
    const res = await request(app, "GET", "/v1/admin/knowledge/faq", { headers: { "x-tenant-id": "" } });
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/admin/knowledge/faq/:id", () => {
  it("returns 404 when FAQ not found", async () => {
    const queryMock = jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const app = buildApp(queryMock);
    const res = await request(app, "GET", "/v1/admin/knowledge/faq/999");
    expect(res.status).toBe(404);
    expect((res.body as { error: string }).error).toBe("FAQが見つかりません");
  });

  it("returns 403 on tenant mismatch", async () => {
    const queryMock = jest.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 1, tenant_id: "other-tenant", question: "Q", answer: "A" }],
    });
    const app = buildApp(queryMock);
    const res = await request(app, "GET", "/v1/admin/knowledge/faq/1");
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe("アクセス権限がありません");
  });

  it("returns the FAQ row when found and tenant matches", async () => {
    const fakeRow = {
      id: 1,
      tenant_id: "tenant-test",
      question: "Q1",
      answer: "A1",
      category: "campaign",
      tags: ["tag1"],
      is_published: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const queryMock = jest.fn().mockResolvedValueOnce({ rowCount: 1, rows: [fakeRow] });
    const app = buildApp(queryMock);
    const res = await request(app, "GET", "/v1/admin/knowledge/faq/1");
    expect(res.status).toBe(200);
    expect((res.body as { question: string }).question).toBe("Q1");
  });

  it("returns 400 for non-numeric id", async () => {
    const queryMock = jest.fn();
    const app = buildApp(queryMock);
    const res = await request(app, "GET", "/v1/admin/knowledge/faq/abc");
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/admin/knowledge/faq", () => {
  it("creates FAQ and returns 201", async () => {
    const createdRow = {
      id: 42,
      tenant_id: "tenant-test",
      question: "新しいQ",
      answer: "新しいA",
      category: "coupon",
      tags: [],
      is_published: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const queryMock = jest.fn().mockResolvedValueOnce({ rows: [createdRow] });
    const app = buildApp(queryMock);

    mockFetch.mockClear();

    const res = await request(app, "POST", "/v1/admin/knowledge/faq", {
      body: { question: "新しいQ", answer: "新しいA", category: "coupon" },
    });

    expect(res.status).toBe(201);
    expect((res.body as { id: number }).id).toBe(42);
    // At least one DB call should be the INSERT INTO faq_docs
    const insertCall = queryMock.mock.calls.find(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("INSERT INTO faq_docs")
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![0]).toContain("INSERT INTO faq_docs");
  });

  it("returns 400 on Zod validation failure", async () => {
    const queryMock = jest.fn();
    const app = buildApp(queryMock);
    // question too short (empty)
    const res = await request(app, "POST", "/v1/admin/knowledge/faq", {
      body: { question: "", answer: "A" },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("invalid_request");
  });

  it("returns 400 when tenant is missing", async () => {
    const queryMock = jest.fn();
    const app = buildApp(queryMock);
    const res = await request(app, "POST", "/v1/admin/knowledge/faq", {
      headers: { "x-tenant-id": "" },
      body: { question: "Q", answer: "A" },
    });
    expect(res.status).toBe(400);
  });
});

describe("PUT /v1/admin/knowledge/faq/:id", () => {
  it("returns 404 when FAQ not found", async () => {
    const queryMock = jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const app = buildApp(queryMock);
    const res = await request(app, "PUT", "/v1/admin/knowledge/faq/999", {
      body: { question: "Q", answer: "A" },
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 on tenant mismatch", async () => {
    const queryMock = jest.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 1, tenant_id: "other-tenant" }],
    });
    const app = buildApp(queryMock);
    const res = await request(app, "PUT", "/v1/admin/knowledge/faq/1", {
      body: { question: "Q", answer: "A" },
    });
    expect(res.status).toBe(403);
  });

  it("updates FAQ and returns updated row", async () => {
    const updatedRow = {
      id: 1,
      tenant_id: "tenant-test",
      question: "Updated Q",
      answer: "Updated A",
      category: "store_info",
      tags: ["t1"],
      is_published: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const queryMock = jest
      .fn()
      // 1st: SELECT check
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 1, tenant_id: "tenant-test" }] })
      // 2nd: UPDATE RETURNING
      .mockResolvedValueOnce({ rows: [updatedRow] })
      // 3rd: DELETE embeddings
      .mockResolvedValueOnce({ rowCount: 0 });

    const app = buildApp(queryMock);
    const res = await request(app, "PUT", "/v1/admin/knowledge/faq/1", {
      body: { question: "Updated Q", answer: "Updated A", category: "store_info", is_published: false },
    });

    expect(res.status).toBe(200);
    expect((res.body as { question: string }).question).toBe("Updated Q");
  });

  it("returns 400 for non-numeric id", async () => {
    const queryMock = jest.fn();
    const app = buildApp(queryMock);
    const res = await request(app, "PUT", "/v1/admin/knowledge/faq/abc", {
      body: { question: "Q", answer: "A" },
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /v1/admin/knowledge/faq/:id", () => {
  it("deletes FAQ and returns { ok: true, id }", async () => {
    const queryMock = jest
      .fn()
      // 1st: SELECT check
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 5, tenant_id: "tenant-test" }] })
      // 2nd: DELETE faq_embeddings
      .mockResolvedValueOnce({ rowCount: 0 })
      // 3rd: DELETE faq_docs
      .mockResolvedValueOnce({ rowCount: 1 });

    const app = buildApp(queryMock);
    const res = await request(app, "DELETE", "/v1/admin/knowledge/faq/5");

    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; id: number };
    expect(body.ok).toBe(true);
    expect(body.id).toBe(5);
  });

  it("returns 404 when FAQ not found", async () => {
    const queryMock = jest.fn().mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const app = buildApp(queryMock);
    const res = await request(app, "DELETE", "/v1/admin/knowledge/faq/404");
    expect(res.status).toBe(404);
  });

  it("returns 403 on tenant mismatch", async () => {
    const queryMock = jest.fn().mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 1, tenant_id: "other-tenant" }],
    });
    const app = buildApp(queryMock);
    const res = await request(app, "DELETE", "/v1/admin/knowledge/faq/1");
    expect(res.status).toBe(403);
  });

  it("returns 400 when tenant is missing", async () => {
    const queryMock = jest.fn();
    const app = buildApp(queryMock);
    const res = await request(app, "DELETE", "/v1/admin/knowledge/faq/1", {
      headers: { "x-tenant-id": "" },
    });
    expect(res.status).toBe(400);
  });
});
