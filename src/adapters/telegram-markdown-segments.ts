import type { MessageEntity } from 'grammy/types';

import { type EntityTextChunk, normalizeEntities } from './telegram-markdown-chunking.js';

export type Segment = EntityTextChunk;

export function plainSegment(text: string): Segment {
  return {
    text,
    entities: [],
  };
}

export function normalizeSegment(segment: Segment): Segment {
  return {
    text: segment.text,
    entities: normalizeEntities(segment.entities),
  };
}

export function prependSegment(prefix: string, segment: Segment): Segment {
  if (prefix.length === 0) {
    return segment;
  }

  return {
    text: `${prefix}${segment.text}`,
    entities: segment.entities.map(
      (entity) =>
        ({
          ...entity,
          offset: entity.offset + prefix.length,
        }) as MessageEntity,
    ),
  };
}

export function joinSegments(segments: Segment[], separator: string): Segment {
  if (segments.length === 0) {
    return plainSegment('');
  }

  const textParts: string[] = [];
  const entities: MessageEntity[] = [];
  let cursor = 0;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment || segment.text.length === 0) {
      continue;
    }

    if (textParts.length > 0 && separator.length > 0) {
      textParts.push(separator);
      cursor += separator.length;
    }

    textParts.push(segment.text);
    for (const entity of segment.entities) {
      entities.push({
        ...entity,
        offset: entity.offset + cursor,
      } as MessageEntity);
    }

    cursor += segment.text.length;
  }

  return normalizeSegment({ text: textParts.join(''), entities });
}

export function asChildren<T extends { children?: T[] }>(node: T): T[] {
  return Array.isArray(node.children) ? node.children : [];
}
