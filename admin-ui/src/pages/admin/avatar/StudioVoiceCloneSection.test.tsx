// FishAudio Phase C-1: StudioVoiceCloneSection unit tests
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { StudioVoiceCloneSection } from "./StudioVoiceCloneSection";

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("../../../i18n/LangContext", () => ({
  useLang: () => ({ lang: "ja" }),
}));

vi.mock("../../../lib/api", () => ({
  API_BASE: "http://localhost:3100",
}));

vi.mock("../../../components/knowledge/shared", () => ({
  fetchWithAuth: vi.fn(),
}));

import { fetchWithAuth } from "../../../components/knowledge/shared";

// ── Helpers ────────────────────────────────────────────────────────────────

const mockOk = (data: unknown): Promise<Response> =>
  Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
  } as Response);

const mockErr = (status: number, error: string): Promise<Response> =>
  Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve({ error }),
  } as Response);

function setup(overrides: Partial<{
  configId: string;
  currentVoiceId: string | null;
  isDefault: boolean;
}> = {}) {
  const onCloneSuccess = vi.fn();
  render(
    <StudioVoiceCloneSection
      configId={overrides.configId ?? "cfg-1"}
      currentVoiceId={overrides.currentVoiceId ?? null}
      isDefault={overrides.isDefault ?? false}
      onCloneSuccess={onCloneSuccess}
    />
  );
  return { onCloneSuccess };
}

function makeAudioFile(name = "sample.mp3", type = "audio/mpeg", size?: number): File {
  const file = new File(["dummy-audio"], name, { type });
  if (size != null) {
    Object.defineProperty(file, "size", { value: size });
  }
  return file;
}

function selectFile(file: File) {
  const input = screen.getByLabelText("音声ファイルを選択") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("StudioVoiceCloneSection", () => {
  beforeEach(() => {
    vi.mocked(fetchWithAuth).mockReset();
  });

  it("T1: 正常系 — FormData(name + audio) を POST し onCloneSuccess(voiceId) を呼ぶ", async () => {
    vi.mocked(fetchWithAuth).mockReturnValue(mockOk({ voiceId: "vc-123" }));
    const { onCloneSuccess } = setup();

    selectFile(makeAudioFile());
    fireEvent.change(screen.getByPlaceholderText("例: やわらかい女性の声"), {
      target: { value: "やわらかい声" },
    });
    fireEvent.click(screen.getByRole("button", { name: "音声クローンを作成する" }));

    await waitFor(() => {
      expect(onCloneSuccess).toHaveBeenCalledWith("vc-123");
    });

    expect(vi.mocked(fetchWithAuth)).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(fetchWithAuth).mock.calls[0]!;
    expect(url).toBe("http://localhost:3100/v1/admin/avatar/configs/cfg-1/voice-clone");
    expect(opts?.method).toBe("POST");
    const body = opts?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("name")).toBe("やわらかい声");
    expect(body.get("audio")).toBeInstanceOf(File);
  });

  it("T2: MIME 不正 — フロントで弾き fetch には到達しない", () => {
    setup();

    selectFile(makeAudioFile("note.txt", "text/plain"));

    expect(screen.getByText(/対応していない音声形式です/)).toBeTruthy();
    expect(vi.mocked(fetchWithAuth)).not.toHaveBeenCalled();
    // ファイル未選択のままなので作成ボタンは disabled
    const btn = screen.getByRole("button", { name: "音声クローンを作成する" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("T3: 10MB 超過 — フロントで弾き fetch には到達しない", () => {
    setup();

    selectFile(makeAudioFile("big.mp3", "audio/mpeg", 10 * 1024 * 1024 + 1));

    expect(screen.getByText(/ファイルサイズが大きすぎます/)).toBeTruthy();
    expect(vi.mocked(fetchWithAuth)).not.toHaveBeenCalled();
  });

  it("T4: API 502（英語エラー）— 優しい日本語の文言を表示し onCloneSuccess は呼ばれない", async () => {
    vi.mocked(fetchWithAuth).mockReturnValue(mockErr(502, "Bad Gateway"));
    const { onCloneSuccess } = setup();

    selectFile(makeAudioFile());
    fireEvent.change(screen.getByPlaceholderText("例: やわらかい女性の声"), {
      target: { value: "テスト" },
    });
    fireEvent.click(screen.getByRole("button", { name: "音声クローンを作成する" }));

    await waitFor(() => {
      expect(
        screen.getByText("音声クローンの作成に失敗しました。時間をおいて再度お試しください")
      ).toBeTruthy();
    });
    expect(onCloneSuccess).not.toHaveBeenCalled();
    // 英語エラーは画面に出さない
    expect(screen.queryByText(/Bad Gateway/)).toBeNull();
  });

  it("T5: サーバーの日本語エラーはそのまま表示する", async () => {
    vi.mocked(fetchWithAuth).mockReturnValue(
      mockErr(400, "対応していない音声形式です（MP3 / WAV / MP4 / OGG をご利用ください）")
    );
    setup();

    selectFile(makeAudioFile());
    fireEvent.change(screen.getByPlaceholderText("例: やわらかい女性の声"), {
      target: { value: "テスト" },
    });
    fireEvent.click(screen.getByRole("button", { name: "音声クローンを作成する" }));

    await waitFor(() => {
      expect(
        screen.getByText("対応していない音声形式です（MP3 / WAV / MP4 / OGG をご利用ください）")
      ).toBeTruthy();
    });
  });

  it("T6: isDefault=true — フォームを出さず案内文のみ表示", () => {
    setup({ isDefault: true });

    expect(screen.getByText("既定アバターの音声は変更できません")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "音声クローンを作成する" })).toBeNull();
    expect(screen.queryByLabelText("音声ファイルを選択")).toBeNull();
  });

  it("T7: 名前が空の間は作成ボタンが disabled", () => {
    setup();

    selectFile(makeAudioFile());
    const btn = screen.getByRole("button", { name: "音声クローンを作成する" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("例: やわらかい女性の声"), {
      target: { value: "テスト" },
    });
    expect(btn.disabled).toBe(false);
  });
});
