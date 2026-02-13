import type { MessageEntity } from 'grammy/types';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import {
  normalizeCodeLanguage,
  codeLanguageToExtension as resolveCodeLanguageExtension,
} from './telegram-code-language.js';
import { chunkSegmentByLength } from './telegram-markdown-chunking.js';
import {
  asChildren,
  joinSegments,
  normalizeSegment,
  plainSegment,
  prependSegment,
  type Segment,
} from './telegram-markdown-segments.js';

export interface TelegramRenderedMessage {
  text: string;
  entities: MessageEntity[];
}

export interface TelegramRenderedAttachment {
  filename: string;
  content: string;
  caption: string;
}

export interface TelegramMarkdownRenderResult {
  messages: TelegramRenderedMessage[];
  attachments: TelegramRenderedAttachment[];
}

interface TelegramMarkdownRenderOptions {
  messageLimit?: number;
  inlineCodeBlockMaxChars?: number;
  inlineCodeBlockMaxLines?: number;
}

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  lang?: string;
  ordered?: boolean;
  start?: number;
  children?: MarkdownNode[];
  alt?: string;
}

interface RenderContext {
  attachments: TelegramRenderedAttachment[];
  options: Required<TelegramMarkdownRenderOptions>;
}

const defaultMessageLimit = 3500;
const defaultInlineCodeBlockMaxChars = 1800;
const defaultInlineCodeBlockMaxLines = 48;

export function renderTelegramMarkdown(
  markdown: string,
  options: TelegramMarkdownRenderOptions = {},
): TelegramMarkdownRenderResult {
  const resolvedOptions: Required<TelegramMarkdownRenderOptions> = {
    messageLimit: options.messageLimit ?? defaultMessageLimit,
    inlineCodeBlockMaxChars: options.inlineCodeBlockMaxChars ?? defaultInlineCodeBlockMaxChars,
    inlineCodeBlockMaxLines: options.inlineCodeBlockMaxLines ?? defaultInlineCodeBlockMaxLines,
  };

  const normalized = markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const context: RenderContext = {
    attachments: [],
    options: resolvedOptions,
  };

  const root = parseMarkdownRoot(normalized);
  const rendered = root ? renderRoot(root, context) : plainSegment(normalized);
  const messages = chunkSegmentByLength(rendered, resolvedOptions.messageLimit);

  if (messages.length === 0) {
    return {
      messages: [{ text: normalized, entities: [] }],
      attachments: context.attachments,
    };
  }

  return {
    messages,
    attachments: context.attachments,
  };
}

function parseMarkdownRoot(markdown: string): MarkdownNode | null {
  try {
    return unified().use(remarkParse).use(remarkGfm).parse(markdown) as MarkdownNode;
  } catch {
    return null;
  }
}

function renderRoot(root: MarkdownNode, context: RenderContext): Segment {
  const children = asChildren(root);
  if (children.length === 0) {
    return plainSegment('');
  }

  const blocks: Segment[] = [];
  for (const child of children) {
    const rendered = renderBlock(child, context);
    if (rendered.text.trim().length === 0) {
      continue;
    }

    blocks.push(rendered);
  }

  if (blocks.length === 0) {
    return plainSegment('');
  }

  return joinSegments(blocks, '\n\n');
}

function renderBlock(node: MarkdownNode, context: RenderContext): Segment {
  switch (node.type) {
    case 'paragraph':
      return renderInlineChildren(asChildren(node), context);
    case 'heading': {
      const inline = renderInlineChildren(asChildren(node), context);
      return wrapWithEntity(inline, { type: 'bold' });
    }
    case 'code':
      return renderCodeBlock(node, context);
    case 'blockquote':
      return renderBlockquote(node, context);
    case 'list':
      return renderList(node, context);
    case 'thematicBreak':
      return plainSegment('---');
    case 'table':
      return renderTable(node, context);
    case 'html':
      return plainSegment(node.value ?? '');
    default:
      if (node.value) {
        return plainSegment(node.value);
      }

      return renderInlineChildren(asChildren(node), context);
  }
}

function renderCodeBlock(node: MarkdownNode, context: RenderContext): Segment {
  const code = node.value ?? '';
  const language = normalizeCodeLanguage(node.lang);

  if (shouldAttachCodeBlock(code, context.options)) {
    const filename = nextCodeAttachmentFilename(language, context.attachments.length + 1);
    context.attachments.push({
      filename,
      content: code,
      caption: language ? `📎 ${filename} (${language})` : `📎 ${filename}`,
    });

    return plainSegment(`📎 attached code: ${filename}`);
  }

  const content = code.length > 0 ? code : '(empty code block)';
  return {
    text: content,
    entities: [
      language
        ? {
            type: 'pre',
            offset: 0,
            length: content.length,
            language,
          }
        : {
            type: 'pre',
            offset: 0,
            length: content.length,
          },
    ],
  };
}

function renderBlockquote(node: MarkdownNode, context: RenderContext): Segment {
  const inner = joinSegments(
    asChildren(node)
      .map((child) => renderBlock(child, context))
      .filter((segment) => segment.text.trim().length > 0),
    '\n',
  );

  if (inner.text.length === 0) {
    return plainSegment('');
  }

  return plainSegment(
    inner.text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n'),
  );
}

function renderList(node: MarkdownNode, context: RenderContext): Segment {
  const items = asChildren(node);
  const ordered = node.ordered === true;
  const start = typeof node.start === 'number' && Number.isFinite(node.start) ? Math.max(1, node.start) : 1;

  const segments: Segment[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) {
      continue;
    }

    const marker = ordered ? `${start + index}. ` : '• ';
    const itemContent = renderListItem(item, context);
    if (itemContent.text.length === 0) {
      continue;
    }

    segments.push(prependSegment(marker, itemContent));
  }

  return joinSegments(segments, '\n');
}

function renderListItem(node: MarkdownNode, context: RenderContext): Segment {
  const blocks = asChildren(node)
    .map((child) => renderBlock(child, context))
    .filter((segment) => segment.text.trim().length > 0);

  if (blocks.length === 0) {
    return plainSegment('');
  }

  return joinSegments(blocks, '\n');
}

function renderTable(node: MarkdownNode, context: RenderContext): Segment {
  const rowSegments: Segment[] = [];

  for (const row of asChildren(node)) {
    if (row.type !== 'tableRow') {
      continue;
    }

    const cellTexts: string[] = [];
    for (const cell of asChildren(row)) {
      const cellSegment = renderInlineChildren(asChildren(cell), context);
      cellTexts.push(cellSegment.text.trim());
    }

    rowSegments.push(plainSegment(cellTexts.join(' | ')));
  }

  return joinSegments(rowSegments, '\n');
}

function renderInlineChildren(children: MarkdownNode[], context: RenderContext): Segment {
  const parts: Segment[] = [];
  for (const child of children) {
    parts.push(renderInline(child, context));
  }

  return joinSegments(parts, '');
}

function renderInline(node: MarkdownNode, context: RenderContext): Segment {
  switch (node.type) {
    case 'text':
      return plainSegment(node.value ?? '');
    case 'strong':
      return wrapWithEntity(renderInlineChildren(asChildren(node), context), { type: 'bold' });
    case 'emphasis':
      return wrapWithEntity(renderInlineChildren(asChildren(node), context), { type: 'italic' });
    case 'delete':
      return wrapWithEntity(renderInlineChildren(asChildren(node), context), { type: 'strikethrough' });
    case 'inlineCode': {
      const content = node.value ?? '';
      if (content.length === 0) {
        return plainSegment('');
      }

      return {
        text: content,
        entities: [
          {
            type: 'code',
            offset: 0,
            length: content.length,
          },
        ],
      };
    }
    case 'break':
      return plainSegment('\n');
    case 'link': {
      const inner = renderInlineChildren(asChildren(node), context);
      const text = inner.text.length > 0 ? inner.text : (node.url ?? '');
      if (text.length === 0) {
        return plainSegment('');
      }

      const result: Segment = {
        text,
        entities: inner.entities.filter((entity) => entity.type !== 'code' && entity.type !== 'pre'),
      };

      if (node.url && node.url.trim().length > 0) {
        result.entities.push({
          type: 'text_link',
          offset: 0,
          length: text.length,
          url: node.url,
        });
      }

      return normalizeSegment(result);
    }
    case 'image':
      return plainSegment(node.alt ?? node.url ?? '');
    default:
      if (node.value) {
        return plainSegment(node.value);
      }

      return renderInlineChildren(asChildren(node), context);
  }
}

function wrapWithEntity(segment: Segment, entity: Omit<MessageEntity, 'offset' | 'length'>): Segment {
  if (segment.text.length === 0) {
    return segment;
  }

  const wrappingEntities = buildWrappingEntities(segment, entity);
  if (wrappingEntities.length === 0) {
    return normalizeSegment(segment);
  }

  return normalizeSegment({
    text: segment.text,
    entities: [...segment.entities, ...wrappingEntities],
  });
}

function buildWrappingEntities(segment: Segment, entity: Omit<MessageEntity, 'offset' | 'length'>): MessageEntity[] {
  if (!isFormattingEntityType(entity.type)) {
    return [
      {
        ...entity,
        offset: 0,
        length: segment.text.length,
      } as MessageEntity,
    ];
  }

  const excludedRanges = collectExcludedRangesForWrapping(segment.entities);
  if (excludedRanges.length === 0) {
    return [
      {
        ...entity,
        offset: 0,
        length: segment.text.length,
      } as MessageEntity,
    ];
  }

  const wrappingEntities: MessageEntity[] = [];
  let cursor = 0;

  for (const range of excludedRanges) {
    if (range.start > cursor) {
      wrappingEntities.push({
        ...entity,
        offset: cursor,
        length: range.start - cursor,
      } as MessageEntity);
    }

    cursor = Math.max(cursor, range.end);
  }

  if (cursor < segment.text.length) {
    wrappingEntities.push({
      ...entity,
      offset: cursor,
      length: segment.text.length - cursor,
    } as MessageEntity);
  }

  return wrappingEntities;
}

function collectExcludedRangesForWrapping(entities: MessageEntity[]): Array<{ start: number; end: number }> {
  const ranges = entities
    .filter((entity) => entity.type === 'code' || entity.type === 'pre')
    .map((entity) => ({
      start: entity.offset,
      end: entity.offset + entity.length,
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  if (ranges.length === 0) {
    return [];
  }

  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
      continue;
    }

    previous.end = Math.max(previous.end, range.end);
  }

  return merged;
}

function isFormattingEntityType(type: MessageEntity['type']): boolean {
  return type === 'bold' || type === 'italic' || type === 'underline' || type === 'strikethrough' || type === 'spoiler';
}

function shouldAttachCodeBlock(code: string, options: Required<TelegramMarkdownRenderOptions>): boolean {
  if (code.length > options.inlineCodeBlockMaxChars) {
    return true;
  }

  const lineCount = code.length === 0 ? 1 : code.split('\n').length;
  return lineCount > options.inlineCodeBlockMaxLines;
}

function nextCodeAttachmentFilename(language: string | null, index: number): string {
  return `snippet-${index}.${resolveCodeLanguageExtension(language)}`;
}

export function codeLanguageToExtension(language: string | null): string {
  return resolveCodeLanguageExtension(language);
}
