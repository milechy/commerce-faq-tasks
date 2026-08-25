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

// ───────────────────────────────────────────────────────────────────────────
// 壊れやすい点を突くテスト（2026-08-25 テスト強化）
//
// このコンポーネントは「LLMが生成した、テナント知識・PDF抽出・エンド顧客の発話を
// そのまま引用しうるテキスト」を描画する。入力は制御できない前提で、
// (1)崩れた記法 (2)ストリーミング中の断片 (3)引用元に紛れた記法 を重点的に突く。
// ───────────────────────────────────────────────────────────────────────────
describe("AgentMarkdown — 崩れた記法・途中の断片（タイプライター演出中に必ず通る経路）", () => {
  // useTypewriter は3文字/16msで流し込む。その途中の文字列は必ず「閉じていない記法」に
  // なる。revealing中は素テキストで出す設計だが、演出をOFFにした場合やreduceMotion時、
  // また将来revealingを外した場合にここを通る。例外を投げないことが最低ライン。
  it.each([
    ["閉じていない強調", "**未完のまま"],
    ["閉じていないインラインコード", "途中の`コード"],
    ["閉じていないフェンス", "```\nconst a = 1;"],
    ["閉じていないリンク", "[ラベルだけ"],
    ["閉じていない表", "| A | B |\n|---|"],
    ["アスタリスク1個", "*"],
    ["アスタリスク2個だけ", "**"],
    ["角括弧だけ", "["],
    ["パイプだけ", "|"],
  ])("%s でも例外を投げずに描画できる", (_name, md) => {
    expect(() => render(<AgentMarkdown content={md} />)).not.toThrow();
  });

  it("閉じていない強調は記法のまま素のテキストとして出る（勝手に太字にしない）", () => {
    const { container } = render(<AgentMarkdown content={"**未完のまま"} />);
    expect(container.querySelectorAll("strong")).toHaveLength(0);
    expect(container.textContent).toContain("**未完のまま");
  });

  it("空白のみの入力は何も描画しない（空バブルにならない）", () => {
    const { container } = render(<AgentMarkdown content={"   \n  \n "} />);
    expect(container.textContent).toBe("");
  });

  it("null/undefined相当の空文字でも例外を投げない", () => {
    expect(() => render(<AgentMarkdown content={""} />)).not.toThrow();
  });
});

describe("AgentMarkdown — 引用元に紛れた記法（テナント知識・FAQ本文の取り違え）", () => {
  // 確認要約(「この内容で保存します」)はLLMの地の文であり、FAQ本文をそのまま引用する。
  // 引用元に markdown 記法が入っていると、管理者が承認する見た目と保存される実バイトが
  // ズレる。どこまでが「化ける」のかを明示的に固定しておく。
  it("スペース無しの # は見出しにならない（FAQ本文の「#返金について」は化けない）", () => {
    const { container } = render(<AgentMarkdown content={"#返金について\n返品は7日以内です"} />);
    expect(container.querySelectorAll("h1,h2,h3,h4")).toHaveLength(0);
    expect(container.textContent).toContain("#返金について");
  });

  it("スペース有りの # は見出しになる = 引用元の「# 返金について」は表示が変わる（既知の非対称）", () => {
    const { container } = render(<AgentMarkdown content={"# 返金について"} />);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    // 「#」が消えるため、承認画面の見た目と保存バイトが一致しない
    expect(container.textContent).toBe("返金について");
  });

  it("表のセル内のエスケープされたパイプが欠落しない", () => {
    const { container } = render(<AgentMarkdown content={"| A | B |\n|---|---|\n| a\\|b | c |"} />);
    expect(container.textContent).toContain("a|b");
  });

  it("HTMLエンティティは文字として出る（skipHtmlで消える生タグと混同しない）", () => {
    const { container } = render(<AgentMarkdown content={"&lt;b&gt; と &amp;"} />);
    expect(container.textContent).toBe("<b> と &");
    expect(container.querySelectorAll("b")).toHaveLength(0);
  });
});

describe("AgentMarkdown — リンクの安全性（urlTransform への依存を固定する）", () => {
  // 安全性は react-markdown 既定の urlTransform だけに乗っている。
  // ここを上書きすると全テスト緑のまま admin 画面に stored XSS が復活するため、
  // 危険スキームは網羅的に固定する。
  it.each([
    ["javascript:", "[x](javascript:alert(1))"],
    ["JavaScript: 大文字混じり", "[x](JaVaScRiPt:alert(1))"],
    ["data:", "[x](data:text/html,<b>1</b>)"],
    ["vbscript:", "[x](vbscript:msgbox(1))"],
    ["先頭空白付き javascript:", "[x]( javascript:alert(1))"],
  ])("%s はアンカーにしない", (_name, md) => {
    const { container } = render(<AgentMarkdown content={md} />);
    expect(container.querySelectorAll("a")).toHaveLength(0);
  });

  it("GFMのautolink（記法無しのURL）にも rel/target が付く（aコンポーネントを迂回しない）", () => {
    const { container } = render(<AgentMarkdown content={"https://example.com を見て"} />);
    const a = container.querySelector("a");
    expect(a?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a?.getAttribute("target")).toBe("_blank");
  });

  it("画像はaltテキストだけを出し、img要素を作らない（外部リクエストを発生させない）", () => {
    const { container } = render(<AgentMarkdown content={"![ロゴ](https://tracker.example/p.gif)"} />);
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.textContent).toContain("ロゴ");
  });

  it("altが空の画像でも例外を投げず、img要素も作らない", () => {
    const { container } = render(<AgentMarkdown content={"![](https://tracker.example/p.gif)"} />);
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });
});

describe("AgentMarkdown — 改行とリストの見た目（pre-line の副作用を防ぐ）", () => {
  it("単一改行が改行として見える", () => {
    const { container } = render(<AgentMarkdown content={"一行目\n二行目"} />);
    const p = container.querySelector("p")!;
    expect(p.textContent).toContain("\n");
    expect(getComputedStyle(p).whiteSpace).toBe("pre-line");
  });

  it("CRLF(\\r\\n)でも改行が保たれる（Windows由来の貼り付けを含む）", () => {
    const { container } = render(<AgentMarkdown content={"一行目\r\n二行目"} />);
    expect(container.textContent).toMatch(/一行目[\r\n]+二行目/);
  });

  it("ネストしたリストで余計な空行が入らない（liにpre-lineを付けた副作用の回帰）", () => {
    // 入れ子を含む li には </li> と <ul> の間などに構造由来の改行テキストノードが
    // ぶら下がる。pre-line のままだとそれが改行として描画され、入れ子の前後に
    // 空行が入る(修正前の実測: 3段で li.textContent が "a\n\nb\n\nc\n\n\n\n")。
    const { container } = render(<AgentMarkdown content={"- a\n  - b\n    - c"} />);
    // textContent は CSS の white-space に影響されない(構造由来の改行は常に残る)ので、
    // 「改行として描画されるか」= 算出スタイルで判定する。
    const lis = [...container.querySelectorAll("li")];
    const outerLi = lis[0]!;
    const innermostLi = lis[lis.length - 1]!;
    // 入れ子を含む li は pre-line を外す(構造由来の改行を描画しない)
    expect(outerLi.querySelector("ul")).not.toBeNull();
    expect(getComputedStyle(outerLi).whiteSpace).not.toBe("pre-line");
    // 最深部(入れ子を含まない)は pre-line のまま
    expect(innermostLi.querySelector("ul")).toBeNull();
    expect(getComputedStyle(innermostLi).whiteSpace).toBe("pre-line");
  });

  it("入れ子を含まない li ではソフト改行が保たれる（pre-lineを一律で外さない）", () => {
    const { container } = render(<AgentMarkdown content={"- 一行目\n  二行目"} />);
    const li = container.querySelector("li")!;
    expect(getComputedStyle(li).whiteSpace).toBe("pre-line");
    expect(li.textContent).toContain("\n");
  });

  it("箇条書きが連続してもリスト要素になる（改行が潰れて1行にならない）", () => {
    const { container } = render(<AgentMarkdown content={"- 一つ目\n- 二つ目\n- 三つ目"} />);
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });
});

describe("AgentMarkdown — コードブロックの判定と見た目", () => {
  it("言語指定なしフェンスは pre として描画され、インラインcodeの枠線が付かない", () => {
    const { container } = render(<AgentMarkdown content={"```\nconst a = 1;\n```"} />);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    const innerCode = pre!.querySelector("code")!;
    expect(innerCode.getAttribute("style") ?? "").not.toContain("border:");
  });

  it("言語指定ありフェンスも pre として描画される", () => {
    const { container } = render(<AgentMarkdown content={"```ts\nconst a = 1;\n```"} />);
    expect(container.querySelectorAll("pre")).toHaveLength(1);
  });

  it("インラインコードは pre にせず、地色と枠線を付ける（バブル背景に溶けない）", () => {
    const { container } = render(<AgentMarkdown content={"`is_published` を確認"} />);
    expect(container.querySelectorAll("pre")).toHaveLength(0);
    const style = container.querySelector("code")!.getAttribute("style") ?? "";
    expect(style).toContain("border");
    // copilot-preview のAIバブル背景 var(--muted) と同色にしない
    expect(style).not.toContain("var(--muted");
  });

  it("コードブロックとインラインコードが同居しても取り違えない", () => {
    const { container } = render(<AgentMarkdown content={"`inline` と\n\n```\nblock\n```"} />);
    expect(container.querySelectorAll("pre")).toHaveLength(1);
    expect(container.querySelectorAll("code")).toHaveLength(2);
  });
});

describe("AgentMarkdown — 規模と異常入力", () => {
  it("長文（1万文字相当）でも例外を投げずに描画できる", () => {
    const long = Array.from({ length: 400 }, (_, i) => `- 項目${i} **強調** と \`code\``).join("\n");
    expect(() => render(<AgentMarkdown content={long} />)).not.toThrow();
  });

  it("深いネスト（20段）でも例外を投げない", () => {
    const deep = Array.from({ length: 20 }, (_, i) => `${"  ".repeat(i)}- 段${i}`).join("\n");
    expect(() => render(<AgentMarkdown content={deep} />)).not.toThrow();
  });

  it("絵文字・サロゲートペアが壊れない", () => {
    const { container } = render(<AgentMarkdown content={"**👨‍👩‍👧‍👦 家族** と 𠮷野家"} />);
    expect(container.textContent).toContain("👨‍👩‍👧‍👦 家族");
    expect(container.textContent).toContain("𠮷野家");
  });
});
