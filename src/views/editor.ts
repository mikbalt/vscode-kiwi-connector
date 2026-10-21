import * as vscode from 'vscode';
import { getSettings } from '../config';
import type { MarkerIndex } from '../mapping/index';
import type { Session } from '../session';
import type { ActiveRunStore } from '../state/activeRun';
import type { CaseCache } from '../state/caseCache';
import { caseLabel, truncate } from '../util';
import { statusCodicon } from './icons';

const commandUri = (command: string, arg: unknown) =>
  `command:${command}?${encodeURIComponent(JSON.stringify([arg]))}`;

/** CodeLens above every marker: summary · status in the active run · Run · Pass · Fail. */
export class KiwiCodeLensProvider implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(
    private readonly session: Session,
    private readonly index: MarkerIndex,
    private readonly activeRun: ActiveRunStore,
    private readonly cache: CaseCache,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!getSettings().codeLens) {
      return [];
    }
    const markers = this.index.markersInFile(document.uri);
    if (!markers.length) {
      return [];
    }
    try {
      await this.cache.ensure(markers.map((m) => m.caseId));
    } catch {
      // Show what we have; details appear once Kiwi is reachable.
    }
    const lenses: vscode.CodeLens[] = [];
    for (const m of markers) {
      const id = m.caseId;
      const range = new vscode.Range(m.range.start, m.range.start);
      const testCase = this.cache.get(id);
      const execution = this.activeRun.executionForCase(id);
      const title = testCase
        ? `$(beaker) ${caseLabel(id)}: ${truncate(testCase.summary, 70)}`
        : this.cache.isMissing(id)
          ? `$(warning) ${caseLabel(id)}: not found in Kiwi TCMS`
          : `$(beaker) ${caseLabel(id)}`;
      lenses.push(new vscode.CodeLens(range, { title, command: 'kiwi.openCaseDetails', arguments: [id] }));
      if (execution) {
        const status = this.session.statusById(execution.status);
        const name = status?.name ?? execution.status__name ?? '?';
        lenses.push(
          new vscode.CodeLens(range, {
            title: `${statusCodicon(name, status?.weight)} ${name}`,
            tooltip: `Status in active run #${execution.run} — click to change`,
            command: 'kiwi.setExecutionStatus',
            arguments: [{ caseId: id }],
          }),
        );
      }
      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(play) Run',
          tooltip: execution ? `Run and report to test run #${execution.run}` : 'Run (not part of the active run, result is not reported)',
          command: 'kiwi.runCase',
          arguments: [{ caseId: id, uri: m.uri.toString(), line: m.range.start.line }],
        }),
      );
      if (execution) {
        lenses.push(
          new vscode.CodeLens(range, { title: '$(check) Pass', command: 'kiwi.markPassed', arguments: [{ caseId: id }] }),
          new vscode.CodeLens(range, { title: '$(close) Fail', command: 'kiwi.markFailed', arguments: [{ caseId: id }] }),
        );
      } else if (this.activeRun.run && testCase) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: '$(add) Add to run',
            tooltip: `Add to active test run #${this.activeRun.run.id}`,
            command: 'kiwi.addCaseToActiveRun',
            arguments: [{ caseId: id }],
          }),
        );
      }
    }
    return lenses;
  }
}

export class KiwiHoverProvider implements vscode.HoverProvider {
  constructor(
    private readonly session: Session,
    private readonly index: MarkerIndex,
    private readonly activeRun: ActiveRunStore,
    private readonly cache: CaseCache,
  ) {}

  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const marker = this.index.markerAt(document.uri, position);
    if (!marker) {
      return undefined;
    }
    const id = marker.caseId;
    try {
      await this.cache.ensure([id]);
    } catch {
      // ignore, rendered below
    }
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = {
      enabledCommands: ['kiwi.runCase', 'kiwi.openCaseDetails', 'kiwi.markPassed', 'kiwi.markFailed', 'kiwi.setExecutionStatus'],
    };
    const c = this.cache.get(id);
    const url = this.session.webUrl(`/case/${id}/`);
    if (!this.session.connected) {
      md.appendMarkdown(`**${caseLabel(id)}** — sign in to Kiwi TCMS to see details.`);
    } else if (!c) {
      md.appendMarkdown(`$(warning) **${caseLabel(id)}** was not found in Kiwi TCMS.`);
    } else {
      md.appendMarkdown(`**${caseLabel(id)}**: ${escape(c.summary)}\n\n`);
      md.appendMarkdown(
        `${c.case_status__name ?? ''} · ${c.priority__value ?? ''} · ${c.category__name ?? ''} · ${c.is_automated ? 'automated' : 'manual'}\n\n`,
      );
      const execution = this.activeRun.executionForCase(id);
      if (execution) {
        const status = this.session.statusById(execution.status);
        md.appendMarkdown(`Active run #${execution.run}: ${statusCodicon(status?.name, status?.weight)} **${status?.name ?? execution.status__name}**\n\n`);
      }
    }
    const links = [
      `[$(play) Run](${commandUri('kiwi.runCase', { caseId: id, uri: marker.uri.toString(), line: marker.range.start.line })})`,
    ];
    if (this.activeRun.executionForCase(id)) {
      links.push(`[$(check) Pass](${commandUri('kiwi.markPassed', { caseId: id })})`);
      links.push(`[$(close) Fail](${commandUri('kiwi.markFailed', { caseId: id })})`);
    }
    links.push(`[$(preview) Details](${commandUri('kiwi.openCaseDetails', id)})`);
    if (url) {
      links.push(`[$(link-external) Kiwi](${url})`);
    }
    md.appendMarkdown(links.join(' · '));
    return new vscode.Hover(md, marker.range);
  }
}

/** Ctrl/Cmd+click on a marker opens the test case in the Kiwi web UI. */
export class KiwiLinkProvider implements vscode.DocumentLinkProvider {
  constructor(
    private readonly session: Session,
    private readonly index: MarkerIndex,
  ) {}

  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    for (const m of this.index.markersInFile(document.uri)) {
      const url = this.session.webUrl(`/case/${m.caseId}/`);
      if (url) {
        const link = new vscode.DocumentLink(m.range, vscode.Uri.parse(url));
        link.tooltip = `Open ${caseLabel(m.caseId)} in Kiwi TCMS`;
        links.push(link);
      }
    }
    return links;
  }
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
