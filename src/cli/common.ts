import { InvalidArgumentError } from 'commander';

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function parsePositiveNumber(value: string): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('must be a positive number');
  }

  return parsed;
}

export function exitWithError(error: unknown, options: { json?: boolean } = {}): never {
  const message = error instanceof Error ? error.message : String(error);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ error: { message } })}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }

  process.exit(1);
}
