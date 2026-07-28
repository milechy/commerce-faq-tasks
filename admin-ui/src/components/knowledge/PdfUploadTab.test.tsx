// Phase: PdfUploadTab の進捗%・エラー粒度・a11y の回帰テスト
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import PdfUploadTab from "./PdfUploadTab";

vi.mock("../../auth/useAuth", () => ({
  useAuth: () => ({ isSuperAdmin: false }),
}));

// 実辞書(ja.ts)をそのまま使う安定した t() を返す（LangProvider は localStorage依存のため使わない）
vi.mock("../../i18n/LangContext", async () => {
  const jaModule = await import("../../i18n/ja");
  const ja = jaModule.default as Record<string, string>;
  const stableT = (key: string, vars?: Record<string, string | number>) => {
    let text = ja[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
      }
    }
    return text;
  };
  const stableValue = { lang: "ja" as const, setLang: () => {}, t: stableT };
  return { useLang: () => stableValue };
});

vi.mock("./shared", async () => {
  const actual = await vi.importActual<typeof import("./shared")>("./shared");
  return {
    ...actual,
    fetchWithAuth: vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ books: [] }) } as Response)
    ),
    getAccessToken: vi.fn(() => Promise.resolve("test-token")),
  };
});

// ── XHR モック ────────────────────────────────────────────────────────────

type Listener = (...args: unknown[]) => void;

class MockXHR {
  static instances: MockXHR[] = [];
  uploadListeners: Record<string, Listener[]> = {};
  upload = {
    addEventListener: (event: string, cb: Listener) => {
      (this.uploadListeners[event] ??= []).push(cb);
    },
  };
  listeners: Record<string, Listener[]> = {};
  status = 0;
  responseText = "";
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn();

  constructor() {
    MockXHR.instances.push(this);
  }

  addEventListener(event: string, cb: Listener) {
    (this.listeners[event] ??= []).push(cb);
  }

  fireProgress(loaded: number, total: number) {
    for (const cb of this.uploadListeners["progress"] ?? []) {
      cb({ lengthComputable: true, loaded, total });
    }
  }

  fireLoad(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    for (const cb of this.listeners["load"] ?? []) cb();
  }

  fireError() {
    for (const cb of this.listeners["error"] ?? []) cb();
  }
}

function pdfFile(name = "manual.pdf", size = 1024) {
  const file = new File([new Uint8Array(size)], name, { type: "application/pdf" });
  return file;
}

describe("PdfUploadTab", () => {
  beforeEach(() => {
    MockXHR.instances = [];
    vi.stubGlobal("XMLHttpRequest", MockXHR as unknown as typeof XMLHttpRequest);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ドロップゾーンは role=button / tabIndex=0 / aria-label を持つ", () => {
    render(<PdfUploadTab tenantId="tenant-abc" />);
    const dropzone = screen.getByRole("button", { name: /PDFまたはZIPファイルをアップロード/ });
    expect(dropzone.getAttribute("tabindex")).toBe("0");
  });

  it("Enterキーでファイル選択ダイアログ(input click)が起動する", () => {
    render(<PdfUploadTab tenantId="tenant-abc" />);
    const dropzone = screen.getByRole("button", { name: /PDFまたはZIPファイルをアップロード/ });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, "click");

    fireEvent.keyDown(dropzone, { key: "Enter" });

    expect(clickSpy).toHaveBeenCalled();
  });

  it("PDF以外の形式を選ぶとエラートーストが出てキューに追加されない", () => {
    render(<PdfUploadTab tenantId="tenant-abc" />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const textFile = new File(["hello"], "note.txt", { type: "text/plain" });

    fireEvent.change(input, { target: { files: [textFile] } });

    expect(screen.getByText(/PDFまたはZIPファイルを選択してください/)).toBeTruthy();
    expect(screen.queryByText(/アップロード予定のファイル/)).toBeNull();
  });

  it("10MBを超えるPDFはサイズエラーになる", () => {
    render(<PdfUploadTab tenantId="tenant-abc" />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const bigFile = pdfFile("big.pdf", 11 * 1024 * 1024);

    fireEvent.change(input, { target: { files: [bigFile] } });

    expect(screen.getByText(/ファイルサイズが10MBを超えています/)).toBeTruthy();
  });

  it("アップロード中は進捗%バーが更新される", async () => {
    render(<PdfUploadTab tenantId="tenant-abc" />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pdfFile()] } });

    const uploadBtn = await screen.findByText(/件をアップロード/);
    fireEvent.click(uploadBtn);

    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    const xhr = MockXHR.instances[0];
    xhr.fireProgress(50, 100);

    expect(await screen.findByText("50%")).toBeTruthy();

    xhr.fireLoad(201, { id: 42 });
    await waitFor(() => {
      expect(screen.getByText("処理中")).toBeTruthy();
    });
  });

  it("401エラー時は「ログインの有効期限が切れました」を表示し、再試行ボタンで pending に戻る", async () => {
    render(<PdfUploadTab tenantId="tenant-abc" />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pdfFile()] } });

    const uploadBtn = await screen.findByText(/件をアップロード/);
    fireEvent.click(uploadBtn);

    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    MockXHR.instances[0].fireLoad(401, { error: "unauthorized" });

    expect(await screen.findByText("ログインの有効期限が切れました。再度ログインしてください。")).toBeTruthy();

    fireEvent.click(screen.getByText("もう一度試す"));
    expect(await screen.findByText(/件をアップロード/)).toBeTruthy();
  });

  it("413エラー時はファイルサイズ超過メッセージを表示する", async () => {
    render(<PdfUploadTab tenantId="tenant-abc" />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pdfFile()] } });
    fireEvent.click(await screen.findByText(/件をアップロード/));

    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    MockXHR.instances[0].fireLoad(413, {});

    expect(await screen.findByText(/ファイルが大きすぎます。アップロードできる上限を超えています。/)).toBeTruthy();
  });

  it("ネットワークエラー時は接続確認メッセージを表示する", async () => {
    render(<PdfUploadTab tenantId="tenant-abc" />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pdfFile()] } });
    fireEvent.click(await screen.findByText(/件をアップロード/));

    await waitFor(() => expect(MockXHR.instances.length).toBe(1));
    MockXHR.instances[0].fireError();

    expect(await screen.findByText(/ネットワークエラーが発生しました/)).toBeTruthy();
  });
});
