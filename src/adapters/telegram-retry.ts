import { setTimeout as sleep } from 'node:timers/promises';

import { extractTelegramRetryAfterSeconds } from './telegram-api-errors.js';

export async function callTelegramWithRetry<T>(operation: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      const retryAfterSeconds = extractTelegramRetryAfterSeconds(error);
      if (retryAfterSeconds === null || attempt >= maxAttempts - 1) {
        throw error;
      }

      attempt += 1;
      await sleep(Math.ceil(retryAfterSeconds * 1000));
    }
  }
}
