import * as vscode from 'vscode';
import type { MarkerIndex } from '../mapping/index';
import type { Session } from '../session';
import type { ActiveRunStore } from '../state/activeRun';
import type { CaseCache } from '../state/caseCache';
import { caseLabel, errorMessage } from '../util';

export const SCHEME = 'kiwi';

/**
 * Read-only virtual Markdown documents shown in the Markdown preview:
 * `kiwi:/TC-12.md` (test case details) and `kiwi:/reports/<name>.md` (generated reports).
 */
export class KiwiDocuments implements vscode.TextDocumentContentProvider {
  private readonly reports = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly session: Session,
    private readonly index: MarkerIndex,
    private readonly activeRun: ActiveRunStore,
    private readonly cache: CaseCache,
  ) {}

  async showCase(caseId: number): Promise<void> {
    await this.open(vscode.Uri.from({ scheme: SCHEME, path: `/${caseLabel(caseId)}.md` }));
  }

  async showReport(name: string, markdown: string): Promise<void> {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/reports/${name}.md` });
    this.reports.set(uri.path, markdown);
    await this.open(uri);
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const report = this.reports.get(uri.path);
    if (report !== undefined) {
      return report;
    }
    const match = /^\/TC-(\d+)\.md$/.exec(uri.path);
    if (!match) {
      return '# Unknown Kiwi document';
    }
    return this.caseMarkdown(Number(match[1]));
  }

  private async open(uri: vscode.Uri): Promise<void> {
    this.emitter.fire(uri);
    try {
      await vscode.commands.executeCommand('markdown.showPreview', uri);
    } catch {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    }
  }

  private async caseMarkdown(id: number): Promise<string> {
    try {
      await this.cache.ensure([id]);
    } catch (err) {
      return `# ${caseLabel(id)}\n\nCould not load the test case: ${errorMessage(err)}`;
    }
    const c = this.cache.get(id);
    const url = this.session.webUrl(`/case/${id}/`);
    if (!c) {
      return `# ${caseLabel(id)}\n\n${this.session.connected ? 'This test case does not exist in Kiwi TCMS.' : 'Sign in to Kiwi TCMS to see details.'}`;
    }
    const execution = this.activeRun.executionForCase(id);
    const status = execution ? this.session.statusById(execution.status) : undefined;
    const rows: [string, string | undefined | null][] = [
      ['Status', c.case_status__name],
      ['Priority', c.priority__value],
      ['Category', c.category__name],
      ['Automated', c.is_automated ? 'yes' : 'no'],
      ['Author', c.author__username],
      ['Default tester', c.default_tester__username],
      ['Script', c.script ? `\`${c.script}\`` : undefined],
      ['Arguments', c.arguments ? `\`${c.arguments}\`` : undefined],
      ['Requirement', c.requirement],
      ['Active run', execution ? `#${execution.run}: **${status?.name ?? execution.status__name}**` : undefined],
      ['Kiwi TCMS', url ? `[Open in browser](${url})` : undefined],
    ];
    const table = rows
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `| ${k} | ${String(v).replace(/\|/g, '\\|')} |`)
      .join('\n');

    const markers = this.index.markersForCase(id);
    const mapped = markers.length
      ? markers
          .map((m) => {
            const line = m.range.start.line + 1;
            const target = m.uri.with({ fragment: `L${line}` }).toString();
            return `- [${vscode.workspace.asRelativePath(m.uri)}:${line}](${target})`;
          })
          .join('\n')
      : '_Not mapped yet._ Put the cursor on a test and run **Kiwi: Link Test to Existing Test Case**.';

    return [
      `# ${caseLabel(id)}: ${c.summary}`,
      '',
      '| | |',
      '|---|---|',
      table,
      '',
      '## Mapped code',
      '',
      mapped,
      '',
      '## Text / steps',
      '',
      c.text?.trim() || '_No text._',
      ...(c.notes?.trim() ? ['', '## Notes', '', c.notes.trim()] : []),
      '',
    ].join('\n');
  }
}
