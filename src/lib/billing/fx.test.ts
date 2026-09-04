/**
 * fx.ts（USD→JPY 換算の唯一の出どころ）のテスト。
 *
 * ここで固定したいのは「レートが1本であること」と「算出不可を 0 に倒さないこと」。
 * 0 に倒すと粗利画面で「原価ゼロ＝粗利＝売上」という嘘の数字が出る（禁止20）。
 */

describe('fx', () => {
  const ORIGINAL = process.env.USD_JPY_RATE;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.USD_JPY_RATE;
    else process.env.USD_JPY_RATE = ORIGINAL;
    jest.resetModules();
  });

  /** USD_JPY_RATE はモジュール読み込み時に確定するため、env を変える度に読み直す。 */
  function loadFx(rate?: string) {
    jest.resetModules();
    if (rate === undefined) delete process.env.USD_JPY_RATE;
    else process.env.USD_JPY_RATE = rate;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./fx') as typeof import('./fx');
  }

  describe('USD_JPY_RATE の既定値', () => {
    it('未設定なら 150（移行前に唯一存在した換算箇所と同じ値）', () => {
      expect(loadFx(undefined).USD_JPY_RATE).toBe(150);
    });

    it('env で上書きできる', () => {
      expect(loadFx('160').USD_JPY_RATE).toBe(160);
    });

    it('0 は設定ミスとして既定へ倒す（原価が全額0円になるのを防ぐ）', () => {
      expect(loadFx('0').USD_JPY_RATE).toBe(150);
    });

    it('数値でない値も既定へ倒す', () => {
      expect(loadFx('abc').USD_JPY_RATE).toBe(150);
    });

    it('★負の値は既定へ倒す★(env のタイプミスで容易に混入し、原価が負円になる)', () => {
      expect(loadFx('-100').USD_JPY_RATE).toBe(150);
      expect(loadFx('-0.01').USD_JPY_RATE).toBe(150);
    });

    it('Infinity / -Infinity も既定へ倒す', () => {
      expect(loadFx('Infinity').USD_JPY_RATE).toBe(150);
      expect(loadFx('-Infinity').USD_JPY_RATE).toBe(150);
    });

    it('極端に小さい正の値(0.0001)はそのまま通す(0 とは別物)', () => {
      expect(loadFx('0.0001').USD_JPY_RATE).toBe(0.0001);
    });

    it('先頭・末尾に空白を含む文字列は Number() の変換規則どおり通す', () => {
      // Number(' 160 ') === 160 (JS の仕様)。env の書式ゆれで落ちないことを確認。
      expect(loadFx(' 160 ').USD_JPY_RATE).toBe(160);
    });
  });

  describe('usdToJpy', () => {
    it('レートを掛けて四捨五入する', () => {
      const { usdToJpy } = loadFx(undefined);
      expect(usdToJpy(1.23)).toBe(Math.round(1.23 * 150)); // 185
      expect(usdToJpy(0)).toBe(0);
    });

    it('★算出不可は 0 ではなく null★', () => {
      const { usdToJpy } = loadFx(undefined);
      expect(usdToJpy(null)).toBeNull();
      expect(usdToJpy(undefined)).toBeNull();
      expect(usdToJpy(NaN)).toBeNull();
      expect(usdToJpy(Infinity)).toBeNull();
    });
  });

  describe('usdCentsToJpy', () => {
    it('セントを USD に直してから換算する', () => {
      const { usdCentsToJpy } = loadFx(undefined);
      expect(usdCentsToJpy(100)).toBe(150);   // $1.00 → ¥150
      expect(usdCentsToJpy(1234)).toBe(Math.round(12.34 * 150));
    });

    it('★算出不可は 0 ではなく null★（cost_base_cents が NULL の行を 0 円にしない）', () => {
      const { usdCentsToJpy } = loadFx(undefined);
      expect(usdCentsToJpy(null)).toBeNull();
      expect(usdCentsToJpy(undefined)).toBeNull();
    });

    it('0 セントは 0 円（NULL とは別物）', () => {
      const { usdCentsToJpy } = loadFx(undefined);
      expect(usdCentsToJpy(0)).toBe(0);
    });
  });

  describe('fxMeta', () => {
    it('レートの出どころを開示する（固定レート概算であることを構造で示す）', () => {
      expect(loadFx(undefined).fxMeta()).toEqual({
        usd_jpy: 150, source: 'default', basis: 'fixed_rate_estimate',
      });
      expect(loadFx('160').fxMeta()).toEqual({
        usd_jpy: 160, source: 'env:USD_JPY_RATE', basis: 'fixed_rate_estimate',
      });
    });
  });
});
