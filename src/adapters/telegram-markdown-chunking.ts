import type { MessageEntity } from 'grammy/types';

export interface EntityTextChunk {
  text: string;
  entities: MessageEntity[];
}

export function chunkSegmentByLength(segment: EntityTextChunk, maxLength: number): EntityTextChunk[] {
  if (segment.text.length === 0) {
    return [];
  }

  const messages: EntityTextChunk[] = [];
  const entities = normalizeEntities(segment.entities);

  let start = 0;
  while (start < segment.text.length) {
    let end = Math.min(start + maxLength, segment.text.length);

    if (end < segment.text.length) {
      const breakIndex = segment.text.lastIndexOf('\n', end);
      if (breakIndex > start + Math.floor(maxLength / 3)) {
        end = breakIndex;
      }
    }

    const safeEnd = avoidSplittingEntityBoundary(entities, start, end);
    if (safeEnd > start) {
      end = safeEnd;
    }

    if (end <= start) {
      end = Math.min(start + maxLength, segment.text.length);
    }

    messages.push({
      text: segment.text.slice(start, end),
      entities: sliceEntities(entities, start, end),
    });

    start = end;
  }

  return messages;
}

export function normalizeEntities(entities: MessageEntity[]): MessageEntity[] {
  const sorted = entities
    .filter(
      (entity) =>
        Number.isInteger(entity.offset) && Number.isInteger(entity.length) && entity.offset >= 0 && entity.length > 0,
    )
    .sort((left, right) => {
      if (left.offset !== right.offset) {
        return left.offset - right.offset;
      }

      return right.length - left.length;
    });

  const normalized: MessageEntity[] = [];
  for (const candidate of sorted) {
    if (hasEquivalentEntity(normalized, candidate)) {
      continue;
    }

    let keepCandidate = true;

    for (let index = 0; index < normalized.length; index += 1) {
      const existing = normalized[index];
      if (!existing) {
        continue;
      }

      const relation = classifyOverlap(existing, candidate);
      if (relation === 'none') {
        continue;
      }

      if (relation !== 'cross' && entitiesCanCoexist(existing, candidate, relation)) {
        continue;
      }

      if (shouldReplaceExisting(existing, candidate)) {
        normalized.splice(index, 1);
        index -= 1;
        continue;
      }

      keepCandidate = false;
      break;
    }

    if (keepCandidate) {
      normalized.push(candidate);
    }
  }

  return normalized.sort((left, right) => {
    if (left.offset !== right.offset) {
      return left.offset - right.offset;
    }

    return right.length - left.length;
  });
}

type EntityOverlap = 'none' | 'cross' | 'equal' | 'existingContainsCandidate' | 'candidateContainsExisting';

function classifyOverlap(existing: MessageEntity, candidate: MessageEntity): EntityOverlap {
  const existingStart = existing.offset;
  const existingEnd = existing.offset + existing.length;
  const candidateStart = candidate.offset;
  const candidateEnd = candidate.offset + candidate.length;

  if (candidateEnd <= existingStart || existingEnd <= candidateStart) {
    return 'none';
  }

  if (existingStart === candidateStart && existingEnd === candidateEnd) {
    return 'equal';
  }

  if (existingStart <= candidateStart && existingEnd >= candidateEnd) {
    return 'existingContainsCandidate';
  }

  if (candidateStart <= existingStart && candidateEnd >= existingEnd) {
    return 'candidateContainsExisting';
  }

  return 'cross';
}

function entitiesCanCoexist(existing: MessageEntity, candidate: MessageEntity, relation: EntityOverlap): boolean {
  if (relation === 'none' || relation === 'cross') {
    return false;
  }

  if (relation === 'equal') {
    return canContain(existing, candidate) && canContain(candidate, existing);
  }

  if (relation === 'existingContainsCandidate') {
    return canContain(existing, candidate);
  }

  return canContain(candidate, existing);
}

function canContain(parent: MessageEntity, child: MessageEntity): boolean {
  if (parent.type === child.type) {
    return true;
  }

  if (isFormattingEntity(parent.type)) {
    return !isCodeEntity(child.type);
  }

  if (isFormattingEntity(child.type)) {
    return !isCodeEntity(parent.type);
  }

  if (isBlockquoteEntity(parent.type) || isBlockquoteEntity(child.type)) {
    return false;
  }

  return false;
}

function shouldReplaceExisting(existing: MessageEntity, candidate: MessageEntity): boolean {
  const existingPriority = entityPriority(existing.type);
  const candidatePriority = entityPriority(candidate.type);

  if (candidatePriority !== existingPriority) {
    return candidatePriority > existingPriority;
  }

  if (candidate.length !== existing.length) {
    return candidate.length > existing.length;
  }

  return false;
}

function entityPriority(type: MessageEntity['type']): number {
  if (type === 'text_link') {
    return 30;
  }

  if (type === 'pre') {
    return 20;
  }

  if (type === 'code') {
    return 19;
  }

  if (isFormattingEntity(type)) {
    return 10;
  }

  return 5;
}

function isFormattingEntity(type: MessageEntity['type']): boolean {
  return type === 'bold' || type === 'italic' || type === 'underline' || type === 'strikethrough' || type === 'spoiler';
}

function isCodeEntity(type: MessageEntity['type']): boolean {
  return type === 'code' || type === 'pre';
}

function isBlockquoteEntity(type: MessageEntity['type']): boolean {
  return type === 'blockquote' || type === 'expandable_blockquote';
}

function hasEquivalentEntity(entities: MessageEntity[], candidate: MessageEntity): boolean {
  const candidateUrl = messageEntityOptionalField(candidate, 'url');
  const candidateLanguage = messageEntityOptionalField(candidate, 'language');

  return entities.some(
    (entity) =>
      entity.type === candidate.type &&
      entity.offset === candidate.offset &&
      entity.length === candidate.length &&
      messageEntityOptionalField(entity, 'url') === candidateUrl &&
      messageEntityOptionalField(entity, 'language') === candidateLanguage,
  );
}

function messageEntityOptionalField(entity: MessageEntity, key: 'url' | 'language'): string | null {
  const value = (entity as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function avoidSplittingEntityBoundary(entities: MessageEntity[], start: number, end: number): number {
  let adjustedEnd = end;

  for (const entity of entities) {
    const entityStart = entity.offset;
    const entityEnd = entity.offset + entity.length;
    if (entityStart < adjustedEnd && entityEnd > adjustedEnd && entityStart > start) {
      adjustedEnd = entityStart;
    }
  }

  return adjustedEnd;
}

function sliceEntities(entities: MessageEntity[], start: number, end: number): MessageEntity[] {
  const sliced: MessageEntity[] = [];

  for (const entity of entities) {
    const entityStart = entity.offset;
    const entityEnd = entity.offset + entity.length;

    const overlapStart = Math.max(start, entityStart);
    const overlapEnd = Math.min(end, entityEnd);
    if (overlapEnd <= overlapStart) {
      continue;
    }

    sliced.push({
      ...entity,
      offset: overlapStart - start,
      length: overlapEnd - overlapStart,
    } as MessageEntity);
  }

  return sliced;
}
