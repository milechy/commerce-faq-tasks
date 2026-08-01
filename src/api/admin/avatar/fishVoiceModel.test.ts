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
});
