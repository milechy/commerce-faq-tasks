// src/api/admin/avatar/fishVoiceModel.ts
//
// GID 1217084040137242: Fish Audio POST /model（永続音声モデル作成）の共通処理。
// voice-clone（実音声アップロード）と adopt-designed-voice（Voice Design候補の採用）の
// 両方から呼ばれる — Fish /model への書き込み経路を1箇所に集約し、重複実装を防ぐ。

export interface CreateFishVoiceModelParams {
  apiKey: string;
  title: string;
  audio: Buffer;
  mimeType: string;
  filename?: string;
}

export class FishVoiceModelError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "FishVoiceModelError";
    this.status = status;
  }
}

/**
 * Fish Audio POST /model で永続音声モデルを作成し、作成された _id を返す。
 * train_mode="fast" 固定（GID 1217084551565350: 公式APIの必須フィールド。
 * fast指定で作成直後から即座に利用可能なことを実APIで確認済み）。
 * 失敗時は FishVoiceModelError を投げる。エラー本文は呼び出し元のレスポンスに含めないこと。
 */
export async function createFishVoiceModel(
  params: CreateFishVoiceModelParams,
): Promise<string> {
  const { apiKey, title, audio, mimeType, filename } = params;

  const fd = new FormData();
  fd.append("visibility", "private");
  fd.append("type", "tts");
  fd.append("train_mode", "fast");
  fd.append("title", title);
  fd.append(
    "voices",
    new Blob([new Uint8Array(audio)], { type: mimeType }),
    filename || "voice-sample",
  );

  const fishRes = await fetch("https://api.fish.audio/model", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd,
  });

  if (!fishRes.ok) {
    const detail = await fishRes.text().catch(() => "");
    throw new FishVoiceModelError(
      `Fish Audio /model error ${fishRes.status}: ${detail.slice(0, 300)}`,
      fishRes.status,
    );
  }

  const fishData = (await fishRes.json()) as Record<string, unknown>;
  const voiceId = typeof fishData["_id"] === "string" ? fishData["_id"] : "";
  if (!voiceId) {
    throw new FishVoiceModelError("Fish Audio /model response has no _id");
  }

  return voiceId;
}
