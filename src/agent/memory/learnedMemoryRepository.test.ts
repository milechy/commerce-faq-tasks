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
