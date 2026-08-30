// src/agent/memory/learnedMemoryRepository.test.ts
// Phase71-A: learnedMemoryRepository テスト (fake pool 注入)

import { createLearnedMemoryRepository } from "./learnedMemoryRepository";

type QueryMock = jest.Mock<Promise<{ rows: unknown[] }>, [string, unknown[]?]>;

function makePool(queryMock: QueryMock) {
  // createLearnedMemoryRepository は pg.Pool を期待するが、テストでは query だけ使う
  return { query: queryMock } as unknown as Parameters<
    typeof createLearnedMemoryRepository
  >[0];
}

describe("saveLearnedMemory", () => {
  it("INSERT を発行し、挿入されたら true", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [{ id: 1 }] });
    const repo = createLearnedMemoryRepository(makePool(query));

    const inserted = await repo.saveLearnedMemory({
      tenantId: "carnation",
      question: "保証はありますか",
      answer: "全車3ヶ月保証付きです",
      embedding: [0.1, 0.2, 0.3],
      sourceSessionId: "sess-1",
      judgeScore: 88,
    });

    expect(inserted).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, args] = query.mock.calls[0]!;
    expect(sql).toContain("INSERT INTO learned_memory");
    expect(sql).toContain("ON CONFLICT (tenant_id, source_session_id) DO NOTHING");
    // embedding は pgvector リテラル形式
    expect(args![3]).toBe("[0.1,0.2,0.3]");
    expect(args![0]).toBe("carnation");
    expect(args![5]).toBe(88);
  });

  it("ON CONFLICT で行が返らなければ false (重複スキップ)", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [] });
    const repo = createLearnedMemoryRepository(makePool(query));

    const inserted = await repo.saveLearnedMemory({
      tenantId: "carnation",
      question: "q",
      answer: "a",
      embedding: [0.1],
      sourceSessionId: "sess-dup",
      judgeScore: 90,
    });

    expect(inserted).toBe(false);
  });
});

describe("searchLearnedMemory", () => {
  it("空 embedding は DB を叩かず空配列", async () => {
    const query: QueryMock = jest.fn();
    const repo = createLearnedMemoryRepository(makePool(query));

    const hits = await repo.searchLearnedMemory({
      tenantId: "carnation",
      embedding: [],
    });

    expect(hits).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("tenant_id 単独フィルタ + is_active で検索し、weight を score に掛ける", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({
      rows: [
        {
          id: "10",
          question: "保証はありますか",
          answer: "全車3ヶ月保証付きです",
          judge_score: 88,
          source_session_id: "sess-1",
          score: 0.8,
        },
      ],
    });
    const repo = createLearnedMemoryRepository(makePool(query));

    const hits = await repo.searchLearnedMemory({
      tenantId: "carnation",
      embedding: [0.1, 0.2],
      topK: 3,
      weight: 0.9,
    });

    const [sql, args] = query.mock.calls[0]!;
    // テナント横断しない (global を含めない)
    expect(sql).toContain("tenant_id = $2");
    expect(sql).not.toContain("'global'");
    expect(sql).toContain("is_active = true");
    expect(args).toEqual(["[0.1,0.2]", "carnation", 3]);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe("learned:10");
    expect(hits[0]!.text).toBe("全車3ヶ月保証付きです"); // answer を本文に
    expect(hits[0]!.source).toBe("learned");
    expect(hits[0]!.score).toBeCloseTo(0.72, 5); // 0.8 * 0.9
    expect(hits[0]!.metadata.source).toBe("learned");
    expect(hits[0]!.metadata.question).toBe("保証はありますか");
    expect(hits[0]!.metadata.judge_score).toBe(88);
  });

  it("score は 0-1 にクランプしてから weight を掛ける", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({
      rows: [
        {
          id: "11",
          question: "q",
          answer: "a",
          judge_score: 95,
          source_session_id: "s",
          score: 1.5, // 異常値
        },
      ],
    });
    const repo = createLearnedMemoryRepository(makePool(query));

    const hits = await repo.searchLearnedMemory({
      tenantId: "carnation",
      embedding: [0.1],
      weight: 1,
    });

    expect(hits[0]!.score).toBe(1); // clamp(1.5)=1 * 1
  });
});

describe("テナント境界 (越境防止)", () => {
  // PR #1108 で isLearnedMemoryReadEnabled から allowlist 判定を外したため、
  // learned_memory の読み出しは全テナントで有効になった。
  // 以後は WHERE tenant_id = $2 (このリポジトリの手書き述語) だけがテナント境界。
  // 1 箇所欠落すれば即座に全面リークになるため、ここで固定する。

  it("searchLearnedMemory は SQL にテナント述語を持ち、渡した tenantId をパラメータとして渡す", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [] });
    const repo = createLearnedMemoryRepository(makePool(query));

    await repo.searchLearnedMemory({
      tenantId: "carnation",
      embedding: [0.1, 0.2],
    });

    const [sql, args] = query.mock.calls[0]!;
    expect(sql).toContain("tenant_id = $2");
    expect(args![1]).toBe("carnation");
  });

  it("テナントAで検索した場合、テナントBの行は返らない", async () => {
    // fake pool: 実 DB の代わりに、送られた SQL が実際に
    // tenant_id 述語を含んでいる場合のみテナントでフィルタする。
    // 述語が抜け落ちる (= WHERE 1=1 化される) と全テナントの行が
    // そのまま返ってくる、という Postgres の実挙動を模している。
    const rows = [
      {
        id: "1",
        question: "Aの質問",
        answer: "Aの回答",
        judge_score: 90,
        source_session_id: "sess-a",
        score: 0.9,
        tenant_id: "tenant-a",
      },
      {
        id: "2",
        question: "Bの質問",
        answer: "Bの回答",
        judge_score: 90,
        source_session_id: "sess-b",
        score: 0.9,
        tenant_id: "tenant-b",
      },
    ];
    const query: QueryMock = jest.fn().mockImplementation((sql: string, args?: unknown[]) => {
      const hasTenantPredicate = sql.includes("tenant_id = $2");
      const tenantId = args?.[1];
      const visibleRows = hasTenantPredicate
        ? rows.filter((row) => row.tenant_id === tenantId)
        : rows; // 述語欠落時は Postgres と同様に全行が見えてしまう
      return Promise.resolve({ rows: visibleRows });
    });
    const repo = createLearnedMemoryRepository(makePool(query));

    const hits = await repo.searchLearnedMemory({
      tenantId: "tenant-a",
      embedding: [0.1],
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.metadata.question).toBe("Aの質問");
    expect(hits.some((hit) => hit.metadata.question === "Bの質問")).toBe(false);
  });

  it("saveLearnedMemory の ON CONFLICT キーに tenant_id が含まれる (重複判定もテナント単位)", async () => {
    const query: QueryMock = jest.fn().mockResolvedValue({ rows: [{ id: 1 }] });
    const repo = createLearnedMemoryRepository(makePool(query));

    await repo.saveLearnedMemory({
      tenantId: "tenant-a",
      question: "q",
      answer: "a",
      embedding: [0.1],
      sourceSessionId: "sess-shared",
      judgeScore: 90,
    });

    const [sql, args] = query.mock.calls[0]!;
    expect(sql).toContain("ON CONFLICT (tenant_id, source_session_id)");
    expect(args![0]).toBe("tenant-a");
  });
});
