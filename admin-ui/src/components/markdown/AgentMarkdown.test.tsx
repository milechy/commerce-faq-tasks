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
