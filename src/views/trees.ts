import * as vscode from 'vscode';
import { getSettings } from '../config';
import type { ExecutionStatus, Query, TestCase, TestExecution, TestPlan, TestRun } from '../kiwi/types';
import type { MarkerIndex } from '../mapping/index';
import type { Session } from '../session';
import type { ActiveRunStore } from '../state/activeRun';
import type { CaseCache } from '../state/caseCache';
import { caseLabel, errorMessage } from '../util';
import { statusThemeIcon } from './icons';

export class RunNode extends vscode.TreeItem {
  constructor(
    readonly run: TestRun,
    active: boolean,
  ) {
    super(`#${run.id} ${run.summary}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `run:${run.id}`;
    this.description = [run.plan__name, run.build__name].filter(Boolean).join(' · ');
    this.contextValue = active ? 'run.active' : 'run';
    this.iconPath = active
      ? new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'))
      : new vscode.ThemeIcon(run.stop_date ? 'archive' : 'checklist');
    const tooltip = new vscode.MarkdownString(
      `**Test run #${run.id}**${active ? ' (active)' : ''}\n\n${run.summary}\n\n` +
        `- Plan: ${run.plan__name ?? run.plan}\n- Build: ${run.build__name ?? run.build}\n` +
        `- Manager: ${run.manager__username ?? '–'}\n- Started: ${run.start_date ?? '–'}` +
        (run.stop_date ? `\n- Finished: ${run.stop_date}` : ''),
    );
    this.tooltip = tooltip;
  }
}

export class ExecutionNode extends vscode.TreeItem {
  constructor(
    readonly execution: TestExecution,
    testCase: TestCase | undefined,
    mapped: boolean,
    status: ExecutionStatus | undefined,
  ) {
    super(`${caseLabel(execution.case)}: ${testCase?.summary ?? execution.case__summary ?? ''}`);
    this.id = `exec:${execution.id}`;
    const statusName = status?.name ?? execution.status__name ?? '?';
    const kind = testCase ? (testCase.is_automated ? 'automated' : 'manual') : undefined;
    this.description = [statusName, kind, mapped ? 'mapped' : undefined].filter(Boolean).join(' · ');
    this.iconPath = statusThemeIcon(statusName, status?.weight);
    this.contextValue = `execution${mapped ? '.mapped' : ''}`;
    this.tooltip = new vscode.MarkdownString(
      `**${caseLabel(execution.case)}** — ${statusName}\n\n${testCase?.summary ?? execution.case__summary ?? ''}\n\n` +
        `- Assignee: ${execution.assignee__username ?? '–'}\n- Tested by: ${execution.tested_by__username ?? '–'}\n` +
        `- Mapped to code: ${mapped ? 'yes' : 'no'}`,
    );
    this.command = { command: 'kiwi.open', title: 'Open', arguments: [execution.case] };
  }
}

export class PlanNode extends vscode.TreeItem {
  constructor(readonly plan: TestPlan) {
    super(`#${plan.id} ${plan.name}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `plan:${plan.id}`;
    this.description = [plan.product__name, plan.product_version__value].filter(Boolean).join(' · ');
    this.contextValue = 'plan';
    this.iconPath = new vscode.ThemeIcon('notebook');
  }
}

export class CaseNode extends vscode.TreeItem {
  constructor(
    readonly testCase: TestCase,
    mapped: boolean,
    planId: number,
  ) {
    super(`${caseLabel(testCase.id)}: ${testCase.summary}`);
    this.id = `case:${planId}:${testCase.id}`;
    this.description = [
      testCase.case_status__name,
      testCase.is_automated ? 'automated' : 'manual',
      mapped ? 'mapped' : testCase.is_automated ? 'not mapped' : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
    this.iconPath = mapped
      ? new vscode.ThemeIcon('link', new vscode.ThemeColor('charts.green'))
      : testCase.is_automated
        ? new vscode.ThemeIcon('debug-disconnect', new vscode.ThemeColor('charts.yellow'))
        : new vscode.ThemeIcon('person');
    this.contextValue = `case${mapped ? '.mapped' : ''}`;
    this.tooltip = new vscode.MarkdownString(
      `**${caseLabel(testCase.id)}** ${testCase.summary}\n\n- Status: ${testCase.case_status__name ?? '–'}\n` +
        `- Priority: ${testCase.priority__value ?? '–'}\n- Category: ${testCase.category__name ?? '–'}\n` +
        `- Automated: ${testCase.is_automated ? 'yes' : 'no'}\n- Mapped to code: ${mapped ? 'yes' : 'no'}`,
    );
    this.command = { command: 'kiwi.open', title: 'Open', arguments: [testCase.id] };
  }
}

function actionNode(text: string, icon: string, command: string): vscode.TreeItem {
  const item = new vscode.TreeItem(text);
  item.iconPath = new vscode.ThemeIcon(icon);
  item.command = { command, title: text };
  return item;
}

function messageNode(text: string, icon = 'info'): vscode.TreeItem {
  const item = new vscode.TreeItem(text);
  item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}

export class RunsTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private runs: TestRun[] | undefined;
  private readonly executions = new Map<number, TestExecution[]>();
  private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly session: Session,
    private readonly index: MarkerIndex,
    private readonly activeRun: ActiveRunStore,
    private readonly cache: CaseCache,
  ) {}

  /** `hard` drops cached data so it is fetched again from Kiwi. */
  refresh(hard = false): void {
    if (hard) {
      this.runs = undefined;
      this.executions.clear();
    }
    this.emitter.fire(undefined);
  }

  refreshRun(runId: number): void {
    this.executions.delete(runId);
    this.emitter.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!this.session.connected) {
      return [];
    }
    try {
      if (!element) {
        return await this.rootItems();
      }
      if (element instanceof RunNode) {
        return await this.executionItems(element.run.id);
      }
    } catch (err) {
      return [messageNode(`Error: ${errorMessage(err)}`, 'error')];
    }
    return [];
  }

  private async rootItems(): Promise<vscode.TreeItem[]> {
    const s = getSettings();
    if (!this.runs) {
      const query: Query = s.runsShow === 'all' ? {} : { stop_date__isnull: true };
      if (s.product) {
        query.plan__product__name = s.product;
      }
      const runs = await this.session.api.filterRuns(query);
      this.runs = runs.sort((a, b) => b.id - a.id).slice(0, s.runsLimit);
    }
    const runs = [...this.runs];
    const active = this.activeRun.run;
    if (active && !runs.some((r) => r.id === active.id)) {
      runs.unshift(active);
    }
    if (!runs.length) {
      return [
        messageNode(s.runsShow === 'all' ? 'No test runs found.' : 'No unfinished test runs.'),
        actionNode('Create a test run…', 'add', 'kiwi.createRun'),
      ];
    }
    return runs.map((r) => new RunNode(r, r.id === active?.id));
  }

  private async executionItems(runId: number): Promise<vscode.TreeItem[]> {
    let executions: readonly TestExecution[] | undefined =
      runId === this.activeRun.runId && this.activeRun.run ? this.activeRun.executions : this.executions.get(runId);
    if (!executions) {
      const fetched = await this.session.api.filterExecutions({ run: runId });
      fetched.sort((a, b) => (a.sortkey ?? 0) - (b.sortkey ?? 0) || a.id - b.id);
      this.executions.set(runId, fetched);
      executions = fetched;
    }
    if (!executions.length) {
      return [messageNode('This run has no test cases.')];
    }
    await Promise.all([this.cache.ensure(executions.map((e) => e.case)), this.session.executionStatuses()]);
    return executions.map(
      (e) => new ExecutionNode(e, this.cache.get(e.case), this.index.isMapped(e.case), this.session.statusById(e.status)),
    );
  }
}

export class PlansTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private plans: TestPlan[] | undefined;
  private readonly cases = new Map<number, TestCase[]>();
  private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly session: Session,
    private readonly index: MarkerIndex,
    private readonly cache: CaseCache,
  ) {}

  refresh(hard = false): void {
    if (hard) {
      this.plans = undefined;
      this.cases.clear();
    }
    this.emitter.fire(undefined);
  }

  refreshPlan(planId: number): void {
    this.cases.delete(planId);
    this.emitter.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!this.session.connected) {
      return [];
    }
    try {
      if (!element) {
        if (!this.plans) {
          this.plans = await loadPlans(this.session);
        }
        return this.plans.length ? this.plans.map((p) => new PlanNode(p)) : [messageNode('No active test plans found.')];
      }
      if (element instanceof PlanNode) {
        const planId = element.plan.id;
        let cases = this.cases.get(planId);
        if (!cases) {
          cases = await this.session.api.filterCases({ plan: planId });
          cases.sort((a, b) => a.id - b.id);
          this.cases.set(planId, cases);
          this.cache.put(cases);
        }
        return cases.length
          ? cases.map((c) => new CaseNode(c, this.index.isMapped(c.id), planId))
          : [messageNode('This plan has no test cases.')];
      }
    } catch (err) {
      return [messageNode(`Error: ${errorMessage(err)}`, 'error')];
    }
    return [];
  }
}

export async function loadPlans(session: Session): Promise<TestPlan[]> {
  const { product } = getSettings();
  const query: Query = { is_active: true };
  if (product) {
    query.product__name = product;
  }
  const plans = await session.api.filterPlans(query);
  return plans.sort((a, b) => a.name.localeCompare(b.name));
}
