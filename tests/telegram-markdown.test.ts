import type { MessageEntity } from 'grammy/types';
import { describe, expect, test } from 'vitest';

import { codeLanguageToExtension, renderTelegramMarkdown } from '../src/adapters/telegram-markdown.js';

interface MarkdownFixture {
  name: string;
  markdown: string;
  messageLimit?: number;
  expectedEntityTypes?: string[];
  expectedTextSnippets?: string[];
  expectedAttachmentExtension?: string;
}

const longPythonFixtureCode = Array.from(
  { length: 70 },
  (_, index) => `def step_${index}() -> int:\n    return ${index}`,
).join('\n\n');

const markdownFixtures: MarkdownFixture[] = [
  {
    name: 'llm-summary-with-nested-lists-and-link',
    markdown: [
      '### Plan update',
      '',
      'We should **ship** this in two slices:',
      '',
      '- Phase 1',
      '  - keep `_unsafe_default` behind config',
      '  - add `jagc doctor` follow-up',
      '- Phase 2',
      '  - remove old fallback path',
      '',
      'Reference: [tracking issue](https://example.com/issues/42)',
      '',
      '`status: green`',
    ].join('\n'),
    expectedEntityTypes: ['bold', 'text_link', 'code'],
    expectedTextSnippets: ['Plan update', 'tracking issue', 'status: green'],
  },
  {
    name: 'llm-output-with-table-and-mixed-code',
    markdown: [
      '| Area | Status |',
      '| --- | --- |',
      '| parser | ✅ |',
      '| tests | ✅ |',
      '',
      '```bash',
      'pnpm typecheck && pnpm test',
      '```',
      '',
      'Final note: use `--json` for machine-readable output.',
    ].join('\n'),
    expectedEntityTypes: ['pre', 'code'],
    expectedTextSnippets: ['Area | Status', 'pnpm typecheck && pnpm test', '--json'],
  },
  {
    name: 'llm-long-python-snippet-becomes-attachment',
    markdown: ['```python', longPythonFixtureCode, '```'].join('\n'),
    expectedTextSnippets: ['📎 attached code: snippet-1.py'],
    expectedAttachmentExtension: 'py',
  },
  {
    name: 'llm-mixed-punctuation-and-blockquote',
    markdown: [
      '> Heads-up: escape coverage should survive symbols like _ * [ ] ( ) ~ ` > # + - = | { } . !',
      '',
      'Keep **bold**, _italic_, and ~~strikethrough~~ intact.',
      '',
      '```ts',
      'const token = "abc_def-123";',
      '```',
    ].join('\n'),
    expectedEntityTypes: ['bold', 'italic', 'strikethrough', 'pre'],
    expectedTextSnippets: ['Heads-up', 'abc_def-123'],
  },
];

describe('renderTelegramMarkdown', () => {
  test('renders markdown entities for rich text and short code blocks', () => {
    const markdown = [
      'Hello **world** with `inline` and [link](https://example.com).',
      '',
      '```ts',
      'const answer: number = 42;',
      '```',
    ].join('\n');

    const rendered = renderTelegramMarkdown(markdown, { messageLimit: 3500 });

    expect(rendered.attachments).toEqual([]);
    expect(rendered.messages).toHaveLength(1);

    const first = rendered.messages[0];
    expect(first?.text).toContain('Hello world with inline and link.');
    expect(first?.text).toContain('const answer: number = 42;');

    const entityTypes = (first?.entities ?? []).map((entity) => entity.type);
    expect(entityTypes).toContain('bold');
    expect(entityTypes).toContain('code');
    expect(entityTypes).toContain('text_link');
    expect(entityTypes).toContain('pre');

    expectEntitiesRespectTelegramNestingRules(first?.entities ?? []);
  });

  test('drops inline code styling inside links to keep entities Bot-API-valid', () => {
    const rendered = renderTelegramMarkdown('[`code`](https://example.com)', { messageLimit: 3500 });

    expect(rendered.messages).toHaveLength(1);
    const message = rendered.messages[0];
    expect(message?.text).toBe('code');

    const textLinkEntity = message?.entities.find((entity) => entity.type === 'text_link');
    expect(textLinkEntity?.length).toBe(4);
    expect(textLinkEntity?.url).toBe('https://example.com');
    expect(message?.entities.some((entity) => entity.type === 'code')).toBe(false);

    expectEntitiesRespectTelegramNestingRules(message?.entities ?? []);
  });

  test('splits bold wrappers around inline code instead of overlapping code entities', () => {
    const rendered = renderTelegramMarkdown('**prefix `code` suffix**', { messageLimit: 3500 });

    expect(rendered.messages).toHaveLength(1);
    const message = rendered.messages[0];
    expect(message?.text).toBe('prefix code suffix');

    const boldEntities = (message?.entities ?? []).filter((entity) => entity.type === 'bold');
    expect(boldEntities).toHaveLength(2);
    const codeEntity = (message?.entities ?? []).find((entity) => entity.type === 'code');
    expect(codeEntity).toBeDefined();
    if (!codeEntity) {
      throw new Error('expected inline code entity');
    }

    for (const boldEntity of boldEntities) {
      expect(overlapsEntityRange(boldEntity, codeEntity)).toBe(false);
    }

    expectEntitiesRespectTelegramNestingRules(message?.entities ?? []);
  });

  test('chunks long output while keeping entity metadata on chunks', () => {
    const markdown = `**${'x'.repeat(4600)}**`;
    const rendered = renderTelegramMarkdown(markdown, { messageLimit: 1500 });

    expect(rendered.attachments).toEqual([]);
    expect(rendered.messages.length).toBeGreaterThan(1);
    expect(rendered.messages.every((message) => message.text.length <= 1500)).toBe(true);

    const reconstructed = rendered.messages.map((message) => message.text).join('');
    expect(reconstructed).toBe('x'.repeat(4600));
    expect(rendered.messages.every((message) => message.entities.some((entity) => entity.type === 'bold'))).toBe(true);
  });

  test('moves large code blocks into attachments with language-aware extension', () => {
    const longCode = Array.from({ length: 80 }, (_, index) => `const value${index}: number = ${index};`).join('\n');
    const markdown = ['```typescript', longCode, '```'].join('\n');

    const rendered = renderTelegramMarkdown(markdown, { messageLimit: 3500 });

    expect(rendered.messages).toHaveLength(1);
    expect(rendered.messages[0]?.text).toContain('📎 attached code: snippet-1.ts');
    expect(rendered.attachments).toHaveLength(1);
    expect(rendered.attachments[0]?.filename).toBe('snippet-1.ts');
    expect(rendered.attachments[0]?.content).toContain('const value0: number = 0;');
  });
});

describe('renderTelegramMarkdown fixture corpus', () => {
  test.each(markdownFixtures)('$name', (fixture) => {
    const messageLimit = fixture.messageLimit ?? 700;
    const rendered = renderTelegramMarkdown(fixture.markdown, { messageLimit });

    expect(rendered.messages.length).toBeGreaterThan(0);
    expect(rendered.messages.every((message) => message.text.length <= messageLimit)).toBe(true);

    for (const message of rendered.messages) {
      expectEntitiesWithinBounds(message.text, message.entities);
      expectEntitiesRespectTelegramNestingRules(message.entities);
    }

    const allEntityTypes = rendered.messages.flatMap((message) => message.entities.map((entity) => entity.type));
    for (const entityType of fixture.expectedEntityTypes ?? []) {
      expect(allEntityTypes).toContain(entityType);
    }

    const allText = rendered.messages.map((message) => message.text).join('\n');
    for (const snippet of fixture.expectedTextSnippets ?? []) {
      expect(allText).toContain(snippet);
    }

    if (fixture.expectedAttachmentExtension) {
      expect(rendered.attachments.length).toBeGreaterThan(0);
      expect(rendered.attachments[0]?.filename.endsWith(`.${fixture.expectedAttachmentExtension}`)).toBe(true);
    } else {
      expect(rendered.attachments).toEqual([]);
    }
  });
});

describe('codeLanguageToExtension', () => {
  test('maps common code languages to expected file extensions', () => {
    expect(codeLanguageToExtension('TypeScript')).toBe('ts');
    expect(codeLanguageToExtension('tsx')).toBe('tsx');
    expect(codeLanguageToExtension('python')).toBe('py');
    expect(codeLanguageToExtension('unknown-language')).toBe('txt');
    expect(codeLanguageToExtension(null)).toBe('txt');
  });
});

function expectEntitiesWithinBounds(text: string, entities: MessageEntity[]): void {
  for (const entity of entities) {
    expect(entity.offset).toBeGreaterThanOrEqual(0);
    expect(entity.length).toBeGreaterThan(0);
    expect(entity.offset + entity.length).toBeLessThanOrEqual(text.length);
  }
}

function expectEntitiesRespectTelegramNestingRules(entities: MessageEntity[]): void {
  for (let leftIndex = 0; leftIndex < entities.length; leftIndex += 1) {
    const left = entities[leftIndex];
    if (!left) {
      continue;
    }

    for (let rightIndex = leftIndex + 1; rightIndex < entities.length; rightIndex += 1) {
      const right = entities[rightIndex];
      if (!right) {
        continue;
      }

      const relation = classifyEntityRelation(left, right);
      if (relation === 'none') {
        continue;
      }

      expect(relation).not.toBe('cross');

      if (relation === 'leftContainsRight') {
        expect(canContainEntity(left, right)).toBe(true);
        continue;
      }

      if (relation === 'rightContainsLeft') {
        expect(canContainEntity(right, left)).toBe(true);
        continue;
      }

      if (relation === 'equal') {
        expect(canContainEntity(left, right) && canContainEntity(right, left)).toBe(true);
      }
    }
  }
}

function classifyEntityRelation(
  left: MessageEntity,
  right: MessageEntity,
): 'none' | 'cross' | 'equal' | 'leftContainsRight' | 'rightContainsLeft' {
  const leftStart = left.offset;
  const leftEnd = left.offset + left.length;
  const rightStart = right.offset;
  const rightEnd = right.offset + right.length;

  if (leftEnd <= rightStart || rightEnd <= leftStart) {
    return 'none';
  }

  if (leftStart === rightStart && leftEnd === rightEnd) {
    return 'equal';
  }

  if (leftStart <= rightStart && leftEnd >= rightEnd) {
    return 'leftContainsRight';
  }

  if (rightStart <= leftStart && rightEnd >= leftEnd) {
    return 'rightContainsLeft';
  }

  return 'cross';
}

function canContainEntity(parent: MessageEntity, child: MessageEntity): boolean {
  if (parent.type === child.type) {
    return true;
  }

  if (isFormattingType(parent.type)) {
    return !isCodeType(child.type);
  }

  if (isFormattingType(child.type)) {
    return !isCodeType(parent.type);
  }

  if (parent.type === 'blockquote' || parent.type === 'expandable_blockquote') {
    return false;
  }

  if (child.type === 'blockquote' || child.type === 'expandable_blockquote') {
    return false;
  }

  return false;
}

function isFormattingType(type: MessageEntity['type']): boolean {
  return type === 'bold' || type === 'italic' || type === 'underline' || type === 'strikethrough' || type === 'spoiler';
}

function isCodeType(type: MessageEntity['type']): boolean {
  return type === 'code' || type === 'pre';
}

function overlapsEntityRange(left: MessageEntity, right: MessageEntity): boolean {
  const leftStart = left.offset;
  const leftEnd = left.offset + left.length;
  const rightStart = right.offset;
  const rightEnd = right.offset + right.length;

  return leftStart < rightEnd && rightStart < leftEnd;
}
