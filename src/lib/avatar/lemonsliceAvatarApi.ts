import crypto from "node:crypto";
import type { StoredAvatarImage } from "./avatarStorage";
import { trackUsage } from "../billing/usageTracker";

export interface JwtTenantContext {
  tenantId: string;
}

export interface RegisterLemonsliceAvatarInput {
  auth: JwtTenantContext;
  displayName: string;
  avatarImage: StoredAvatarImage;
}

export interface LemonsliceAvatarRegistrationResult {
  avatarId: string;
  provider: "lemon_slice";
  status: "registered" | "queued";
  livekitRoomPrefix: string;
}

type LiveKitConfig = {
  wsUrl: string;
  accessToken: string;
  roomPrefix: string;
};

function readLemonsliceEndpoint(): string {
  const endpoint = process.env.LEMON_SLICE_ENDPOINT?.trim();
  if (!endpoint) {
    throw new Error("LEMON_SLICE_ENDPOINT が設定されていません。");
  }
  return endpoint.replace(/\/+$/, "");
}

function readLemonsliceToken(): string {
  const token = process.env.LEMON_SLICE_API_TOKEN?.trim();
  if (!token) {
    throw new Error("LEMON_SLICE_API_TOKEN が設定されていません。");
  }
  return token;
}

/**
 * Phase10 流用: LiveKit 接続情報は環境変数で一元管理する。
 */
function readLiveKitConfig(tenantId: string): LiveKitConfig {
  const wsUrl = process.env.LIVEKIT_WS_URL?.trim();
  const accessToken = process.env.LIVEKIT_ACCESS_TOKEN?.trim();
  const roomPrefix = (
    process.env.LIVEKIT_ROOM_PREFIX?.trim() || `phase10-${tenantId}`
  ).replace(/[^a-zA-Z0-9_-]/g, "");

  if (!wsUrl || !accessToken) {
    throw new Error("LiveKit 設定が不足しています。");
  }

  return { wsUrl, accessToken, roomPrefix };
}

function assertTenantIdFromJwt(tenantId: string): void {
  if (!tenantId || !/^[a-zA-Z0-9_-]{1,64}$/.test(tenantId)) {
    throw new Error("無効なテナント情報です。");
  }
}

function sanitizeDisplayName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 80) {
    throw new Error("アバター名は1〜80文字で入力してください。");
  }
  return trimmed;
}

// GID 1216944049264977: 現状どこからも呼ばれていない未配線の関数（SCRIPTS/dead-code-report.txt
// で検出済み）。将来の配線に備えてtrackUsageは実装済みだが、配線されるまでは実際の課金漏れは
// 発生しない。テスト容易性のためexportする（PR本文の「要判断」参照）。
export async function registerAvatarToLemonslice(
  input: RegisterLemonsliceAvatarInput
): Promise<LemonsliceAvatarRegistrationResult> {
  assertTenantIdFromJwt(input.auth.tenantId);
  const displayName = sanitizeDisplayName(input.displayName);

  const endpoint = readLemonsliceEndpoint();
  const apiToken = readLemonsliceToken();
  const livekit = readLiveKitConfig(input.auth.tenantId);
  const registerPath =
    process.env.LEMON_SLICE_AVATAR_REGISTER_PATH?.trim() || "/v1/avatars";

  if (typeof (globalThis as { fetch?: unknown }).fetch !== "function") {
    throw new Error("サーバーの通信機能が利用できません。");
  }

  const response = await fetch(`${endpoint}${registerPath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      "X-Tenant-ID": input.auth.tenantId,
    },
    body: JSON.stringify({
      tenantId: input.auth.tenantId,
      displayName,
      image: {
        storageKey: input.avatarImage.storageKey,
        mimeType: input.avatarImage.mimeType,
        sha256: input.avatarImage.sha256,
        encrypted: true,
      },
      livekit: {
        wsUrl: livekit.wsUrl,
        accessToken: livekit.accessToken,
        roomPrefix: livekit.roomPrefix,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? "アバター登録の認証に失敗しました。設定を確認してください。"
        : "アバター登録に失敗しました。時間をおいて再度お試しください。"
    );
  }

  const json = (await response.json()) as {
    avatarId?: string;
    status?: "registered" | "queued";
  };
  const avatarId = (json.avatarId ?? "").trim();
  if (!avatarId) {
    throw new Error("アバター登録結果が不正です。");
  }

  // GID 1216944049264977: LemonSliceアバター登録（トーク中の分課金とは別の、1回限りの
  // プロビジョニング呼び出し）はこれまでtrackUsage対象外だった。管理機能(avatar_config_image)
  // 扱いのため原価のみ(margin×1)で計上する。
  trackUsage({
    tenantId: input.auth.tenantId,
    requestId: crypto.randomUUID(),
    model: "lemon-slice-register",
    inputTokens: 0,
    outputTokens: 0,
    featureUsed: "avatar_config_image",
    lemonsliceRegistrationCount: 1,
  });

  return {
    avatarId,
    provider: "lemon_slice",
    status: json.status === "queued" ? "queued" : "registered",
    livekitRoomPrefix: livekit.roomPrefix,
  };
}
