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

export function createLogger(options?: pino.LoggerOptions): AppLogger {
  return pino({
    level: process.env.LOG_LEVEL ?? 'info',
    ...options,
  }) as unknown as AppLogger;
}

export const logger: AppLogger = createLogger();
