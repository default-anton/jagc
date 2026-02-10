import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function escapeXmlAttribute(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatPathForPrompt(filePath: string): string {
  const homeDir = os.homedir();
  if (filePath === homeDir) {
    return '~';
  }
  if (filePath.startsWith(`${homeDir}${path.sep}`)) {
    return `~${filePath.slice(homeDir.length)}`;
  }
  return filePath;
}

export default function globalAgentsLoaderExtension(pi: {
  on: (
    event: 'before_agent_start',
    handler: (event: { systemPrompt: string }, ctx: { cwd: string }) => Promise<{ systemPrompt: string } | undefined>,
  ) => void;
}) {
  pi.on('before_agent_start', async (event, ctx) => {
    const marker = 'Global AGENTS.md purpose:';
    if (event.systemPrompt.includes(marker)) {
      return;
    }

    const agentDir = ctx.cwd;
    const globalAgentsPath = path.join(agentDir, 'AGENTS.md');

    if (!fs.existsSync(globalAgentsPath)) {
      return;
    }

    const globalAgentsContent = fs.readFileSync(globalAgentsPath, 'utf-8').trim();
    const promptLines = [
      marker,
      '- Global AGENTS.md defines baseline instructions that apply across chats and projects.',
      '- AGENTS.md instructions are hierarchical: global AGENTS.md is the baseline, and subdir AGENTS.md files define local rules for that subtree.',
      '- Subdir AGENTS.md files are auto-loaded when you use the read tool on files in that subtree.',
      '',
      `Global AGENTS.md: ${formatPathForPrompt(globalAgentsPath)} (applies to all projects)`,
      `Your skills are located in: ${formatPathForPrompt(path.join(agentDir, 'skills'))}/`,
      `Your extensions are located in: ${formatPathForPrompt(path.join(agentDir, 'extensions'))}/`,
      '',
      'AGENTS.md files:',
      '<agents_files>',
      `<agent_file path="${escapeXmlAttribute(formatPathForPrompt(globalAgentsPath))}">`,
      globalAgentsContent,
      '</agent_file>',
      '</agents_files>',
    ];

    return {
      systemPrompt: `${event.systemPrompt.trim()}\n\n---\n\n${promptLines.join('\n')}`,
    };
  });
}
