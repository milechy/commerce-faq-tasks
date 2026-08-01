// src/api/admin/avatar/fishVoiceModel.ts
//
// GID 1217084040137242: Fish Audio POST /model（永続音声モデル作成）の共通処理。
// voice-clone（実音声アップロード）と adopt-designed-voice（Voice Design候補の採用）の
// 両方から呼ばれる — Fish /model への書き込み経路を1箇所に集約し、重複実装を防ぐ。

import { logger } from "../../../lib/logger";

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

export interface AdoptVoiceForConfigParams {
  /** db.connect() を持つプール（routes.ts の activate エンドポイントと同じ注入パターン） */
  db: { connect(): Promise<{ query: (sql: string, values?: unknown[]) => Promise<any>; release(): void }> };
  configId: string;
  tenantId: string;
  isSuperAdmin: boolean;
  fishApiKey: string;
  title: string;
  audio: Buffer;
  mimeType: string;
  filename?: string;
  /** ログイベント名の接頭辞。呼び出し元ごとに区別する */
  logEventPrefix: AdoptVoiceLogEventPrefix;
  logContext: string;
}

/** adoptVoiceForConfig の呼び出し元識別子。genericErrorの分岐にも使うため、タイポ時に
 *  誤ったエラーメッセージへ無言でフォールバックしないようリテラルユニオン型で固定する。 */
export type AdoptVoiceLogEventPrefix = "voice_clone" | "adopt_designed_voice";

export type AdoptVoiceForConfigResult =
  | { ok: true; voiceId: string }
  | { ok: false; status: 404 | 409 | 502; error: string };

/**
 * GID: voice-clone/adopt-designed-voiceの重複実装を避けるための共通トランザクション処理。
 *
 * 【解決している問題】connectAvatarConfigの所有権チェックとFish /model呼び出し・voice_id保存が
 * 単純なquery()の連続だったため、同じconfigへ2回連続でリクエストされる(二重クリック・複数タブ・
 * リプレイ)と、Fish側に音声モデルが2つ作成され課金が二重発生し、voice_idは後勝ちで上書きされる
 * レースコンディションがあった。
 *
 * SELECT ... FOR UPDATE で対象行をロックし、Fish呼び出し+UPDATEを同一トランザクション内で
 * 直列化する（chat-history/deleteSessionRepository.tsと同じ確立済みパターン）。
 * ロック待ちが3秒を超えた場合（＝同時に別の登録が進行中）は409を返し、二重にFishへ課金しない。
 *
 * 外部APIコール(Fish Audio)をロック保持中に行う点は一般的には避けるべきだが、本エンドポイントは
 * 低頻度の管理操作でありFishのレスポンスも数秒以内のため許容する。
 */
export async function adoptVoiceForConfig(
  params: AdoptVoiceForConfigParams,
): Promise<AdoptVoiceForConfigResult> {
  const genericError =
    params.logEventPrefix === "voice_clone" ? "音声クローンの作成に失敗しました" : "音声の登録に失敗しました";

  const client = await params.db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '3s'");

    let checkQuery = "SELECT id FROM avatar_configs WHERE id = $1";
    const checkValues: unknown[] = [params.configId];
    if (!params.isSuperAdmin) {
      checkQuery += " AND tenant_id = $2";
      checkValues.push(params.tenantId);
    }
    checkQuery += " FOR UPDATE";
    const existing = await client.query(checkQuery, checkValues);
    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return { ok: false, status: 404, error: "設定が見つからないかアクセス権限がありません" };
    }

    let voiceId: string;
    try {
      voiceId = await createFishVoiceModel({
        apiKey: params.fishApiKey,
        title: params.title,
        audio: params.audio,
        mimeType: params.mimeType,
        filename: params.filename,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      logger.warn({
        event: `${params.logEventPrefix}_fish_error`,
        status: err instanceof FishVoiceModelError ? err.status : undefined,
        detail: err instanceof Error ? err.message.slice(0, 300) : String(err),
      }, params.logContext);
      return { ok: false, status: 502, error: genericError };
    }

    // Fish側は既にこの時点で課金対象のモデルを作成済み。ここから先のUPDATEが
    // （0件更新ではなく）例外で失敗した場合、Fishのモデルはどこにも記録されず
    // 孤児化する。UPDATE試行前にログしておき、失敗時に手動でFish側から追跡・
    // 削除できるようにする。
    logger.info({
      event: `${params.logEventPrefix}_voice_created`,
      voiceId,
      configId: params.configId,
    }, `${params.logContext} (Fish voice model created, persisting voice_id)`);

    const updateValues: unknown[] = [voiceId, params.configId];
    let updateQuery = "UPDATE avatar_configs SET voice_id = $1, updated_at = NOW() WHERE id = $2";
    if (!params.isSuperAdmin) {
      updateValues.push(params.tenantId);
      updateQuery += " AND tenant_id = $3";
    }
    // 対象行は直前の SELECT ... FOR UPDATE で既にロック済みのため、この UPDATE が
    // 0件になることはない（ロック保持中に他トランザクションが行を削除/移動できない）。
    await client.query(updateQuery, updateValues);

    await client.query("COMMIT");
    return { ok: true, voiceId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    // ロックタイムアウト = 同時に別の登録が進行中。二重にFishへ課金しないよう409で確定させる。
    if (err instanceof Error && /lock timeout|canceling statement/i.test(err.message)) {
      return { ok: false, status: 409, error: "この設定は現在別の操作を処理中です。少し待ってからもう一度お試しください" };
    }
    throw err;
  } finally {
    client.release();
  }
}
