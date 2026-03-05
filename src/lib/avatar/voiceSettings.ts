export type VoiceType = "male" | "female" | "neutral";

export interface VoiceSettings {
  voiceType: VoiceType;
  speakingRate: number;
  pitch: number;
}

export interface VoiceSettingsInput {
  voiceType?: string;
  speakingRate?: number;
  pitch?: number;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  voiceType: "neutral",
  speakingRate: 1.0,
  pitch: 0,
};

export const VOICE_RATE_MIN = 0.7;
export const VOICE_RATE_MAX = 1.3;
export const VOICE_PITCH_MIN = -6;
export const VOICE_PITCH_MAX = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeVoiceType(raw?: string): VoiceType {
  if (raw === "male" || raw === "female" || raw === "neutral") {
    return raw;
  }
  return DEFAULT_VOICE_SETTINGS.voiceType;
}

export function normalizeVoiceSettings(input: VoiceSettingsInput): VoiceSettings {
  const speakingRate =
    typeof input.speakingRate === "number"
      ? clamp(input.speakingRate, VOICE_RATE_MIN, VOICE_RATE_MAX)
      : DEFAULT_VOICE_SETTINGS.speakingRate;

  const pitch =
    typeof input.pitch === "number"
      ? clamp(input.pitch, VOICE_PITCH_MIN, VOICE_PITCH_MAX)
      : DEFAULT_VOICE_SETTINGS.pitch;

  return {
    voiceType: normalizeVoiceType(input.voiceType),
    speakingRate: Number(speakingRate.toFixed(2)),
    pitch: Number(pitch.toFixed(1)),
  };
}

export function validateVoiceSettings(input: VoiceSettingsInput): string[] {
  const errors: string[] = [];
  if (
    input.voiceType !== undefined &&
    input.voiceType !== "male" &&
    input.voiceType !== "female" &&
    input.voiceType !== "neutral"
  ) {
    errors.push("声のタイプは男性・女性・ニュートラルから選んでください。");
  }

  if (
    input.speakingRate !== undefined &&
    (Number.isNaN(input.speakingRate) ||
      input.speakingRate < VOICE_RATE_MIN ||
      input.speakingRate > VOICE_RATE_MAX)
  ) {
    errors.push(
      `話す速さは ${VOICE_RATE_MIN}〜${VOICE_RATE_MAX} の範囲で設定してください。`
    );
  }

  if (
    input.pitch !== undefined &&
    (Number.isNaN(input.pitch) ||
      input.pitch < VOICE_PITCH_MIN ||
      input.pitch > VOICE_PITCH_MAX)
  ) {
    errors.push(
      `声の高さは ${VOICE_PITCH_MIN}〜${VOICE_PITCH_MAX} の範囲で設定してください。`
    );
  }

  return errors;
}
