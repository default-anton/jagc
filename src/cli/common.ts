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

export function exitWithError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
