import { Writable } from 'node:stream';

import { describe, expect, test } from 'vitest';
import { createApp } from '../src/server/app.js';
import type { RunService } from '../src/server/service.js';
import { createLogger, resolveLogLevel } from '../src/shared/logger.js';

class MemoryWritable extends Writable {
  readonly chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    callback();
  }

  lines(): string[] {
    return this.chunks
      .join('')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
}

describe('logger', () => {
  test('resolveLogLevel falls back for invalid values', () => {
    expect(resolveLogLevel(undefined, 'warn')).toBe('warn');
    expect(resolveLogLevel('trace')).toBe('trace');
    expect(resolveLogLevel('not-a-level', 'error')).toBe('error');
  });

  test('createLogger emits structured JSON with child bindings', () => {
    const stream = new MemoryWritable();
    const logger = createLogger({
      level: 'debug',
      stream,
      bindings: {
        service: 'jagc',
        component: 'logger_test',
      },
    });

    logger.info({ event: 'logger_test_event', value: 42 });

    const lines = stream.lines();
    expect(lines.length).toBeGreaterThan(0);
    const payload = JSON.parse(lines[0] as string);

    expect(payload.level).toBe('info');
    expect(payload.service).toBe('jagc');
    expect(payload.component).toBe('logger_test');
    expect(payload.event).toBe('logger_test_event');
    expect(payload.value).toBe(42);
    expect(typeof payload.time).toBe('string');
  });

  test('http requests emit completion logs with request context', async () => {
    const stream = new MemoryWritable();
    const logger = createLogger({
      level: 'info',
      stream,
      bindings: {
        service: 'jagc',
        component: 'http_server',
      },
    });

    const app = createApp({
      runService: {
        ingestMessage: async () => {
          throw new Error('not used in this test');
        },
        getRun: async () => null,
      } as unknown as RunService,
      logger,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/healthz',
    });

    await app.close();

    expect(response.statusCode).toBe(200);

    const requestLog = stream
      .lines()
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.event === 'http_request_completed');

    expect(requestLog).toBeDefined();
    expect(requestLog?.method).toBe('GET');
    expect(requestLog?.status_code).toBe(200);
    expect(typeof requestLog?.request_id).toBe('string');
    expect(typeof requestLog?.duration_ms).toBe('number');
    expect(requestLog?.component).toBe('http_server');
  });
});
