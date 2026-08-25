// admin-ui/src/components/markdown/AgentMarkdown.tsx
// AIエージェントの発話を描画する唯一のMarkdownコンポーネント。
//
// なぜ新規ファイルにするか: 描画箇所は現状 copilot-preview/index.tsx と
// components/AdminAgent/AdminAgentMessage.tsx の2箇所があり、今後も増える見込み。
// 各所で pre-wrap を個別に書き換える方式だと3面目で再発するため、1箇所に閉じる。
//
// rehype-raw は意図的に入れない。react-markdown はデフォルトで生HTML(<br> や
// <script> 等)をhastに変換せず読み捨てるため、これだけでHTMLの実行を防げる。
// ユーザー自身の発話はこのコンポーネントに通さないこと(呼び出し側の責務)。
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// 色は既存のCSS変数のみを使う(index.css で定義済み)。新しい色は定義しない。
const MUTED_BG = "var(--muted, rgba(120,120,140,0.12))";

const components: Components = {
  h1: ({ children }) => (
    <h1 style={{ fontSize: 20, fontWeight: 700, margin: "12px 0 6px", color: "var(--foreground)" }}>{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 style={{ fontSize: 18, fontWeight: 700, margin: "12px 0 6px", color: "var(--foreground)" }}>{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 style={{ fontSize: 16, fontWeight: 700, margin: "10px 0 4px", color: "var(--foreground)" }}>{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 style={{ fontSize: 15, fontWeight: 700, margin: "10px 0 4px", color: "var(--foreground)" }}>{children}</h4>
  ),
  p: ({ children }) => <p style={{ margin: "4px 0", lineHeight: 1.7 }}>{children}</p>,
  strong: ({ children }) => <strong style={{ fontWeight: 700 }}>{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  del: ({ children }) => <del style={{ opacity: 0.7 }}>{children}</del>,
  ul: ({ children }) => <ul style={{ margin: "4px 0", paddingLeft: 22, lineHeight: 1.7 }}>{children}</ul>,
  ol: ({ children }) => <ol style={{ margin: "4px 0", paddingLeft: 22, lineHeight: 1.7 }}>{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote
      style={{ margin: "6px 0", padding: "2px 12px", borderLeft: "3px solid var(--border)", color: "var(--muted-foreground)" }}
    >
      {children}
    </blockquote>
  ),
  // インラインコードとコードブロックの<code>はどちらもこのcomponentを通る
  // (react-markdown v9以降、code componentに inline フラグは渡されなくなった)。
  // fenceの言語指定(```js)がある場合は className="language-js" が付く。
  // 言語指定が無いfenceは className が付かないため、改行の有無で判別する
  // (インラインコードは1行に収まる前提)。
  code: ({ className, children }) => {
    const isBlock = /language-/.test(className ?? "") || String(children).includes("\n");
    if (isBlock) {
      return <code style={{ fontFamily: "monospace", fontSize: "0.9em" }}>{children}</code>;
    }
    return (
      <code style={{ background: MUTED_BG, borderRadius: 4, padding: "2px 5px", fontSize: "0.9em", fontFamily: "monospace" }}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre style={{ background: MUTED_BG, borderRadius: 8, padding: "10px 12px", overflowX: "auto", margin: "6px 0" }}>
      {children}
    </pre>
  ),
  // 表はチャット幅からはみ出させない。表だけ横スクロールのコンテナに入れる。
  table: ({ children }) => (
    <div style={{ overflowX: "auto", margin: "6px 0" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.95em" }}>{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th style={{ border: "1px solid var(--border)", padding: "6px 10px", textAlign: "left", background: MUTED_BG }}>
      {children}
    </th>
  ),
  td: ({ children }) => <td style={{ border: "1px solid var(--border)", padding: "6px 10px" }}>{children}</td>,
};

export default function AgentMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  );
}
