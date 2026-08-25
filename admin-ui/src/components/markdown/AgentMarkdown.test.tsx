// admin-ui/src/components/markdown/AgentMarkdown.test.tsx
// AIエージェントの返答が生Markdown記法(**太字**や|表|)のまま画面に出てしまう
// 不具合(P0-2)の回帰テスト。rehype-raw を入れていないことも合わせて確認する
// (生HTMLタグが描画・実行されないこと)。
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import AgentMarkdown from "./AgentMarkdown";

describe("AgentMarkdown", () => {
  it("**強調**が<strong>要素になる", () => {
    render(<AgentMarkdown content="これは**強調**です" />);
    const strong = screen.getByText("強調");
    expect(strong.tagName).toBe("STRONG");
  });

  it("### 見出しが見出し要素になる", () => {
    render(<AgentMarkdown content="### 使い方の流れ" />);
    const heading = screen.getByText("使い方の流れ");
    expect(heading.tagName).toBe("H3");
  });

  it("GFMの表が<table>要素になる", () => {
    const content = ["| ヘルス・分析 | 説明 |", "| --- | --- |", "| 会話数 | 30日間の増減 |"].join("\n");
    render(<AgentMarkdown content={content} />);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("会話数")).toBeTruthy();
  });

  it("<br>が改行要素として実行されず、テキストか除去のいずれかになる", () => {
    const { container } = render(<AgentMarkdown content="1行目<br>2行目" />);
    // 生HTMLの<br>要素として描画されていないこと(rehype-rawを入れていないため)
    expect(container.querySelector("br")).toBeNull();
  });

  it("<script>alert(1)</script>が実行可能な要素にならない", () => {
    const { container } = render(<AgentMarkdown content="内容<script>alert(1)</script>です" />);
    // <script>要素として描画されていないこと
    expect(container.querySelector("script")).toBeNull();
  });

  it("打消し線(GFM strikethrough)が<del>要素になる", () => {
    render(<AgentMarkdown content="~~古い案内~~" />);
    const del = screen.getByText("古い案内");
    expect(del.tagName).toBe("DEL");
  });

  it("リンクはtarget=_blank・rel=noopener noreferrerで描画される", () => {
    render(<AgentMarkdown content="[ヘルプ](https://example.com/help)" />);
    const link = screen.getByRole("link", { name: "ヘルプ" });
    expect(link.getAttribute("href")).toBe("https://example.com/help");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("空文字でも例外を投げない", () => {
    expect(() => render(<AgentMarkdown content="" />)).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// コードレビュー(2026-08-25)で実測により判明した挙動の固定。
// ここが崩れると「信頼できない入力を描画している」という前提が壊れる。
// ───────────────────────────────────────────────────────────────────────────
describe("AgentMarkdown — 信頼できない入力に対する不変条件", () => {
  it("生HTMLは文字としても表示しない(skipHtml)。rehype-rawを入れないだけでは<br>が文字で残る", () => {
    const { container } = render(<AgentMarkdown content={"A<br>B"} />);
    expect(container.querySelectorAll("br")).toHaveLength(0);
    expect(container.textContent).not.toContain("<br>");
    expect(container.textContent).toContain("A");
    expect(container.textContent).toContain("B");
  });

  it("<script>は要素としてもテキストとしても出ない", () => {
    const { container } = render(<AgentMarkdown content={"x<script>alert(1)</script>y"} />);
    expect(container.querySelectorAll("script")).toHaveLength(0);
    expect(container.textContent).not.toContain("<script>");
  });

  it("javascript: リンクはアンカーにせず素のテキストにする(href=''の偽リンクを作らない)", () => {
    const { container } = render(<AgentMarkdown content={"[請求書を開く](javascript:alert(1))"} />);
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.textContent).toContain("請求書を開く");
  });

  it("data: リンクもアンカーにしない", () => {
    const { container } = render(<AgentMarkdown content={"[x](data:text/html,<b>1</b>)"} />);
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("安全なhttpsリンクは target=_blank + rel=noopener noreferrer で出す", () => {
    const { container } = render(<AgentMarkdown content={"[R2C](https://r2c.biz)"} />);
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://r2c.biz");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a?.getAttribute("target")).toBe("_blank");
  });

  it("画像は描画せず、外部へのリクエストを発生させない", () => {
    const { container } = render(<AgentMarkdown content={"![ロゴ](https://tracker.example/p.gif)"} />);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.textContent).toContain("ロゴ");
  });

  it("単一改行が潰れない(オンボ初回挨拶が1行にならない)", () => {
    const { container } = render(<AgentMarkdown content={"どんな業種ですか？\nお答えに合わせて提案します。"} />);
    const p = container.querySelector("p");
    expect(p?.textContent).toContain("\n");
    expect(getComputedStyle(p!).whiteSpace).toBe("pre-line");
  });

  it("コード・表ヘッダの地色が copilot-preview のAIバブル背景 var(--muted) と同一でない", () => {
    const { container } = render(<AgentMarkdown content={"`is_published` を確認"} />);
    const code = container.querySelector("code");
    const bg = code?.getAttribute("style") ?? "";
    expect(bg).not.toContain("var(--muted");
  });
});
