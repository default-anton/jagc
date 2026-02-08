const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type LogLevel = (typeof logLevels)[number];

export type LogEntry = string | Error | Record<string, unknown>;

export interface Logger {
  error(entry: LogEntry): void;
  warn(entry: LogEntry): void;
  info(entry: LogEntry): void;
  debug(entry: LogEntry): void;
}

export const noopLogger: Logger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
};

const logLevelPriority: Readonly<Record<LogLevel, number>> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
  silent: 6,
};

export function resolveLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (!value) {
    return fallback;
  }

  if (isLogLevel(value)) {
    return value;
  }

  return fallback;
}

export function createJsonLogger(options: { level?: LogLevel; stream?: NodeJS.WritableStream } = {}): Logger {
  const level = options.level ?? 'info';
  const stream = options.stream ?? process.stderr;

  return {
    error: (entry) => writeLog(stream, level, 'error', entry),
    warn: (entry) => writeLog(stream, level, 'warn', entry),
    info: (entry) => writeLog(stream, level, 'info', entry),
    debug: (entry) => writeLog(stream, level, 'debug', entry),
  };
}

function writeLog(stream: NodeJS.WritableStream, configuredLevel: LogLevel, level: LogLevel, entry: LogEntry): void {
  if (!shouldLog(configuredLevel, level)) {
    return;
  }

  const payload = normalizeEntry(entry);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ...payload,
  });

  stream.write(`${line}\n`);
}

function shouldLog(configuredLevel: LogLevel, level: LogLevel): boolean {
  if (configuredLevel === 'silent') {
    return false;
  }

  return logLevelPriority[level] <= logLevelPriority[configuredLevel];
}

function normalizeEntry(entry: LogEntry): Record<string, unknown> {
  if (typeof entry === 'string') {
    return { message: entry };
  }

  if (entry instanceof Error) {
    return {
      message: entry.message,
      stack: entry.stack,
    };
  }

  if (entry && typeof entry === 'object') {
    return entry;
  }

  return {
    message: String(entry),
  };
}

function isLogLevel(value: string): value is LogLevel {
  return logLevels.includes(value as LogLevel);
}
