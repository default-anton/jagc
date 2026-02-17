import { maxProgressToolLabelChars, truncateLine, truncateMessage } from './telegram-progress-helpers.js';

export interface ArchiveChunk {
  text: string;
  lineCount: number;
}

export function chunkArchiveLines(lines: string[], maxLength: number, header: string): ArchiveChunk[] {
  if (lines.length === 0) {
    return [];
  }

  const chunks: ArchiveChunk[] = [];
  let current = '';
  let currentLineCount = 0;

  const headerPrefix = `${header}\n`;

  for (const line of lines) {
    const normalizedLine = truncateLine(line, maxProgressToolLabelChars);
    if (normalizedLine.length === 0) {
      continue;
    }

    const withLine = current.length === 0 ? normalizedLine : `${current}\n${normalizedLine}`;
    const wrappedWithLine = `${headerPrefix}${withLine}`;

    if (wrappedWithLine.length <= maxLength) {
      current = withLine;
      currentLineCount += 1;
      continue;
    }

    if (current.length > 0) {
      chunks.push({
        text: truncateMessage(`${headerPrefix}${current}`, maxLength),
        lineCount: currentLineCount,
      });
      current = normalizedLine;
      currentLineCount = 1;
      continue;
    }

    chunks.push({
      text: truncateMessage(`${headerPrefix}${normalizedLine}`, maxLength),
      lineCount: 1,
    });
    current = '';
    currentLineCount = 0;
  }

  if (current.length > 0) {
    chunks.push({
      text: truncateMessage(`${headerPrefix}${current}`, maxLength),
      lineCount: currentLineCount,
    });
  }

  return chunks;
}
