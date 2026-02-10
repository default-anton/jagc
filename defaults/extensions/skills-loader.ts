import * as os from 'node:os';
import * as path from 'node:path';

import { DefaultResourceLoader, SettingsManager } from '@mariozechner/pi-coding-agent';

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

async function loadSkills(cwd: string) {
  const settingsManager = SettingsManager.create(cwd, cwd);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
  });

  await resourceLoader.reload();

  const { skills } = resourceLoader.getSkills();
  return skills.filter((skill) => !skill.disableModelInvocation);
}

export default function skillsLoaderExtension(pi: {
  on: (
    event: 'before_agent_start',
    handler: (event: { systemPrompt: string }, ctx: { cwd: string }) => Promise<{ systemPrompt: string } | undefined>,
  ) => void;
}) {
  pi.on('before_agent_start', async (event, ctx) => {
    if (event.systemPrompt.includes('<available_skills>')) {
      return;
    }

    const skills = await loadSkills(ctx.cwd);
    if (skills.length === 0) {
      return;
    }

    const lines = [
      'The following skills provide specialized instructions for specific tasks.',
      "Use the read tool to load a skill file when you're about to perform the kind of work the skill prescribes, not just mention it.",
      '<available_skills>',
    ];

    for (const skill of skills) {
      lines.push(
        `<skill name="${escapeXmlAttribute(skill.name.trim())}" path="${escapeXmlAttribute(formatPathForPrompt(skill.filePath))}">`,
      );
      lines.push('<description>');
      lines.push(skill.description.trim());
      lines.push('</description>');
      lines.push('</skill>');
    }

    lines.push('</available_skills>');

    return {
      systemPrompt: `${event.systemPrompt.trim()}\n\n---\n\n${lines.join('\n')}`,
    };
  });
}
