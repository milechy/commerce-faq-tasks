// tests/e2e/helpers/agentChatMock.test.ts

import { readFileSync } from 'fs';
import { join } from 'path';
import { isBootstrapMessage } from './agentChatMock';

describe('isBootstrapMessage — 正常系', () => {
  it('実際の BOOTSTRAP_PROMPT 全文を渡すと true', () => {
    const prompt =
      'ログインしたところです。今週の状況を教えてください。要点と次にやるべきことを最大3つまで、簡潔に教えてください。';
    expect(isBootstrapMessage(prompt)).toBe(true);
  });

  it('ユーザーが送った通常のメッセージには反応しない', () => {
    expect(isBootstrapMessage('アバターを作りたい')).toBe(false);
    expect(isBootstrapMessage('保証について聞かれたら2年と答えて')).toBe(false);
    expect(isBootstrapMessage('採用してください')).toBe(false);
  });
});

describe('isBootstrapMessage — 境界値・異常系', () => {
  it('undefined → false（例外を投げない）', () => {
    expect(isBootstrapMessage(undefined)).toBe(false);
  });

  it('空文字 → false', () => {
    expect(isBootstrapMessage('')).toBe(false);
  });

  it('文字列以外の実行時値が来ても例外を投げず false を返す', () => {
    // route.request().postData() を JSON.parse した結果は型定義上 string|undefined だが、
    // 実行時は body の中身次第で null・数値・オブジェクトになりうる
    // (JSON.parse は any を返すため TS の型は実行時を保証しない)。
    expect(isBootstrapMessage(null as unknown as string)).toBe(false);
    expect(isBootstrapMessage(123 as unknown as string)).toBe(false);
    expect(isBootstrapMessage({} as unknown as string)).toBe(false);
    expect(isBootstrapMessage([] as unknown as string)).toBe(false);
  });

  it('マーカー文字列だけの最小一致でも true（部分一致で十分という設計）', () => {
    expect(isBootstrapMessage('ログインしたところです')).toBe(true);
  });

  it('マーカーが文中のどこにあっても true（先頭/末尾/中間で位置に依存しない）', () => {
    expect(isBootstrapMessage('ログインしたところです。続きの文章。')).toBe(true);
    expect(isBootstrapMessage('前置きの文章。ログインしたところです')).toBe(true);
    expect(isBootstrapMessage('前置き。ログインしたところです。後置き。')).toBe(true);
  });

  it('1文字でも欠けると一致しない(前方一致・後方一致の未達を区別できる)', () => {
    expect(isBootstrapMessage('ログインしたところで')).toBe(false); // 末尾1文字欠落
    expect(isBootstrapMessage('ログインしたところです'.slice(1))).toBe(false); // 先頭1文字欠落
  });
});

describe('isBootstrapMessage — ユーザーがやりそうなイレギュラーな操作', () => {
  it('似た言い回し(業種チップ・埋め込みコードの案内文)には反応しない', () => {
    // 実際に copilot-preview/index.tsx が出す他の定型文。マーカーが広すぎて
    // 別の定型文まで誤検知していないことを確認する。
    expect(
      isBootstrapMessage('初めまして！まず1つだけ教えてください。どんな業種ですか？'),
    ).toBe(false);
    expect(
      isBootstrapMessage('FAQの準備ができました。次はウィジェットをサイトに設置しましょう。'),
    ).toBe(false);
  });

  it('【既知のリスク・意図的に固定】ユーザーが偶然マーカーと同じ言葉を送ると誤検知する', () => {
    // 「ログインしたところです」は自然な日本語表現でもあるため、ユーザーが
    // (ボットへの雑談として)似た文言を送った場合、モックはそれを起動時
    // ブリーフィングと誤判定する。実運用のE2Eではユーザー役のcomposer.fill()
    // 内容を私たちが完全に制御しているため実害は無いが、この判定方式の
    // 限界として意図せず悪化しないよう固定しておく。
    expect(isBootstrapMessage('さっきログインしたところです。質問があります。')).toBe(true);
  });

  it('前後の空白・改行が付与されていても反応する(コピペ・IME確定由来のノイズを許容)', () => {
    expect(isBootstrapMessage('  ログインしたところです。今週の状況を教えてください。  ')).toBe(true);
    expect(isBootstrapMessage('\nログインしたところです。\n')).toBe(true);
  });

  it('全角/半角の表記ゆれには反応しない(厳密な部分文字列一致のため正規化しない)', () => {
    // 意図的な設計: 正規化すると「ユーザーが偶然似た文言を送ると誤検知する」リスクが
    // さらに広がるため、あえて緩めない。挙動の固定として記録する。
    expect(isBootstrapMessage('ﾛｸﾞｲﾝしたところです')).toBe(false);
  });

  it('マーカーと他の分岐キーワードが同一メッセージに同居しても true が勝つ(呼び出し側のif分岐順に依存する優先順位を明示固定)', () => {
    // 呼び出し側(qa-copilot-preview.spec.ts / qa-irregular-3roles.spec.ts)は
    // 「if (isBootstrapMessage(body.message)) { ... } else if (body.message?.includes('アバターを作りたい')) { ... }」
    // という順序のif分岐でルーティングしている。isBootstrapMessageは常に最初に
    // 評価されるため、両方のキーワードを含むメッセージは本来の分岐(アバター作成)
    // ではなく起動時ブリーフィング応答に誤ルーティングされる。この優先順位は
    // isBootstrapMessage自体の実装ではなく呼び出し側の分岐順が生む挙動だが、
    // 将来分岐順が入れ替わった際に気づけるよう、ここで固定しておく。
    expect(isBootstrapMessage('ログインしたところです。アバターを作りたいです。')).toBe(true);
    expect(isBootstrapMessage('ログインしたところです。採用してください')).toBe(true);
  });
});

describe('isBootstrapMessage — admin-ui 側の BOOTSTRAP_PROMPT とのドリフト検知', () => {
  // Asana 1217080508665459 の根本原因は「テスト側の前提が実装の変更に追従して
  // いなかった」ことだった。同じ再発を防ぐため、admin-ui 側の実際の定数文字列を
  // 読み取り、マーカーがそこに実在することを検証する。admin-ui/src の実装は
  // 一切変更しないが、将来 BOOTSTRAP_PROMPT の文言が変わってマーカーと乖離した
  // 場合は、この場で気づけるようにする(confirmPolicy.test.ts が actionExecutor.ts
  // を readFileSync して検査するのと同じパターン)。
  const INDEX_TSX_PATH = join(
    __dirname,
    '..',
    '..',
    '..',
    'admin-ui',
    'src',
    'pages',
    'copilot-preview',
    'index.tsx',
  );

  it('admin-ui/src/pages/copilot-preview/index.tsx の BOOTSTRAP_PROMPT にマーカーが含まれる', () => {
    const source = readFileSync(INDEX_TSX_PATH, 'utf8');
    // この正規表現は index.tsx 側が「二重引用符の文字列リテラル1行」で宣言されている前提に依存する。
    // テンプレートリテラル化や複数行連結に変えた場合はこの正規表現も更新すること。
    // 乖離した場合は直下の expect(match).not.toBeNull() で落ちるため、サイレント失敗はしない。
    const match = source.match(/const BOOTSTRAP_PROMPT =\s*\n?\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    const actualPrompt = match![1];
    expect(isBootstrapMessage(actualPrompt)).toBe(true);
  });
});
