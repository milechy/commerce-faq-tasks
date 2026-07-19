// src/lib/logger.ts
// Shared pino logger with a console-compatible call signature.
// Accepts (msg, ...args) in addition to pino's native (obj, msg) form.

import pino from 'pino';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LogFn = (msgOrObj: any, msgOrArg?: any, ...rest: any[]) => void;

export interface AppLogger {
  info: LogFn;
  error: LogFn;
  warn: LogFn;
  debug: LogFn;
  trace: LogFn;
  fatal: LogFn;
  child(bindings: Record<string, unknown>): AppLogger;
}

type PinoLevel = 'info' | 'error' | 'warn' | 'debug' | 'trace' | 'fatal';

// pinoの本来のシグネチャは (mergingObject, msg?, ...) で、第一引数が文字列の場合
// 後続の引数はprintf形式の埋め込み値としてしか扱われない。そのため
// logger.warn('message', err) のようなconsole互換の呼び出しではerrが
// ログに一切出力されず握りつぶされていた。ここで第一引数が文字列かつ
// 第二引数以降がある場合は { err } または { arg } に包んでマージオブジェクト
// 化し、pinoのerrシリアライザ(スタックトレース等)が効くようにする。
function wrapLevel(base: pino.Logger, level: PinoLevel): LogFn {
  return (msgOrObj: unknown, msgOrArg?: unknown, ...rest: unknown[]) => {
    if (typeof msgOrObj === 'object' && msgOrObj !== null) {
      (base[level] as LogFn)(msgOrObj, msgOrArg, ...rest);
      return;
    }
    if (msgOrArg === undefined) {
      (base[level] as LogFn)(msgOrObj);
      return;
    }
    const extras = rest.length > 0 ? [msgOrArg, ...rest] : msgOrArg;
    const mergingObject = extras instanceof Error ? { err: extras } : { arg: extras };
    (base[level] as LogFn)(mergingObject, msgOrObj as string);
  };
}

function wrapPinoInstance(base: pino.Logger): AppLogger {
  return {
    info: wrapLevel(base, 'info'),
    error: wrapLevel(base, 'error'),
    warn: wrapLevel(base, 'warn'),
    debug: wrapLevel(base, 'debug'),
    trace: wrapLevel(base, 'trace'),
    fatal: wrapLevel(base, 'fatal'),
    child: (bindings: Record<string, unknown>) => wrapPinoInstance(base.child(bindings)),
  };
}

// destination はテストで同期的な収集用ストリームを注入するためのみに使用する
// (pino のデフォルトはstdoutへの非同期書き込みのため、テストでの出力検証に向かない)
export function createLogger(options?: pino.LoggerOptions, destination?: pino.DestinationStream): AppLogger {
  const base = pino(
    {
      level: process.env.LOG_LEVEL ?? 'info',
      serializers: { err: pino.stdSerializers.err },
      ...options,
    },
    destination,
  );
  return wrapPinoInstance(base);
}

export const logger: AppLogger = createLogger();
