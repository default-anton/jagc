import { describe, expect, test } from 'vitest';

import runtimeHarnessContextExtension from '../defaults/extensions/20-runtime-harness-context.js';

type BeforeAgentStartHandler = (
  event: { systemPrompt: string },
  ctx: { cwd: string },
) => Promise<{ systemPrompt: string } | undefined>;

describe('runtimeHarnessContextExtension', () => {
  test('injects runtime/harness context and pi documentation references', async () => {
    let handler: BeforeAgentStartHandler | undefined;

    runtimeHarnessContextExtension({
      on: (event, registeredHandler) => {
        expect(event).toBe('before_agent_start');
        handler = registeredHandler;
      },
    });

    expect(handler).toBeDefined();

    const result = await handler?.({ systemPrompt: 'Base system prompt.' }, { cwd: process.cwd() });

    expect(result).toBeDefined();
    expect(result?.systemPrompt).toContain('Runtime/harness context (jagc + pi):');
    expect(result?.systemPrompt).toContain('Your harness is [jagc]');
    expect(result?.systemPrompt).toContain('jagc wraps pi coding agent');
    expect(result?.systemPrompt).toContain('Use the `jagc` CLI when helpful');
    expect(result?.systemPrompt).toContain('Pi documentation (consult when needed for jagc/pi implementation work):');
    expect(result?.systemPrompt).toContain('docs/extensions.md');
    expect(result?.systemPrompt).toContain('docs/packages.md');
    expect(result?.systemPrompt).toContain('Themes/TUI/keybindings are usually irrelevant for jagc runtime work');
  });

  test('does not append duplicate runtime/harness context or docs instructions', async () => {
    let handler: BeforeAgentStartHandler | undefined;

    runtimeHarnessContextExtension({
      on: (_event, registeredHandler) => {
        handler = registeredHandler;
      },
    });

    expect(handler).toBeDefined();

    const result = await handler?.(
      {
        systemPrompt:
          'Base system prompt.\n\nRuntime/harness context (jagc + pi):\n\nPi documentation (consult when needed for jagc/pi implementation work):',
      },
      { cwd: process.cwd() },
    );

    expect(result).toBeUndefined();
  });

  test('still injects runtime context when docs marker already exists', async () => {
    let handler: BeforeAgentStartHandler | undefined;

    runtimeHarnessContextExtension({
      on: (_event, registeredHandler) => {
        handler = registeredHandler;
      },
    });

    expect(handler).toBeDefined();

    const result = await handler?.(
      {
        systemPrompt: 'Base system prompt.\n\nPi documentation (consult when needed for jagc/pi implementation work):',
      },
      { cwd: process.cwd() },
    );

    expect(result).toBeDefined();
    expect(result?.systemPrompt).toContain('Runtime/harness context (jagc + pi):');
  });
});
