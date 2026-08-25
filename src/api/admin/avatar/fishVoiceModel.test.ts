// src/api/admin/avatar/fishVoiceModel.test.ts

import { createFishVoiceModel, FishVoiceModelError, adoptVoiceForConfig } from "./fishVoiceModel";
import { logger } from "../../../lib/logger";

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

describe("createFishVoiceModel", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("正常系: Fish Audio /model が201+_idを返すとvoiceIdを返す", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ _id: "fish-voice-abc123" }),
    });

    const voiceId = await createFishVoiceModel({
      apiKey: "test-key",
      title: "マイボイス",
      audio: Buffer.from("dummy-audio-bytes"),
      mimeType: "audio/wav",
      filename: "voice.wav",
    });

    expect(voiceId).toBe("fish-voice-abc123");

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.fish.audio/model");
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);
    const fd = init.body as FormData;
    expect(fd.get("visibility")).toBe("private");
    expect(fd.get("type")).toBe("tts");
    // GID 1217084551565350: train_mode欠落は422を招く実害バグの回帰ガード
    expect(fd.get("train_mode")).toBe("fast");
    expect(fd.get("title")).toBe("マイボイス");
    expect(fd.get("voices")).toBeTruthy();
  });

  it("4xxエラー: Fish Audio APIが失敗するとFishVoiceModelErrorを投げる", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      text: async () => '{"type":"missing","loc":["train_mode"]}',
    });

    await expect(
      createFishVoiceModel({
        apiKey: "test-key",
        title: "マイボイス",
        audio: Buffer.from("dummy"),
        mimeType: "audio/wav",
      }),
    ).rejects.toMatchObject({
      name: "FishVoiceModelError",
      status: 422,
    });
  });

  it("_id欠落: 200番台でも_idが無ければFishVoiceModelErrorを投げる", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ title: "no id here" }),
    });

    await expect(
      createFishVoiceModel({
        apiKey: "test-key",
        title: "マイボイス",
        audio: Buffer.from("dummy"),
        mimeType: "audio/wav",
      }),
    ).rejects.toThrow(FishVoiceModelError);
  });

  it("filename省略時は voice-sample がデフォルトのファイル名になる", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ _id: "fish-voice-xyz" }),
    });

    await createFishVoiceModel({
      apiKey: "test-key",
      title: "マイボイス",
      audio: Buffer.from("dummy"),
      mimeType: "audio/wav",
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const fd = init.body as FormData;
    const voicesEntry = fd.get("voices") as File;
    expect(voicesEntry.name).toBe("voice-sample");
  });

  // ── イレギュラー入力: 呼び出し元(routes.ts)がガードせず渡してきた場合 ──────
  // このヘルパー自体は音声サイズ・空バッファのバリデーションを一切行わない
  // (multerのfileSize上限のみが唯一の防御線)ことを明示的に固定する。
  it("0バイトの音声バッファでもクラッシュせずFish Audioへ送信を試みる(サイズ検証はこの層の責務外)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ _id: "fish-voice-empty" }),
    });

    const voiceId = await createFishVoiceModel({
      apiKey: "test-key",
      title: "空の音声",
      audio: Buffer.alloc(0),
      mimeType: "audio/wav",
    });

    expect(voiceId).toBe("fish-voice-empty");
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const fd = init.body as FormData;
    const voicesEntry = fd.get("voices") as File;
    expect(voicesEntry.size).toBe(0);
  });

  it("_idが文字列でない場合(数値型)は欠落扱いでFishVoiceModelErrorを投げる", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ _id: 12345 }),
    });

    await expect(
      createFishVoiceModel({
        apiKey: "test-key",
        title: "マイボイス",
        audio: Buffer.from("dummy"),
        mimeType: "audio/wav",
      }),
    ).rejects.toThrow(FishVoiceModelError);
  });

  it("_idが空文字列の場合も欠落扱いでFishVoiceModelErrorを投げる", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({ _id: "" }),
    });

    await expect(
      createFishVoiceModel({
        apiKey: "test-key",
        title: "マイボイス",
        audio: Buffer.from("dummy"),
        mimeType: "audio/wav",
      }),
    ).rejects.toThrow(FishVoiceModelError);
  });

  it("HTTP 200(201以外の成功コード)でも_idがあれば成功として扱う(厳密な201チェックはしていない)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ _id: "fish-voice-200" }),
    });

    const voiceId = await createFishVoiceModel({
      apiKey: "test-key",
      title: "マイボイス",
      audio: Buffer.from("dummy"),
      mimeType: "audio/wav",
    });

    expect(voiceId).toBe("fish-voice-200");
  });

  // ── 呼び出し元が想定すべき「このヘルパーがラップしない」失敗モード ──────
  it("Fish Audioが200を返すが本文がJSONとしてパースできない場合、素のErrorが伝播する(FishVoiceModelErrorではない)", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => {
        throw new SyntaxError("Unexpected token in JSON");
      },
    });

    await expect(
      createFishVoiceModel({
        apiKey: "test-key",
        title: "マイボイス",
        audio: Buffer.from("dummy"),
        mimeType: "audio/wav",
      }),
    ).rejects.not.toBeInstanceOf(FishVoiceModelError);
  });

  it("fetch自体が例外を投げる(ネットワーク断)場合、素のErrorが伝播する(呼び出し元のtry/catchに委ねる設計)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));

    await expect(
      createFishVoiceModel({
        apiKey: "test-key",
        title: "マイボイス",
        audio: Buffer.from("dummy"),
        mimeType: "audio/wav",
      }),
    ).rejects.toThrow("ECONNRESET");
  });
});

// GID: voice-clone/adopt-designed-voiceの二重送信(二重課金)防止のための
// トランザクション処理。ルートレベルの統合テスト(routes.test.ts)ではHTTP経由で
// 到達しにくい「コネクション解放の保証」「ROLLBACK自体が失敗する二重障害」を
// ここで直接検証する。
describe("adoptVoiceForConfig", () => {
  function makeTxDb(clientQueryImpl: (sql: string, values?: unknown[]) => Promise<any>) {
    const clientQuery = jest.fn(clientQueryImpl);
    const release = jest.fn();
    const connect = jest.fn().mockResolvedValue({ query: clientQuery, release });
    return { db: { connect }, clientQuery, release };
  }

  const baseParams = {
    configId: "config-1",
    tenantId: "tenant-a",
    isSuperAdmin: false,
    fishApiKey: "test-key",
    title: "マイボイス",
    audio: Buffer.from("dummy"),
    mimeType: "audio/wav",
    logEventPrefix: "voice_clone" as const,
    logContext: "[test] voice-clone",
  };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("正常系: SELECT FOR UPDATE → Fish呼び出し → UPDATE → COMMITの順に実行し、コネクションを解放する", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ _id: "fish-voice-1" }) });
    const { db, clientQuery, release } = makeTxDb(async (sql) => {
      if (sql.startsWith("SELECT id, tenant_id FROM avatar_configs")) return { rows: [{ id: "config-1", tenant_id: "tenant-a" }] };
      if (sql.startsWith("UPDATE avatar_configs")) return { rows: [], rowCount: 1 };
      return { rows: [] };
    });

    const result = await adoptVoiceForConfig({ ...baseParams, db });

    expect(result).toEqual({ ok: true, voiceId: "fish-voice-1", tenantId: "tenant-a" });
    expect(clientQuery.mock.calls.map((c) => c[0])).toEqual([
      "BEGIN",
      "SET LOCAL lock_timeout = '3s'",
      expect.stringContaining("FOR UPDATE"),
      expect.stringContaining("UPDATE avatar_configs"),
      "COMMIT",
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  // GID 1217808323836843: super_admin はJWTにtenant_idを持たずparams.tenantIdが
  // 空文字になりうる。この場合でも対象configの実tenant_idを返し、trackUsageが
  // tenant_id='unknown'で計上されないようにする。
  it("super_admin かつ params.tenantId が空文字でも、config行から解決した実tenantIdを返す", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ _id: "fish-voice-su" }) });
    const { db } = makeTxDb(async (sql) => {
      if (sql.startsWith("SELECT id, tenant_id FROM avatar_configs")) {
        return { rows: [{ id: "config-1", tenant_id: "tenant-b" }] };
      }
      if (sql.startsWith("UPDATE avatar_configs")) return { rows: [], rowCount: 1 };
      return { rows: [] };
    });

    const result = await adoptVoiceForConfig({
      ...baseParams,
      tenantId: "",
      isSuperAdmin: true,
      db,
    });

    expect(result).toEqual({ ok: true, voiceId: "fish-voice-su", tenantId: "tenant-b" });
  });

  // GID: レビュー指摘 — Fish側の生成成功後にUPDATEが失敗すると、課金済みの永続モデルが
  // どこにも記録されず孤児化する。UPDATE試行前にvoiceIdをログすることを固定する。
  it("Fish呼び出し成功後、UPDATE実行前にvoiceIdをログする(UPDATE失敗時の孤児追跡用)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ _id: "fish-voice-2" }) });
    const infoSpy = jest.spyOn(logger, "info").mockImplementation(() => {});
    const { db } = makeTxDb(async (sql) => {
      if (sql.startsWith("SELECT id, tenant_id FROM avatar_configs")) return { rows: [{ id: "config-1", tenant_id: "tenant-a" }] };
      if (sql.startsWith("UPDATE avatar_configs")) return { rows: [], rowCount: 1 };
      return { rows: [] };
    });

    await adoptVoiceForConfig({ ...baseParams, db });

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "voice_clone_voice_created", voiceId: "fish-voice-2", configId: "config-1" }),
      expect.any(String),
    );
    infoSpy.mockRestore();
  });

  // UPDATEが(0件更新ではなく)例外で失敗するケース。対象行は直前のSELECT...FOR UPDATEで
  // 既にロック済みのため0件更新は起こり得ない。例外時は呼び出し元の500ハンドリングに委ね、
  // Fish側に残った孤児モデルの追跡は直前のvoiceIdログに依存する。
  it("UPDATEが例外を投げた場合、Fish側は既に成功しているが呼び出し元に例外を伝播しコネクションは解放する", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ _id: "fish-voice-3" }) });
    const { db, release } = makeTxDb(async (sql) => {
      if (sql.startsWith("SELECT id, tenant_id FROM avatar_configs")) return { rows: [{ id: "config-1", tenant_id: "tenant-a" }] };
      if (sql.startsWith("UPDATE avatar_configs")) throw new Error("connection terminated unexpectedly");
      if (sql === "ROLLBACK") return { rows: [] };
      return { rows: [] };
    });

    await expect(adoptVoiceForConfig({ ...baseParams, db })).rejects.toThrow(
      "connection terminated unexpectedly",
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("Fish呼び出し失敗時もコネクションを解放する(接続リーク防止)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "error" });
    const { db, release } = makeTxDb(async (sql) => {
      if (sql.startsWith("SELECT id, tenant_id FROM avatar_configs")) return { rows: [{ id: "config-1", tenant_id: "tenant-a" }] };
      return { rows: [] };
    });

    const result = await adoptVoiceForConfig({ ...baseParams, db });

    expect(result.ok).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("設定が見つからない場合、404を返しFishを一切呼ばない", async () => {
    const { db } = makeTxDb(async (sql) => {
      if (sql.startsWith("SELECT id, tenant_id FROM avatar_configs")) return { rows: [] };
      return { rows: [] };
    });

    const result = await adoptVoiceForConfig({ ...baseParams, db });

    expect(result).toEqual({ ok: false, status: 404, error: "設定が見つからないかアクセス権限がありません" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("ロックタイムアウトは409を返し、logEventPrefixごとに正しい汎用メッセージにフォールバックする(adopt-designed-voice側)", async () => {
    const { db } = makeTxDb(async (sql) => {
      if (sql.startsWith("SELECT id, tenant_id FROM avatar_configs")) throw new Error("canceling statement due to lock timeout");
      return { rows: [] };
    });

    const result = await adoptVoiceForConfig({
      ...baseParams,
      db,
      logEventPrefix: "adopt_designed_voice",
    });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "この設定は現在別の操作を処理中です。少し待ってからもう一度お試しください",
    });
  });

  // 二重障害: ロック取得に失敗した直後、ROLLBACK自体もコネクション断等で失敗するケース。
  // .catch(() => {}) で握りつぶさないと、本来のエラー(lock timeout起因の409判定)より
  // ROLLBACK失敗のエラーが優先されてしまい、呼び出し元が500として扱ってしまう。
  it("二重障害: ROLLBACK自体が失敗しても、元のロックタイムアウト起因の409判定を優先する", async () => {
    const { db, release } = makeTxDb(async (sql) => {
      if (sql.startsWith("SELECT id, tenant_id FROM avatar_configs")) throw new Error("canceling statement due to lock timeout");
      if (sql === "ROLLBACK") throw new Error("connection terminated unexpectedly");
      return { rows: [] };
    });

    const result = await adoptVoiceForConfig({ ...baseParams, db });

    expect(result).toEqual({
      ok: false,
      status: 409,
      error: "この設定は現在別の操作を処理中です。少し待ってからもう一度お試しください",
    });
    // ROLLBACK失敗時もコネクションは必ず解放される(finally節)
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("ロックタイムアウトでも予期しないDBエラー(接続断等)でもない場合は、呼び出し元に例外を投げる(既存の500ハンドリングに委ねる)", async () => {
    const { db, release } = makeTxDb(async (sql) => {
      if (sql.startsWith("SELECT id, tenant_id FROM avatar_configs")) throw new Error("relation \"avatar_configs\" does not exist");
      if (sql === "ROLLBACK") return { rows: [] };
      return { rows: [] };
    });

    await expect(adoptVoiceForConfig({ ...baseParams, db })).rejects.toThrow(
      'relation "avatar_configs" does not exist',
    );
    expect(release).toHaveBeenCalledTimes(1);
  });
});
