import * as vscode from 'vscode';
import type { Session } from '../session';
import type { ActiveRunStore } from '../state/activeRun';

export class KiwiStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('kiwi.status', vscode.StatusBarAlignment.Left, 50);

  constructor(
    private readonly session: Session,
    private readonly activeRun: ActiveRunStore,
  ) {
    this.item.name = 'Kiwi TCMS';
    this.update();
    this.item.show();
  }

  update(): void {
    const run = this.activeRun.run;
    if (!this.session.connected) {
      this.item.text = '$(beaker) Kiwi: Sign in';
      this.item.tooltip = 'Sign in to Kiwi TCMS';
      this.item.command = 'kiwi.signIn';
    } else if (run) {
      const p = this.activeRun.progress();
      this.item.text = `$(beaker) Run #${run.id} ${p.done}/${p.total}`;
      this.item.tooltip = new vscode.MarkdownString(
        `**Active test run #${run.id}**\n\n${run.summary}\n\n` +
          `- Plan: ${run.plan__name ?? run.plan}\n- Build: ${run.build__name ?? run.build}\n` +
          `- $(pass) ${p.passed} passed · $(error) ${p.failed} failed · ${p.total - p.done} remaining\n\n` +
          'Click to switch the active run.',
        true,
      );
      this.item.command = 'kiwi.selectActiveRun';
    } else {
      this.item.text = '$(beaker) Kiwi: no active run';
      this.item.tooltip = 'Select the test run that results are reported to';
      this.item.command = 'kiwi.selectActiveRun';
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
