// src/lib/logger.test.ts
// logger.ts の console互換シム(logger.warn('msg', err) 形式)が
// pinoの出力に正しくマージされることを検証する。
// 修正前は logger.warn('msg', err) の err が握りつぶされ、本番ログから
// エラー詳細が一切見えなくなっていた(実際に発生した観測不能バグ)。

import { Writable } from 'stream';
import { createLogger } from './logger';

function captureWrites(fn: (logger: ReturnType<typeof createLogger>) => void): Record<string, unknown>[] {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const logger = createLogger(undefined, stream);
  fn(logger);
  return chunks.map((c) => JSON.parse(c));
}

describe('logger console互換シム', () => {
  it('logger.warn(msg, error) → err がstack付きでログに出る', () => {
    const [line] = captureWrites((logger) => {
      logger.warn('[test]', new Error('boom'));
    });

    expect(line?.['msg']).toBe('[test]');
    expect(line?.['err']).toMatchObject({ type: 'Error', message: 'boom' });
    expect((line?.['err'] as { stack?: string })?.stack).toContain('boom');
  });

  it('logger.warn(msg, 非Error値) → argフィールドに保持される', () => {
    const [line] = captureWrites((logger) => {
      logger.warn('[test]', { orderId: 'abc' });
    });

    expect(line?.['msg']).toBe('[test]');
    expect(line?.['arg']).toEqual({ orderId: 'abc' });
  });

  it('logger.warn(obj, msg) → pinoネイティブ形式はそのまま透過する', () => {
    const [line] = captureWrites((logger) => {
      logger.warn({ foo: 'bar' }, '[test-obj]');
    });

    expect(line?.['msg']).toBe('[test-obj]');
    expect(line?.['foo']).toBe('bar');
  });

  it('logger.warn(msg) 単独呼び出しは従来通り動作する', () => {
    const [line] = captureWrites((logger) => {
      logger.warn('[test-plain]');
    });

    expect(line?.['msg']).toBe('[test-plain]');
    expect(line?.['err']).toBeUndefined();
  });
});
