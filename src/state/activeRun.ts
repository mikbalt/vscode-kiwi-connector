import * as vscode from 'vscode';
import type { TestExecution, TestRun } from '../kiwi/types';
import type { Session } from '../session';
import { errorMessage } from '../util';

const KEY = 'kiwi.activeRunId';

export interface RunProgress {
  total: number;
  done: number;
  passed: number;
  failed: number;
}

/**
 * The test run results are reported to. Stored per workspace so each project keeps its own run.
 */
export class ActiveRunStore implements vscode.Disposable {
  private current: TestRun | undefined;
  private executionList: TestExecution[] = [];
  private byCase = new Map<number, TestExecution>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly session: Session,
    private readonly memento: vscode.Memento,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  get runId(): number | undefined {
    return this.memento.get<number>(KEY);
  }

  get run(): TestRun | undefined {
    return this.current;
  }

  get executions(): readonly TestExecution[] {
    return this.executionList;
  }

  executionForCase(caseId: number): TestExecution | undefined {
    return this.byCase.get(caseId);
  }

  async setRun(runId: number | undefined): Promise<void> {
    await this.memento.update(KEY, runId);
    await this.reload();
  }

  async reload(): Promise<void> {
    const id = this.runId;
    if (id === undefined || !this.session.connected) {
      this.reset();
      this.emitter.fire();
      return;
    }
    try {
      const [runs, executions] = await Promise.all([
        this.session.api.filterRuns({ id }),
        this.session.api.filterExecutions({ run: id }),
        this.session.executionStatuses(),
      ]);
      if (!runs.length) {
        this.log.warn(`Active test run #${id} no longer exists; clearing it.`);
        await this.memento.update(KEY, undefined);
        this.reset();
      } else {
        this.current = runs[0];
        this.executionList = executions.sort((a, b) => (a.sortkey ?? 0) - (b.sortkey ?? 0) || a.id - b.id);
        this.byCase = new Map();
        for (const e of this.executionList) {
          if (!this.byCase.has(e.case)) {
            this.byCase.set(e.case, e);
          }
        }
      }
    } catch (err) {
      this.log.error(`Could not load test run #${id}: ${errorMessage(err)}`);
    }
    this.emitter.fire();
  }

  progress(): RunProgress {
    const p: RunProgress = { total: this.executionList.length, done: 0, passed: 0, failed: 0 };
    for (const e of this.executionList) {
      const weight = this.session.statusById(e.status)?.weight ?? 0;
      if (weight > 0) {
        p.passed++;
      } else if (weight < 0) {
        p.failed++;
      }
      if (weight !== 0) {
        p.done++;
      }
    }
    return p;
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private reset(): void {
    this.current = undefined;
    this.executionList = [];
    this.byCase = new Map();
  }
}
