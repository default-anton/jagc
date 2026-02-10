export default function codexHarnessExtension(pi: {
  on: (
    event: 'before_agent_start',
    handler: (
      event: { systemPrompt: string },
      ctx: { model?: string | { id?: string | undefined } | undefined },
    ) => Promise<{ systemPrompt: string } | undefined>,
  ) => void;
}) {
  pi.on('before_agent_start', async (event, ctx) => {
    const modelId = typeof ctx.model === 'string' ? ctx.model : typeof ctx.model?.id === 'string' ? ctx.model.id : '';

    if (!/^gpt-.*-codex$/i.test(modelId)) {
      return;
    }

    const marker = 'The pi harness does not provide an `apply_patch` tool.';
    if (event.systemPrompt.includes(marker)) {
      return;
    }

    const prompt = [
      'Harness-specific instructions:',
      '- The pi harness does not provide an `apply_patch` tool.',
      '- Never call `apply_patch`; it will fail.',
      '- Use available file-editing tools instead: `read`, `edit`, and `write`.',
    ].join('\n');

    return {
      systemPrompt: `${event.systemPrompt.trim()}\n\n---\n\n${prompt}`,
    };
  });
}
