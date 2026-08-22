import { buildTenantSessionKey } from "./sessionKey";

describe("buildTenantSessionKey", () => {
  it("tenantIdとsessionIdを`::`で連結する", () => {
    expect(buildTenantSessionKey("tenant-a", "session-1")).toBe("tenant-a::session-1");
  });

  it("tenantIdに`::`が含まれる場合は例外を投げる", () => {
    expect(() => buildTenantSessionKey("A::B", "C")).toThrow(/tenantId must not contain/);
  });

  it("sessionIdに`::`が含まれてもtenantIdがコロンを含まなければ例外を投げない（境界はtenantId側の不変条件で守られる）", () => {
    expect(buildTenantSessionKey("A", "B::C")).toBe("A::B::C");
  });

  it("tenantIdの単一コロンは許可する（`::`の二重コロンのみを検知する）", () => {
    expect(buildTenantSessionKey("tenant:demo", "s1")).toBe("tenant:demo::s1");
  });
});

describe("キー生成の一本化 — 3ストアすべてが buildTenantSessionKey を経由する", () => {
  // contextStore / salesContextStore は PR #819 で統一済み。
  // flowContextStore だけが生のテンプレートリテラルのまま取り残されており
  // （CLAUDE.md禁止事項6「同じ関心事を複製したまま片方だけ直す」の再発）、
  // ここで3つ目も同じ不変条件に乗ったことを固定する。
  it("flowContextStore: tenantIdに`::`が含まれる場合は例外を投げる", () => {
    const {
      getOrInitFlowSessionMeta,
      peekFlowSessionMeta,
      setFlowSessionMeta,
      resetFlowSessionMeta,
    } = require("./flowContextStore");

    const badKey = { tenantId: "A::B", conversationId: "C" };

    expect(() => getOrInitFlowSessionMeta(badKey)).toThrow(
      /tenantId must not contain/
    );
    expect(() => peekFlowSessionMeta(badKey)).toThrow(
      /tenantId must not contain/
    );
    expect(() => resetFlowSessionMeta(badKey)).toThrow(
      /tenantId must not contain/
    );
    expect(() =>
      setFlowSessionMeta(badKey, {
        state: "answer",
        turnIndex: 0,
        sameStateRepeats: 0,
        clarifyRepeats: 0,
        confirmRepeats: 0,
        recentStates: [],
        lastUpdatedAt: new Date().toISOString(),
      })
    ).toThrow(/tenantId must not contain/);
  });

  it("flowContextStore: 通常のtenantId/conversationIdは従来どおり動作し、テナント間で分離される", () => {
    const {
      getOrInitFlowSessionMeta,
      setFlowSessionMeta,
      peekFlowSessionMeta,
    } = require("./flowContextStore");

    const a = { tenantId: "tenant-a", conversationId: "shared-conv" };
    const b = { tenantId: "tenant-b", conversationId: "shared-conv" };

    const metaA = getOrInitFlowSessionMeta(a);
    setFlowSessionMeta(a, { ...metaA, state: "confirm", turnIndex: 3 });
    getOrInitFlowSessionMeta(b);

    expect(peekFlowSessionMeta(a)?.state).toBe("confirm");
    expect(peekFlowSessionMeta(a)?.turnIndex).toBe(3);
    // 同一 conversationId でも別テナントの状態は汚染されない
    expect(peekFlowSessionMeta(b)?.state).toBe("answer");
    expect(peekFlowSessionMeta(b)?.turnIndex).toBe(0);
  });
});
