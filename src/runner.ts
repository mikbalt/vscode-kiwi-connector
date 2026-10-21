import { randomUUID } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { getSettings, type ReportMode } from './config';
import type { ExecutionStatus, TestExecution } from './kiwi/types';
import type { Marker, MarkerIndex } from './mapping/index';
import { documentLines } from './mapping/insert';
import { detectTest, type TestInfo } from './mapping/testName';
import type { Session } from './session';
import type { ActiveRunStore } from './state/activeRun';
import type { CaseCache } from './state/caseCache';
import { MissingVariableError, substitute, type Variables } from './template';
import { caseLabel, errorMessage, mapLimit, unique } from './util';

export interface RunTarget {
  caseId: number;
  /** Preferred code location when the case is mapped in several places. */
  uri?: vscode.Uri;
  line?: number;
}

interface Resolved {
  caseId: number;
  marker?: Marker;
  info: TestInfo;
  execution?: TestExecution;
}

type Outcome = 'passed' | 'failed' | 'stopped' | 'skipped';

/** Executes test cases with the user's framework (as VS Code tasks) and reports results to the active run. */
export class TestRunner {
  constructor(
    private readonly session: Session,
    private readonly index: MarkerIndex,
    private readonly activeRun: ActiveRunStore,
    private readonly cache: CaseCache,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  async run(targets: RunTarget[]): Promise<void> {
    const s = getSettings();
    if (!targets.length) {
      void vscode.window.showInformationMessage('Kiwi TCMS: nothing to run.');
      return;
    }
    const useBatch = targets.length > 1 && !!s.batchCommand;
    if (!s.runCommand && !useBatch) {
      const pick = await vscode.window.showWarningMessage(
        'Kiwi TCMS: configure "kiwi.run.command" so the extension knows how to execute a test case with your framework.',
        'Open Settings',
      );
      if (pick) {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'kiwi.run');
      }
      return;
    }
    try {
      await this.cache.ensure(targets.map((t) => t.caseId));
    } catch (err) {
      this.log.warn(`Could not load test cases: ${errorMessage(err)}`);
    }

    if (targets.length === 1) {
      await this.runSingle(targets[0], true);
    } else if (useBatch) {
      await this.runBatch(targets);
    } else {
      await this.runSequential(targets);
    }
    await this.activeRun.reload();
  }

  // ---- strategies -----------------------------------------------------------

  private async runSingle(target: RunTarget, interactive: boolean): Promise<Outcome> {
    const s = getSettings();
    const resolved = await this.resolve(target, interactive);
    if (!resolved) {
      return 'skipped';
    }
    const vars = this.variables([resolved], false);
    const command = this.render(s.runCommand, vars, [resolved], interactive);
    if (command === undefined) {
      return 'skipped';
    }
    const executions = resolved.execution ? [resolved.execution] : [];
    const previous = s.markRunning ? await this.markRunning(executions) : new Map<number, number>();

    this.log.info(`Running ${caseLabel(target.caseId)}: ${command}`);
    const exitCode = await this.executeTask(caseLabel(target.caseId), command, vars);
    const mode: ReportMode = !interactive && s.reportResult === 'ask' ? 'exitCode' : s.reportResult;
    await this.report(executions, [target.caseId], exitCode, mode, false, previous);
    return exitCode === undefined ? 'stopped' : exitCode === 0 ? 'passed' : 'failed';
  }

  private async runSequential(targets: RunTarget[]): Promise<void> {
    const outcomes: Record<Outcome, number> = { passed: 0, failed: 0, stopped: 0, skipped: 0 };
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Kiwi TCMS', cancellable: true },
      async (progress, token) => {
        for (const [i, target] of targets.entries()) {
          if (token.isCancellationRequested) {
            outcomes.skipped += targets.length - i;
            break;
          }
          progress.report({
            message: `running ${caseLabel(target.caseId)} (${i + 1}/${targets.length})`,
            increment: 100 / targets.length,
          });
          outcomes[await this.runSingle(target, false)]++;
        }
      },
    );
    void vscode.window.showInformationMessage(
      `Kiwi TCMS: ${outcomes.passed} passed, ${outcomes.failed} failed` +
        (outcomes.stopped ? `, ${outcomes.stopped} stopped` : '') +
        (outcomes.skipped ? `, ${outcomes.skipped} skipped (see the "Kiwi TCMS" output)` : '') +
        '.',
    );
  }

  private async runBatch(targets: RunTarget[]): Promise<void> {
    const s = getSettings();
    const resolved: Resolved[] = [];
    for (const target of targets) {
      const r = await this.resolve(target, false);
      if (r) {
        resolved.push(r);
      }
    }
    const vars = this.variables(resolved, true);
    const command = this.render(s.batchCommand, vars, resolved, true);
    if (command === undefined) {
      return;
    }
    const executions = resolved.map((r) => r.execution).filter((e): e is TestExecution => !!e);
    const previous = s.markRunning ? await this.markRunning(executions) : new Map<number, number>();

    this.log.info(`Running ${resolved.length} test case(s): ${command}`);
    const exitCode = await this.executeTask(`${resolved.length} test cases`, command, vars);
    await this.report(executions, resolved.map((r) => r.caseId), exitCode, s.reportResult === 'ask' ? 'exitCode' : s.reportResult, true, previous);
  }

  // ---- resolution -----------------------------------------------------------

  private async resolve(target: RunTarget, interactive: boolean): Promise<Resolved | undefined> {
    const markers = this.index.markersForCase(target.caseId);
    let marker: Marker | undefined;
    if (target.uri) {
      const sameFile = markers.filter((m) => m.uri.toString() === target.uri!.toString());
      marker = sameFile.find((m) => m.range.start.line === target.line) ?? sameFile[0];
    }
    if (!marker && markers.length === 1) {
      marker = markers[0];
    } else if (!marker && markers.length > 1) {
      if (!interactive) {
        marker = markers[0];
      } else {
        const pick = await vscode.window.showQuickPick(
          markers.map((m) => ({
            label: `${vscode.workspace.asRelativePath(m.uri)}:${m.range.start.line + 1}`,
            marker: m,
          })),
          { title: `${caseLabel(target.caseId)} is mapped in several places — which one should run?` },
        );
        if (!pick) {
          return undefined;
        }
        marker = pick.marker;
      }
    }
    let info: TestInfo = {};
    if (marker) {
      const doc = await vscode.workspace.openTextDocument(marker.uri);
      info = detectTest(documentLines(doc), marker.range.start.line, path.extname(marker.uri.fsPath));
    }
    return { caseId: target.caseId, marker, info, execution: this.activeRun.executionForCase(target.caseId) };
  }

  private variables(resolved: Resolved[], batch: boolean): Variables {
    const single = batch ? undefined : resolved[0];
    const run = this.activeRun.run;
    const marker = single?.marker;
    const folder = marker ? vscode.workspace.getWorkspaceFolder(marker.uri) : vscode.workspace.workspaceFolders?.[0];
    const file = marker?.uri.fsPath;
    const relative = (uri: vscode.Uri) => vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
    const nodeId = (r: Resolved) =>
      r.marker && r.info.testName && path.extname(r.marker.uri.fsPath) === '.py'
        ? `${relative(r.marker.uri)}::${r.info.testClass ? r.info.testClass + '::' : ''}${r.info.testName}`
        : undefined;
    const ids = resolved.map((r) => String(r.caseId));
    const mappedFiles = unique(resolved.filter((r) => r.marker).map((r) => r.marker!.uri.fsPath));
    const nodeIds = resolved.map(nodeId).filter((n): n is string => !!n);

    return {
      caseId: single ? String(single.caseId) : undefined,
      caseIds: ids.join(','),
      caseIdsSpace: ids.join(' '),
      runId: run ? String(run.id) : undefined,
      executionId: single?.execution ? String(single.execution.id) : undefined,
      planId: run ? String(run.plan) : undefined,
      buildId: run ? String(run.build) : undefined,
      file,
      relativeFile: marker ? relative(marker.uri) : undefined,
      fileBasename: file ? path.basename(file) : undefined,
      fileBasenameNoExtension: file ? path.parse(file).name : undefined,
      fileDirname: file ? path.dirname(file) : undefined,
      line: marker ? String(marker.range.start.line + 1) : undefined,
      testName: single?.info.testName,
      testClass: single?.info.testClass,
      pytestNodeId: single ? nodeId(single) : undefined,
      pytestNodeIds: nodeIds.length ? nodeIds.map((n) => `"${n}"`).join(' ') : undefined,
      files: mappedFiles.length ? mappedFiles.map((f) => `"${f}"`).join(' ') : undefined,
      summary: single ? this.cache.get(single.caseId)?.summary : undefined,
      workspaceFolder: folder?.uri.fsPath,
      kiwiUrl: this.session.webUrl(''),
    };
  }

  private render(template: string, vars: Variables, resolved: Resolved[], interactive: boolean): string | undefined {
    try {
      return substitute(template, vars);
    } catch (err) {
      if (!(err instanceof MissingVariableError)) {
        throw err;
      }
      const subject = resolved.length === 1 ? caseLabel(resolved[0].caseId) : `${resolved.length} test cases`;
      const message = `Cannot run ${subject}: \${${err.variable}} is not available — ${this.hint(err.variable, resolved)}`;
      this.log.warn(message);
      if (interactive) {
        const action = err.variable === 'runId' || err.variable === 'planId' || err.variable === 'buildId' ? 'Select Active Run' : undefined;
        void vscode.window.showErrorMessage(message, ...(action ? [action] : [])).then((pick) => {
          if (pick) {
            void vscode.commands.executeCommand('kiwi.selectActiveRun');
          }
        });
      }
      return undefined;
    }
  }

  private hint(variable: string, resolved: Resolved[]): string {
    const first = resolved[0];
    switch (variable) {
      case 'runId':
      case 'planId':
      case 'buildId':
        return 'there is no active test run. Select one first.';
      case 'executionId':
        return `${caseLabel(first.caseId)} is not part of the active test run.`;
      case 'testName':
      case 'testClass':
      case 'pytestNodeId':
        return first?.marker
          ? 'the test name could not be detected next to the marker.'
          : `${caseLabel(first.caseId)} is not mapped to code in this workspace.`;
      case 'caseId':
      case 'summary':
        return 'it is only available when running a single test case; use ${caseIds} in kiwi.run.batchCommand.';
      case 'files':
      case 'pytestNodeIds':
        return 'none of the selected test cases is mapped to code.';
      default:
        return resolved.length > 1
          ? 'it is only available for single test cases; use ${files} / ${caseIds} in kiwi.run.batchCommand.'
          : `${caseLabel(first.caseId)} is not mapped to code in this workspace.`;
    }
  }

  // ---- execution & reporting ------------------------------------------------

  private executeTask(name: string, command: string, vars: Variables): Promise<number | undefined> {
    const s = getSettings();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(s.runEnv)) {
      env[key] = substitute(String(value), vars, { lenient: true });
    }
    const put = (key: string, value: string | undefined) => {
      if (value !== undefined && env[key] === undefined) {
        env[key] = value;
      }
    };
    put('KIWI_URL', vars.kiwiUrl);
    put('KIWI_CASE_ID', vars.caseId);
    put('KIWI_CASE_IDS', vars.caseIds);
    put('KIWI_RUN_ID', vars.runId);
    put('KIWI_EXECUTION_ID', vars.executionId);
    put('KIWI_PLAN_ID', vars.planId);
    put('KIWI_BUILD_ID', vars.buildId);
    put('KIWI_TEST_FILE', vars.file);
    put('KIWI_TEST_NAME', vars.testName);
    // Picked up by the official Kiwi TCMS plugins (tcms-api) to report into this run.
    put('TCMS_RUN_ID', vars.runId);
    put('TCMS_PLAN_ID', vars.planId);

    const cwd = substitute(s.runCwd || '', vars, { lenient: true }) || undefined;
    const runToken = randomUUID();
    const folder = vscode.workspace.workspaceFolders?.find((f) => f.uri.fsPath === vars.workspaceFolder);
    const task = new vscode.Task(
      { type: 'kiwi', runToken },
      folder ?? vscode.TaskScope.Workspace,
      name,
      'Kiwi TCMS',
      new vscode.ShellExecution(command, { cwd, env }),
    );
    task.presentationOptions = {
      reveal: vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Shared,
      clear: true,
      showReuseMessage: false,
    };

    return new Promise<number | undefined>((resolve) => {
      let settled = false;
      const finish = (code: number | undefined) => {
        if (!settled) {
          settled = true;
          onProcessEnd.dispose();
          onTaskEnd.dispose();
          resolve(code);
        }
      };
      const isOurs = (e: { execution: vscode.TaskExecution }) => e.execution.task.definition.runToken === runToken;
      const onProcessEnd = vscode.tasks.onDidEndTaskProcess((e) => isOurs(e) && finish(e.exitCode));
      // A task that is terminated may end without a process exit code.
      const onTaskEnd = vscode.tasks.onDidEndTask((e) => isOurs(e) && setTimeout(() => finish(undefined), 1000));
      vscode.tasks.executeTask(task).then(undefined, (err) => {
        this.log.error(`Could not start task: ${errorMessage(err)}`);
        void vscode.window.showErrorMessage(`Kiwi TCMS: could not start the test command — ${errorMessage(err)}`);
        finish(undefined);
      });
    });
  }

  /** Sets executions to RUNNING and returns their previous status ids. */
  private async markRunning(executions: TestExecution[]): Promise<Map<number, number>> {
    const previous = new Map<number, number>();
    if (!executions.length) {
      return previous;
    }
    try {
      const running = await this.session.findStatus('RUNNING');
      if (running) {
        await mapLimit(executions, 6, async (e) => {
          await this.session.setExecutionStatus(e.id, running.id);
          previous.set(e.id, e.status);
        });
      }
    } catch (err) {
      this.log.warn(`Could not set RUNNING status: ${errorMessage(err)}`);
    }
    return previous;
  }

  private async restore(previous: Map<number, number>, onlyIfStatus?: number): Promise<void> {
    if (!previous.size) {
      return;
    }
    try {
      let ids = [...previous.keys()];
      if (onlyIfStatus !== undefined) {
        const current = await this.session.api.filterExecutions({ pk__in: ids });
        ids = current.filter((e) => e.status === onlyIfStatus).map((e) => e.id);
      }
      await mapLimit(ids, 6, (id) => this.session.api.updateExecution(id, { status: previous.get(id) }));
    } catch (err) {
      this.log.warn(`Could not restore execution status: ${errorMessage(err)}`);
    }
  }

  private async report(
    executions: TestExecution[],
    caseIds: number[],
    exitCode: number | undefined,
    mode: ReportMode,
    batch: boolean,
    previous: Map<number, number>,
  ): Promise<void> {
    const subject = caseIds.length === 1 ? caseLabel(caseIds[0]) : `${caseIds.length} test cases`;
    const s = getSettings();
    this.log.info(`${subject} finished with exit code ${exitCode ?? '(none)'}`);

    if (exitCode === undefined) {
      await this.restore(previous);
      void vscode.window.showWarningMessage(`Kiwi TCMS: ${subject} was stopped before finishing; no result was reported.`);
      return;
    }
    if (!executions.length) {
      if (!batch) {
        void vscode.window.setStatusBarMessage(
          `Kiwi: ${subject} exited with ${exitCode} (not in the active run, nothing reported)`,
          6000,
        );
      }
      return;
    }
    if (mode === 'none') {
      return;
    }
    if (batch && exitCode !== 0) {
      const running = await this.session.findStatus('RUNNING').catch(() => undefined);
      await this.restore(previous, running?.id);
      void vscode.window.showWarningMessage(
        `Kiwi TCMS: batch finished with exit code ${exitCode}. Individual results were not reported — let your framework report them, or mark them in the Test Runs view.`,
      );
      return;
    }

    let status: ExecutionStatus | undefined = await this.session.findStatus(exitCode === 0 ? 'PASSED' : 'FAILED');
    if (mode === 'ask') {
      const statuses = await this.session.executionStatuses();
      const suggested = status?.name;
      const others = statuses.filter((st) => st.weight !== 0 && st.name !== suggested).map((st) => st.name);
      const choice = await vscode.window.showInformationMessage(
        `${subject} finished with exit code ${exitCode}. Report to Kiwi TCMS as:`,
        ...(suggested ? [suggested] : []),
        ...others,
      );
      status = statuses.find((st) => st.name === choice);
      if (!status) {
        await this.restore(previous);
        return;
      }
    }
    if (!status) {
      void vscode.window.showErrorMessage('Kiwi TCMS: could not find a PASSED/FAILED execution status.');
      return;
    }
    const chosen = status;
    const comment = s.addComment ? `Executed from VS Code (exit code ${exitCode}).` : undefined;
    try {
      await mapLimit(executions, 6, (e) => this.session.setExecutionStatus(e.id, chosen.id, comment));
      void vscode.window.setStatusBarMessage(`Kiwi: ${subject} → ${chosen.name}`, 6000);
    } catch (err) {
      void vscode.window.showErrorMessage(`Kiwi TCMS: could not report the result — ${errorMessage(err)}`);
    }
  }
}
