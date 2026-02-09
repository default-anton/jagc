import pino, { type Logger as PinoLogger } from 'pino';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type LogLevel = (typeof logLevels)[number];
export type Logger = PinoLogger;

export const noopLogger: Logger = pino({ enabled: false });

export function resolveLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (!value) {
    return fallback;
  }

  if (isLogLevel(value)) {
    return value;
  }

  return fallback;
}

export function createLogger(
  options: { level?: LogLevel; stream?: NodeJS.WritableStream; bindings?: Record<string, unknown> } = {},
): Logger {
  const logger = pino(
    {
      level: options.level ?? 'info',
      messageKey: 'message',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
      },
    },
    options.stream,
  );

  if (!options.bindings || Object.keys(options.bindings).length === 0) {
    return logger;
  }

  return logger.child(options.bindings);
}

function isLogLevel(value: string): value is LogLevel {
  return logLevels.includes(value as LogLevel);
}
