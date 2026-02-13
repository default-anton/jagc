const fallbackCodeExtension = 'txt';

const languageExtensionMap = new Map<string, string>([
  ['bash', 'sh'],
  ['c', 'c'],
  ['cc', 'cpp'],
  ['cpp', 'cpp'],
  ['csharp', 'cs'],
  ['css', 'css'],
  ['go', 'go'],
  ['golang', 'go'],
  ['html', 'html'],
  ['java', 'java'],
  ['javascript', 'js'],
  ['js', 'js'],
  ['json', 'json'],
  ['jsx', 'jsx'],
  ['kotlin', 'kt'],
  ['markdown', 'md'],
  ['md', 'md'],
  ['php', 'php'],
  ['py', 'py'],
  ['python', 'py'],
  ['rb', 'rb'],
  ['ruby', 'rb'],
  ['rs', 'rs'],
  ['rust', 'rs'],
  ['sh', 'sh'],
  ['shell', 'sh'],
  ['sql', 'sql'],
  ['swift', 'swift'],
  ['toml', 'toml'],
  ['ts', 'ts'],
  ['tsx', 'tsx'],
  ['typescript', 'ts'],
  ['xml', 'xml'],
  ['yaml', 'yml'],
  ['yml', 'yml'],
  ['zsh', 'sh'],
]);

export function normalizeCodeLanguage(language: string | null | undefined): string | null {
  if (!language) {
    return null;
  }

  const base = language
    .trim()
    .toLowerCase()
    .split(/[\s,:]+/u)[0];
  if (!base) {
    return null;
  }

  const sanitized = base.replace(/[^a-z0-9#+-]/gu, '');
  return sanitized.length > 0 ? sanitized : null;
}

export function codeLanguageToExtension(language: string | null): string {
  const normalized = normalizeCodeLanguage(language);
  if (!normalized) {
    return fallbackCodeExtension;
  }

  return languageExtensionMap.get(normalized) ?? fallbackCodeExtension;
}
