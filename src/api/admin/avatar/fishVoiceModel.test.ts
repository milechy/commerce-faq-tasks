// src/api/admin/avatar/fishVoiceModel.test.ts

import { createFishVoiceModel, FishVoiceModelError } from "./fishVoiceModel";

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
