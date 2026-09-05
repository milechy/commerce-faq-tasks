// tests/widget/buildResourceCard.test.ts
// 資料オファー機能(public/widget.js:2637-2654 buildResourceCard())のユニットテスト。
//
// jsdom 依存を避けるため（このリポジトリの jest は testEnvironment: "node" 固定で、
// 他の widget テストと同様の方針）、DOM 操作は最小限のフェイク要素で代替する
// (tests/widget/animatedAvatarMode.test.ts と同一パターン: ロジックをコピーして
// フェイクdocument/要素でテストする)。
// public/widget.js:997-1020 (el() ヘルパー) と 2637-2654 (buildResourceCard()) の
// ロジックを同一に保つこと。実ファイル側の乖離検知は widgetSourceInvariants.test.ts が担う。

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  style: Record<string, string>;
  attrs: Record<string, string>;
  children: FakeEl[];
  clickListeners: Array<() => void>;
  appendChild(child: FakeEl): void;
  setAttribute(k: string, v: string): void;
  addEventListener(event: string, cb: () => void): void;
}

function makeFakeEl(tagName: string): FakeEl {
  const fakeEl: FakeEl = {
    tagName,
    className: '',
    textContent: '',
    style: {},
    attrs: {},
    children: [],
    clickListeners: [],
    appendChild(child: FakeEl) {
      this.children.push(child);
    },
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
    addEventListener(event: string, cb: () => void) {
      if (event === 'click') this.clickListeners.push(cb);
    },
  };
  // innerHTML は widget.js が書籍内容/AI回答/資料タイトル等のXSS対策として一切使わない
  // 方針(CLAUDE.md禁止40と同じ思想)。buildResourceCard がもし innerHTML へ書き込もうと
  // すれば、この毒(poison)がテストを確実に落とす。
  Object.defineProperty(fakeEl, 'innerHTML', {
    set() {
      throw new Error('buildResourceCard must never assign innerHTML (XSS risk)');
    },
    get() {
      return '';
    },
  });
  return fakeEl;
}

function makeFakeDocument() {
  return {
    createElement(tag: string) {
      return makeFakeEl(tag);
    },
    createTextNode(text: string) {
      const node = makeFakeEl('#text');
      node.textContent = text;
      return node;
    },
  };
}

type FakeDocument = ReturnType<typeof makeFakeDocument>;

// public/widget.js: el(tag, attrs, children) と同一ロジック
function el(
  doc: FakeDocument,
  tag: string,
  attrs?: Record<string, unknown>,
  children?: unknown
): FakeEl {
  const node = doc.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach((k) => {
      if (k === 'className') {
        node.className = attrs[k] as string;
      } else if (k === 'style') {
        Object.assign(node.style, attrs[k] as Record<string, string>);
      } else {
        node.setAttribute(k, attrs[k] as string);
      }
    });
  }
  if (children) {
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (typeof c === 'string') {
        node.appendChild(doc.createTextNode(c));
      } else if (c) {
        node.appendChild(c as FakeEl);
      }
    });
  }
  return node;
}

interface FakeTracker {
  calls: unknown[][];
  track(...args: unknown[]): void;
}

function makeFakeTracker(): FakeTracker {
  return {
    calls: [],
    track(...args: unknown[]) {
      this.calls.push(args);
    },
  };
}

// public/widget.js: buildResourceCard(resourceCard) と同一ロジック
// (_tracker/tenantId はモジュールスコープ変数だが、テスト用に引数として明示的に渡す)
function buildResourceCard(
  doc: FakeDocument,
  resourceCard: { title: string; url: string },
  _tracker: FakeTracker | null,
  tenantId: string
): FakeEl {
  const card = el(doc, 'div', { className: 'resource-card' });
  const titleEl = el(doc, 'div', { className: 'resource-card-title' });
  titleEl.textContent = resourceCard.title;
  card.appendChild(titleEl);
  const link = el(doc, 'a', {
    className: 'resource-card-link',
    href: resourceCard.url,
    target: '_blank',
    rel: 'noopener',
  });
  link.textContent = '資料を見る';
  link.addEventListener('click', function () {
    if (_tracker) _tracker.track('resource_clicked', { tenant_id: tenantId });
  });
  card.appendChild(link);
  return card;
}

describe('widget.js buildResourceCard (資料オファー)', () => {
  // ===== 1. 正常系 =====
  describe('正常系', () => {
    it('タイトルと資料リンク(href/target/rel)が期待通りに構築される', () => {
      const doc = makeFakeDocument();
      const card = buildResourceCard(
        doc,
        { title: '資料タイトル', url: 'https://example.com/doc.pdf' },
        makeFakeTracker(),
        'tenant-1'
      );

      expect(card.className).toBe('resource-card');
      expect(card.children).toHaveLength(2);
      const [titleEl, link] = card.children;
      expect(titleEl.className).toBe('resource-card-title');
      expect(titleEl.textContent).toBe('資料タイトル');

      expect(link.tagName).toBe('a');
      expect(link.className).toBe('resource-card-link');
      expect(link.attrs.href).toBe('https://example.com/doc.pdf');
      expect(link.attrs.target).toBe('_blank');
      expect(link.attrs.rel).toBe('noopener');
      expect(link.textContent).toBe('資料を見る');
    });

    it('リンククリックで resource_clicked トラッキングが tenant_id のみを添えて送られる(書籍/RAG内容は含めない)', () => {
      const doc = makeFakeDocument();
      const tracker = makeFakeTracker();
      const card = buildResourceCard(
        doc,
        { title: 'x', url: 'https://example.com/a.pdf' },
        tracker,
        'tenant-9'
      );
      const link = card.children[1];
      link.clickListeners.forEach((cb) => cb());
      expect(tracker.calls).toEqual([['resource_clicked', { tenant_id: 'tenant-9' }]]);
    });

    it('_tracker が未初期化(null)でもクリック時に例外を投げない', () => {
      const doc = makeFakeDocument();
      const card = buildResourceCard(doc, { title: 'x', url: 'https://example.com/a.pdf' }, null, 'tenant-1');
      const link = card.children[1];
      expect(() => link.clickListeners.forEach((cb) => cb())).not.toThrow();
    });
  });

  // ===== 2. 境界値・異常系 =====
  describe('境界値・異常系', () => {
    it('既知の制約: buildResourceCardはURLスキームを検証しない(サーバ側isValidExternalResourceUrlのみが防御層)', () => {
      // src/api/admin/resources/routes.ts の isValidExternalResourceUrl が
      // external_url 保存時に http/https のみ許可しているが、buildResourceCard自体は
      // resourceCard.url をスキーム検証なしでそのまま href に渡す唯一の描画経路。
      // このテストは「現状そのまま渡っていること」を固定するものであり、
      // 将来ここにクライアント側バリデーションを足すかどうかの意思決定はしない。
      const doc = makeFakeDocument();
      const card = buildResourceCard(
        doc,
        { title: 'x', url: 'javascript:alert(1)' },
        makeFakeTracker(),
        'tenant-1'
      );
      const link = card.children[1];
      expect(link.attrs.href).toBe('javascript:alert(1)');
    });

    it('タイトルに<script>タグを含む文字列が来ても、textContentへ設定されるだけでマークアップとして解釈されない(innerHTML不使用のXSS対策)', () => {
      const doc = makeFakeDocument();
      const malicious = '<script>alert(1)</script>';
      const card = buildResourceCard(
        doc,
        { title: malicious, url: 'https://example.com/a.pdf' },
        makeFakeTracker(),
        'tenant-1'
      );
      const titleEl = card.children[0];
      // 文字列がそのまま(パース/実行されず)テキストとして残っている
      expect(titleEl.textContent).toBe(malicious);
    });

    it('urlが空文字でも例外を投げない(表示は壊れるだけでwidget自体は落ちない)', () => {
      const doc = makeFakeDocument();
      expect(() =>
        buildResourceCard(doc, { title: 'x', url: '' }, makeFakeTracker(), 'tenant-1')
      ).not.toThrow();
    });

    it('titleが空文字でも例外を投げない', () => {
      const doc = makeFakeDocument();
      const card = buildResourceCard(
        doc,
        { title: '', url: 'https://example.com/a.pdf' },
        makeFakeTracker(),
        'tenant-1'
      );
      expect(card.children[0].textContent).toBe('');
    });
  });
});
