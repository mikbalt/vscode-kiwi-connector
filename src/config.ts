import * as vscode from 'vscode';

export const DEFAULT_PATTERNS = [
  String.raw`\bkiwi\(([\d,\s]+)\)`,
  String.raw`\bkiwi\s*[:=]\s*#?((?:\d+\s*,\s*)*\d+)`,
  String.raw`\b(?:TC|KIWI)-(\d+)\b`,
];

const HASH = '# kiwi: ${id}';
const SLASH = '// kiwi: ${id}';
const DASH = '-- kiwi: ${id}';

export const DEFAULT_INSERT_TEMPLATES: Record<string, string> = {
  python: HASH,
  ruby: HASH,
  shellscript: HASH,
  powershell: HASH,
  perl: HASH,
  r: HASH,
  yaml: HASH,
  coffeescript: HASH,
  javascript: SLASH,
  javascriptreact: SLASH,
  typescript: SLASH,
  typescriptreact: SLASH,
  java: SLASH,
  kotlin: SLASH,
  groovy: SLASH,
  scala: SLASH,
  csharp: SLASH,
  go: SLASH,
  php: SLASH,
  rust: SLASH,
  swift: SLASH,
  dart: SLASH,
  c: SLASH,
  cpp: SLASH,
  sql: DASH,
  lua: DASH,
  robotframework: 'TC-${id}',
  feature: '@TC-${id}',
  gherkin: '@TC-${id}',
  cucumber: '@TC-${id}',
};

/** Fallback when the language id is unknown (e.g. no language extension installed). */
export const EXTENSION_TEMPLATES: Record<string, string> = {
  '.py': HASH,
  '.rb': HASH,
  '.robot': 'TC-${id}',
  '.resource': 'TC-${id}',
  '.feature': '@TC-${id}',
};

export type ReportMode = 'exitCode' | 'ask' | 'none';

export interface KiwiSettings {
  url: string;
  username: string;
  allowSelfSigned: boolean;
  product: string;
  runsShow: 'active' | 'all';
  runsLimit: number;
  mappingPatterns: string[];
  mappingInclude: string;
  mappingExclude: string;
  mappingMaxFiles: number;
  insertTemplates: Record<string, string>;
  validateMapping: boolean;
  runCommand: string;
  batchCommand: string;
  runCwd: string;
  runEnv: Record<string, string>;
  reportResult: ReportMode;
  markRunning: boolean;
  addComment: boolean;
  codeLens: boolean;
  newCaseStatus: string;
  newCasePriority: string;
  newCaseCategory: string;
}

export function getSettings(): KiwiSettings {
  const c = vscode.workspace.getConfiguration('kiwi');
  return {
    url: (c.get<string>('url') ?? '').trim(),
    username: (c.get<string>('username') ?? '').trim(),
    allowSelfSigned: c.get<boolean>('allowSelfSignedCertificate', false),
    product: (c.get<string>('product') ?? '').trim(),
    runsShow: c.get<'active' | 'all'>('runs.show', 'active'),
    runsLimit: c.get<number>('runs.limit', 50),
    mappingPatterns: c.get<string[]>('mapping.patterns', DEFAULT_PATTERNS),
    mappingInclude: c.get<string>('mapping.include', '**/*.{py,robot,java,js,ts}'),
    mappingExclude: c.get<string>('mapping.exclude', ''),
    mappingMaxFiles: c.get<number>('mapping.maxFiles', 20000),
    insertTemplates: { ...DEFAULT_INSERT_TEMPLATES, ...c.get<Record<string, string>>('mapping.insertTemplates', {}) },
    validateMapping: c.get<boolean>('mapping.validate', true),
    runCommand: (c.get<string>('run.command') ?? '').trim(),
    batchCommand: (c.get<string>('run.batchCommand') ?? '').trim(),
    runCwd: c.get<string>('run.cwd', '${workspaceFolder}'),
    runEnv: c.get<Record<string, string>>('run.env', {}),
    reportResult: c.get<ReportMode>('run.reportResult', 'exitCode'),
    markRunning: c.get<boolean>('run.markRunning', true),
    addComment: c.get<boolean>('run.addComment', true),
    codeLens: c.get<boolean>('codeLens.enabled', true),
    newCaseStatus: (c.get<string>('newCase.status') ?? '').trim(),
    newCasePriority: (c.get<string>('newCase.priority') ?? '').trim(),
    newCaseCategory: (c.get<string>('newCase.category') ?? '').trim(),
  };
}

/** Updates a setting where it is currently defined (workspace if overridden there, otherwise user settings). */
export async function updateSetting(key: string, value: unknown): Promise<void> {
  const c = vscode.workspace.getConfiguration('kiwi');
  const inspected = c.inspect(key);
  const target =
    inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
  await c.update(key, value, target);
}
