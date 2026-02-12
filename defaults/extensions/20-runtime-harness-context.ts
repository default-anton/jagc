import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

function toFilePath(urlOrPath: string): string {
  if (urlOrPath.startsWith('file://')) {
    return fileURLToPath(urlOrPath);
  }

  return urlOrPath;
}

function findPiPackageDirectory(entryFilePath: string): string | undefined {
  let currentDirectory = path.dirname(entryFilePath);

  for (let index = 0; index < 8; index += 1) {
    const readmePath = path.join(currentDirectory, 'README.md');
    const docsPath = path.join(currentDirectory, 'docs');
    const examplesPath = path.join(currentDirectory, 'examples');

    if (fs.existsSync(readmePath) && fs.existsSync(docsPath) && fs.existsSync(examplesPath)) {
      return currentDirectory;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      break;
    }

    currentDirectory = parentDirectory;
  }

  return undefined;
}

function resolvePiDocumentationPaths():
  | {
      readmePath: string;
      docsPath: string;
      examplesPath: string;
    }
  | undefined {
  if (typeof import.meta.resolve !== 'function') {
    return undefined;
  }

  let piEntryPath: string;
  try {
    piEntryPath = toFilePath(import.meta.resolve('@mariozechner/pi-coding-agent'));
  } catch {
    return undefined;
  }

  const packageDirectory = findPiPackageDirectory(piEntryPath);
  if (!packageDirectory) {
    return undefined;
  }

  return {
    readmePath: path.join(packageDirectory, 'README.md'),
    docsPath: path.join(packageDirectory, 'docs'),
    examplesPath: path.join(packageDirectory, 'examples'),
  };
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

export default function runtimeHarnessContextExtension(pi: {
  on: (
    event: 'before_agent_start',
    handler: (event: { systemPrompt: string }, ctx: { cwd: string }) => Promise<{ systemPrompt: string } | undefined>,
  ) => void;
}) {
  pi.on('before_agent_start', async (event, ctx) => {
    const sections: string[] = [];

    const agentDir = ctx.cwd;
    const runtimeContextMarker = 'Runtime/harness context (jagc + pi):';
    if (!event.systemPrompt.includes(runtimeContextMarker)) {
      const runtimeContextLines = [
        runtimeContextMarker,
        '- Your harness is [jagc](https://github.com/default-anton/jagc) running the pi coding agent runtime.',
        '- jagc wraps pi coding agent; extensions (custom tools, commands, event handlers), skills, prompt templates, and packages are pi-native capabilities.',
        '- Pi mental model: "Pi is a minimal AI agent harness. Adapt pi to your workflows, not the other way around. Extend it with TypeScript extensions, skills, prompt templates, and themes. Bundle them as pi packages and share via npm or git."',
        '- When the user asks about jagc itself (service install/restart/status/uninstall, Telegram access allowlists, debugging health issues, syncing defaults, managing packages, auth/model/thinking, or thread/run control), use the `jagc` CLI as your first control surface and prefer `--json` output when available. Start command discovery with `jagc --help` before acting.',
        '- Treat jagc service health and operability as part of task ownership.',
        '- AGENTS.md: obey local, hierarchical instructions in AGENTS.md files when they are present in context.',
        `- Workspace model: \`${agentDir}\` is the jagc home dir/workspace root (\`JAGC_WORKSPACE_DIR\`, default \`~/.jagc\`) and also the pi agent dir.`,
        '- Purpose: keep prompts, config, extensions, auth, sessions, DB, and service env in one portable state root for deterministic CLI/service behavior.',
        '- User-owned config: `SYSTEM.md`, `AGENTS.md`, `settings.json`, `extensions/`, `skills/`, `service.env`.',
        '- Runtime state (usually do not edit directly): `service.env.snapshot`, `auth.json`, `.sessions/`, `jagc.sqlite*`, `logs/`.',
        `Your skills are located in: ${formatPathForPrompt(path.join(agentDir, 'skills'))}/`,
        `Your extensions are located in: ${formatPathForPrompt(path.join(agentDir, 'extensions'))}/`,
        '- Themes/TUI/keybindings are usually irrelevant for jagc runtime work unless explicitly requested.',
      ];
      sections.push(runtimeContextLines.join('\n'));
    }

    const piDocsMarker = 'Pi documentation (';
    if (!event.systemPrompt.includes(piDocsMarker)) {
      const piDocsPaths = resolvePiDocumentationPaths();
      if (piDocsPaths) {
        const piDocsLines = [
          'Pi documentation (consult when needed for jagc/pi implementation work):',
          `- Main documentation: ${formatPathForPrompt(piDocsPaths.readmePath)}`,
          `- Additional docs: ${formatPathForPrompt(piDocsPaths.docsPath)}`,
          `- Examples: ${formatPathForPrompt(piDocsPaths.examplesPath)} (extensions, custom tools, SDK)`,
          '- Use these docs when the user asks about pi, or asks to extend jagc capabilities, or you need pi-level details to complete work safely.',
          '- Prioritize: extensions (docs/extensions.md, examples/extensions/), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), SDK (docs/sdk.md), providers/models (docs/custom-provider.md, docs/models.md), packages (docs/packages.md).',
          '- Themes/TUI/keybindings are usually irrelevant for jagc runtime work; read only when explicitly requested.',
        ];
        sections.push(piDocsLines.join('\n'));
      }
    }

    if (sections.length === 0) {
      return;
    }

    return {
      systemPrompt: `${event.systemPrompt.trim()}\n\n---\n\n${sections.join('\n\n')}`,
    };
  });
}
