// tests/widget/animatedAvatarMode.test.ts
// widget.js の data-avatar-mode="animated" / data-avatar-image-url によるアバター表示分岐
// (LiveKit/Anam への接続を一切行わず、コスト0のCSSアバターのみ表示する仕組み) のユニットテスト。
//
// jsdom 依存を避けるため（このリポジトリの jest は testEnvironment: "node" 固定で、
// 他の widget テストと同様の方針）、DOM 操作は最小限のフェイク要素で代替する。
// public/widget.js:1153-1181 (showAnimatedAvatarPlaceholder / buildAnimatedAvatarEl) と
// public/widget.js:2181, 2942 付近 (avatarMode ガード) のロジックを同一に保つこと。
// 実ファイル側の乖離検知は widgetSourceInvariants.test.ts が担う。

interface FakeEl {
  tagName: string;
  className: string;
  textContent: string;
  src?: string;
  alt?: string;
  attrs: Record<string, string>;
  children: FakeEl[];
  appendChild(child: FakeEl): void;
  setAttribute(k: string, v: string): void;
}

function makeFakeEl(tagName: string): FakeEl {
  return {
    tagName,
    className: '',
    textContent: '',
    attrs: {},
    children: [],
    appendChild(child: FakeEl) {
      this.children.push(child);
    },
    setAttribute(k: string, v: string) {
      this.attrs[k] = v;
    },
  };
}

function makeFakeDocument() {
  return {
    createElement(tag: string) {
      return makeFakeEl(tag);
    },
  };
}

// public/widget.js: buildAnimatedAvatarEl() と同一ロジック
function buildAnimatedAvatarEl(doc: ReturnType<typeof makeFakeDocument>, avatarModeImageUrl: string): FakeEl {
  if (avatarModeImageUrl) {
    const wrap = doc.createElement('div');
    wrap.className = 'avatar-animated-img-wrap';
    const ring = doc.createElement('div');
    ring.className = 'avatar-animated-ring';
    const img = doc.createElement('img');
    img.src = avatarModeImageUrl;
    img.alt = 'アバター';
    wrap.appendChild(img);
    wrap.appendChild(ring);
    wrap.setAttribute('aria-hidden', 'true');
    return wrap;
  }
  const el = doc.createElement('div');
  el.className = 'avatar-animated';
  el.textContent = '🤖';
  el.setAttribute('aria-hidden', 'true');
  return el;
}

// public/widget.js: showAnimatedAvatarPlaceholder() の二重表示ガード相当を再現
function makeAvatarAreaController(doc: ReturnType<typeof makeFakeDocument>, avatarModeImageUrl: string) {
  const avatarArea = makeFakeEl('div');
  let placeholder: FakeEl | null = null;
  const fabAppendCalls: FakeEl[] = [];

  function showAnimatedAvatarPlaceholder(hasFabVideo: boolean) {
    if (placeholder) return; // 既に表示中なら何もしない
    const el = buildAnimatedAvatarEl(doc, avatarModeImageUrl);
    placeholder = el;
    avatarArea.appendChild(el);
    if (!hasFabVideo) {
      fabAppendCalls.push(buildAnimatedAvatarEl(doc, avatarModeImageUrl));
    }
  }

  return { avatarArea, showAnimatedAvatarPlaceholder, fabAppendCalls, getPlaceholder: () => placeholder };
}

// public/widget.js の openPanel() / 事前フェッチ箇所にある分岐条件そのもの
function shouldConnectLiveAvatar(avatarMode: string): boolean {
  return avatarMode !== 'animated';
}

describe('widget.js animated avatar mode', () => {
  // ===== 1. 正常系 =====
  describe('正常系', () => {
    it('data-avatar-image-url 指定時は img + パルスリングの構造になる', () => {
      const doc = makeFakeDocument();
      const el = buildAnimatedAvatarEl(doc, 'https://example.com/avatar.png');
      expect(el.className).toBe('avatar-animated-img-wrap');
      expect(el.children).toHaveLength(2);
      const [img, ring] = el.children;
      expect(img.tagName).toBe('img');
      expect(img.src).toBe('https://example.com/avatar.png');
      expect(ring.className).toBe('avatar-animated-ring');
    });

    it('data-avatar-image-url 未指定時は絵文字divにフォールバックする', () => {
      const doc = makeFakeDocument();
      const el = buildAnimatedAvatarEl(doc, '');
      expect(el.className).toBe('avatar-animated');
      expect(el.textContent).toBe('🤖');
      expect(el.children).toHaveLength(0);
    });

    it('avatarMode="animated" のときは LiveKit 接続を行わない（shouldConnectLiveAvatar=false）', () => {
      expect(shouldConnectLiveAvatar('animated')).toBe(false);
    });

    it('avatarMode 未指定（既存顧客）のときは従来通り LiveKit 接続する', () => {
      expect(shouldConnectLiveAvatar('')).toBe(true);
    });

    it('aria-hidden="true" が両バリエーションとも設定される（装飾要素としてスクリーンリーダーに読ませない）', () => {
      const doc = makeFakeDocument();
      expect(buildAnimatedAvatarEl(doc, 'https://example.com/a.png').attrs['aria-hidden']).toBe('true');
      expect(buildAnimatedAvatarEl(doc, '').attrs['aria-hidden']).toBe('true');
    });
  });

  // ===== 2. 境界値・異常系 =====
  describe('境界値・異常系', () => {
    it('data-avatar-mode に "animated" 以外の値（typo・大文字違い）が来ても既存の音声アバター動作を維持する（安全側デフォルト）', () => {
      expect(shouldConnectLiveAvatar('Animated')).toBe(true);
      expect(shouldConnectLiveAvatar('ANIMATED')).toBe(true);
      expect(shouldConnectLiveAvatar('animate')).toBe(true);
      expect(shouldConnectLiveAvatar('true')).toBe(true);
      expect(shouldConnectLiveAvatar('1')).toBe(true);
    });

    it('data-avatar-image-url が空文字なら画像ではなく絵文字にフォールバックする', () => {
      const doc = makeFakeDocument();
      const el = buildAnimatedAvatarEl(doc, '');
      expect(el.className).not.toBe('avatar-animated-img-wrap');
    });

    it('data-avatar-image-url が不正なURL文字列でも例外を投げない（表示は img.src が壊れるだけで widget 自体は落ちない）', () => {
      const doc = makeFakeDocument();
      expect(() => buildAnimatedAvatarEl(doc, 'not a url ' + '<>"\'')).not.toThrow();
    });
  });

  // ===== 3. イレギュラーなユーザー操作 =====
  describe('イレギュラーなユーザー操作', () => {
    it('FABを連打してパネルを何度も開いても、アバター要素は1回しか生成・追加されない', () => {
      const doc = makeFakeDocument();
      const ctrl = makeAvatarAreaController(doc, 'https://example.com/a.png');
      ctrl.showAnimatedAvatarPlaceholder(false);
      ctrl.showAnimatedAvatarPlaceholder(false);
      ctrl.showAnimatedAvatarPlaceholder(false);
      expect(ctrl.avatarArea.children).toHaveLength(1);
    });

    it('FABに既存の動画要素がある場合は、FAB側には重ねて追加しない', () => {
      const doc = makeFakeDocument();
      const ctrl = makeAvatarAreaController(doc, 'https://example.com/a.png');
      ctrl.showAnimatedAvatarPlaceholder(true); // hasFabVideo=true
      expect(ctrl.fabAppendCalls).toHaveLength(0);
      expect(ctrl.avatarArea.children).toHaveLength(1); // avatarArea 側には表示される
    });

    it('画面を閉じて別テナント想定の設定(画像URLなし)で再度開いても、都度正しいバリエーションを生成する（毎回 buildAnimatedAvatarEl を新規呼び出しする前提の確認）', () => {
      const doc = makeFakeDocument();
      const withImage = buildAnimatedAvatarEl(doc, 'https://example.com/a.png');
      const withoutImage = buildAnimatedAvatarEl(doc, '');
      expect(withImage.className).toBe('avatar-animated-img-wrap');
      expect(withoutImage.className).toBe('avatar-animated');
    });
  });
});
