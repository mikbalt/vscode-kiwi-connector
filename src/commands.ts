import * as path from 'path';
import * as vscode from 'vscode';
import { getSettings } from './config';
import type { Build, ExecutionStatus, TestCase, TestExecution, TestPlan, TestRun } from './kiwi/types';
import type { Marker, MarkerIndex } from './mapping/index';
import { documentLines, insertMarker } from './mapping/insert';
import { detectTest, humanizeTestName } from './mapping/testName';
import type { RunTarget, TestRunner } from './runner';
import { NotConnectedError, type Session, type StatusKind } from './session';
import type { ActiveRunStore } from './state/activeRun';
import type { CaseCache } from './state/caseCache';
import { caseLabel, chunk, errorMessage, mapLimit, truncate, unique } from './util';
import type { KiwiDocuments } from './views/documents';
import { statusCodicon } from './views/icons';
import { CaseNode, ExecutionNode, loadPlans, PlanNode, RunNode, type PlansTreeProvider, type RunsTreeProvider } from './views/trees';

export interface Deps {
  context: vscode.ExtensionContext;
  session: Session;
  cache: CaseCache;
  index: MarkerIndex;
  activeRun: ActiveRunStore;
  runner: TestRunner;
  runsTree: RunsTreeProvider;
  plansTree: PlansTreeProvider;
  documents: KiwiDocuments;
  log: vscode.LogOutputChannel;
  refreshAll: () => Promise<void>;
}

const LAST_PLAN_KEY = 'kiwi.lastPlanId';

export function registerCommands(d: Deps): void {
  const { session, cache, index, activeRun, runner } = d;

  const register = (id: string, fn: (...args: any[]) => unknown) =>
    d.context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          return await fn(...args);
        } catch (err) {
          if (err instanceof NotConnectedError) {
            const pick = await vscode.window.showWarningMessage('Kiwi TCMS: please sign in first.', 'Sign In');
            if (pick) {
              void vscode.commands.executeCommand('kiwi.signIn');
            }
            return undefined;
          }
          d.log.error(`${id}: ${errorMessage(err)}`);
          void vscode.window.showErrorMessage(`Kiwi TCMS: ${errorMessage(err)}`);
          return undefined;
        }
      }),
    );

  // ---- argument helpers -------------------------------------------------------

  /** Marker the cursor is on, or the closest marker above the cursor in the active editor. */
  const markerNearCursor = async (): Promise<Marker | undefined> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }
    const markers = index.markersInFile(editor.document.uri);
    const pos = editor.selection.active;
    const exact = markers.find((m) => m.range.contains(pos));
    if (exact) {
      return exact;
    }
    const above = markers.filter((m) => m.range.start.line <= pos.line);
    if (!above.length) {
      return undefined;
    }
    const line = above[above.length - 1].range.start.line;
    const onLine = above.filter((m) => m.range.start.line === line);
    if (onLine.length === 1) {
      return onLine[0];
    }
    const pick = await vscode.window.showQuickPick(
      onLine.map((m) => ({ label: caseLabel(m.caseId), description: cache.get(m.caseId)?.summary, marker: m })),
      { title: 'Which test case?' },
    );
    return pick?.marker;
  };

  const caseIdFrom = async (arg: unknown, prompt = true): Promise<number | undefined> => {
    if (typeof arg === 'number') {
      return arg;
    }
    if (arg instanceof CaseNode) {
      return arg.testCase.id;
    }
    if (arg instanceof ExecutionNode) {
      return arg.execution.case;
    }
    if (arg && typeof arg === 'object' && typeof (arg as { caseId?: unknown }).caseId === 'number') {
      return (arg as { caseId: number }).caseId;
    }
    const near = await markerNearCursor();
    if (near) {
      return near.caseId;
    }
    return prompt ? (await pickCase(d, 'Select a test case'))?.id : undefined;
  };

  const executionFrom = async (arg: unknown): Promise<TestExecution | undefined> => {
    if (arg instanceof ExecutionNode) {
      return arg.execution;
    }
    const caseId = await caseIdFrom(arg);
    if (caseId === undefined) {
      return undefined;
    }
    if (!activeRun.run) {
      const pick = await vscode.window.showWarningMessage('Kiwi TCMS: select an active test run first.', 'Select Active Run');
      if (pick) {
        await vscode.commands.executeCommand('kiwi.selectActiveRun');
      }
      return undefined;
    }
    const execution = activeRun.executionForCase(caseId);
    if (!execution) {
      const pick = await vscode.window.showWarningMessage(
        `${caseLabel(caseId)} is not part of the active test run #${activeRun.run.id}.`,
        'Add to Run',
      );
      if (pick) {
        await vscode.commands.executeCommand('kiwi.addCaseToActiveRun', caseId);
      }
    }
    return execution;
  };

  /** Running from a node of another run makes that run the active one, so results go to the right place. */
  const ensureActive = async (runId: number) => {
    if (activeRun.runId !== runId) {
      await activeRun.setRun(runId);
      void vscode.window.setStatusBarMessage(`Kiwi: test run #${runId} is now the active run`, 5000);
    }
  };

  const setStatus = async (arg: unknown, kind?: StatusKind) => {
    session.api; // throws when signed out
    const execution = await executionFrom(arg);
    if (!execution) {
      return;
    }
    const statuses = await session.executionStatuses();
    let status: ExecutionStatus | undefined;
    if (kind) {
      status = await session.findStatus(kind);
    } else {
      const pick = await vscode.window.showQuickPick(
        statuses.map((s) => ({
          label: `${statusCodicon(s.name, s.weight)} ${s.name}`,
          description: s.id === execution.status ? 'current' : undefined,
          status: s,
        })),
        { title: `Set status of ${caseLabel(execution.case)} in run #${execution.run}` },
      );
      status = pick?.status;
    }
    if (!status) {
      return;
    }
    let comment: string | undefined;
    if (status.weight < 0) {
      comment = await vscode.window.showInputBox({
        title: `${caseLabel(execution.case)} → ${status.name}`,
        prompt: 'Optional comment (press Enter to skip, Escape to cancel)',
      });
      if (comment === undefined) {
        return;
      }
    }
    await session.setExecutionStatus(execution.id, status.id, comment?.trim() || undefined);
    void vscode.window.setStatusBarMessage(`Kiwi: ${caseLabel(execution.case)} → ${status.name}`, 4000);
    if (execution.run === activeRun.runId) {
      await activeRun.reload();
    }
    d.runsTree.refreshRun(execution.run);
  };

  // ---- account ------------------------------------------------------------------

  register('kiwi.signIn', () => session.signIn());
  register('kiwi.signOut', async () => {
    await session.signOut();
    void vscode.window.showInformationMessage('Signed out of Kiwi TCMS.');
  });
  register('kiwi.refresh', () => d.refreshAll());

  // ---- active run -----------------------------------------------------------

  register('kiwi.selectActiveRun', async (arg?: unknown) => {
    if (arg instanceof RunNode) {
      await activeRun.setRun(arg.run.id);
      return;
    }
    const s = getSettings();
    const query: Record<string, unknown> = { stop_date__isnull: true };
    if (s.product) {
      query.plan__product__name = s.product;
    }
    const runs = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Kiwi: loading test runs' },
      () => session.api.filterRuns(query),
    );
    runs.sort((a, b) => b.id - a.id);
    type Item = vscode.QuickPickItem & { run?: TestRun; clear?: boolean };
    const items: Item[] = runs.map((r) => ({
      label: `${r.id === activeRun.runId ? '$(star-full) ' : ''}#${r.id} ${r.summary}`,
      description: [r.plan__name, r.build__name].filter(Boolean).join(' · '),
      detail: `Manager ${r.manager__username ?? '–'} · started ${r.start_date ?? '–'}`,
      run: r,
    }));
    if (activeRun.runId !== undefined) {
      items.push({ label: '$(close) Clear active run', clear: true });
    }
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Select the active test run (results are reported here)',
      matchOnDescription: true,
      placeHolder: runs.length ? 'Type to filter by summary, plan or build' : 'No unfinished test runs — create one from a test plan',
    });
    if (!pick) {
      return;
    }
    await activeRun.setRun(pick.clear ? undefined : pick.run!.id);
    if (pick.run) {
      void vscode.window.showInformationMessage(
        `Active test run: #${pick.run.id} ${pick.run.summary} (${activeRun.executions.length} test cases).`,
      );
    }
  });
  register('kiwi.clearActiveRun', () => activeRun.setRun(undefined));

  // ---- statuses -------------------------------------------------------------

  register('kiwi.setExecutionStatus', (arg?: unknown) => setStatus(arg));
  register('kiwi.markPassed', (arg?: unknown) => setStatus(arg, 'PASSED'));
  register('kiwi.markFailed', (arg?: unknown) => setStatus(arg, 'FAILED'));

  // ---- running ----------------------------------------------------------------

  register('kiwi.runCase', async (arg?: unknown) => {
    let target: RunTarget | undefined;
    if (arg instanceof ExecutionNode) {
      await ensureActive(arg.execution.run);
      target = { caseId: arg.execution.case };
    } else if (arg && typeof arg === 'object' && 'caseId' in arg && typeof (arg as RunTarget).caseId === 'number') {
      const a = arg as { caseId: number; uri?: string | vscode.Uri; line?: number };
      target = { caseId: a.caseId, uri: typeof a.uri === 'string' ? vscode.Uri.parse(a.uri) : a.uri, line: a.line };
    } else {
      const near = arg === undefined ? await markerNearCursor() : undefined;
      if (near) {
        target = { caseId: near.caseId, uri: near.uri, line: near.range.start.line };
      } else {
        const caseId = await caseIdFrom(arg);
        target = caseId === undefined ? undefined : { caseId };
      }
    }
    if (target) {
      await runner.run([target]);
    }
  });

  register('kiwi.runTestRun', async (arg?: unknown) => {
    let runId = arg instanceof RunNode ? arg.run.id : activeRun.runId;
    if (runId === undefined) {
      await vscode.commands.executeCommand('kiwi.selectActiveRun');
      runId = activeRun.runId;
      if (runId === undefined) {
        return;
      }
    }
    await ensureActive(runId);
    const executions = activeRun.executions;
    await cache.ensure(executions.map((e) => e.case));
    const candidates = executions.filter((e) => index.isMapped(e.case) || cache.get(e.case)?.is_automated);
    if (!candidates.length) {
      void vscode.window.showWarningMessage(
        `Test run #${runId} has no automated or mapped test cases. Link tests to cases first (Kiwi: Link Test to Existing Test Case).`,
      );
      return;
    }
    const picks = await vscode.window.showQuickPick(
      candidates.map((e) => {
        const status = session.statusById(e.status);
        return {
          label: `${statusCodicon(status?.name, status?.weight)} ${caseLabel(e.case)}: ${truncate(cache.get(e.case)?.summary ?? e.case__summary ?? '', 80)}`,
          description: [status?.name, index.isMapped(e.case) ? 'mapped' : 'not mapped'].join(' · '),
          picked: !((status?.weight ?? 0) > 0),
          execution: e,
        };
      }),
      {
        canPickMany: true,
        title: `Run test cases of #${runId} — not yet passed cases are preselected`,
        matchOnDescription: true,
      },
    );
    if (picks?.length) {
      await runner.run(picks.map((p) => ({ caseId: p.execution.case })));
    }
  });

  register('kiwi.runFile', async (arg?: unknown) => {
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      return;
    }
    const markers = index.markersInFile(uri);
    if (!markers.length) {
      void vscode.window.showInformationMessage('Kiwi TCMS: no test case markers in this file.');
      return;
    }
    const seen = new Set<number>();
    const targets: RunTarget[] = [];
    for (const m of markers) {
      if (!seen.has(m.caseId)) {
        seen.add(m.caseId);
        targets.push({ caseId: m.caseId, uri, line: m.range.start.line });
      }
    }
    await runner.run(targets);
  });

  // ---- navigation -------------------------------------------------------------

  const goToCode = async (caseId: number): Promise<boolean> => {
    const markers = index.markersForCase(caseId);
    if (!markers.length) {
      return false;
    }
    let marker = markers[0];
    if (markers.length > 1) {
      const pick = await vscode.window.showQuickPick(
        markers.map((m) => ({ label: `${vscode.workspace.asRelativePath(m.uri)}:${m.range.start.line + 1}`, marker: m })),
        { title: `${caseLabel(caseId)} is mapped in ${markers.length} places` },
      );
      if (!pick) {
        return true;
      }
      marker = pick.marker;
    }
    const editor = await vscode.window.showTextDocument(marker.uri);
    editor.selection = new vscode.Selection(marker.range.start, marker.range.start);
    editor.revealRange(marker.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return true;
  };

  register('kiwi.goToCode', async (arg?: unknown) => {
    const caseId = await caseIdFrom(arg);
    if (caseId !== undefined && !(await goToCode(caseId))) {
      void vscode.window.showInformationMessage(`${caseLabel(caseId)} is not mapped to code in this workspace yet.`);
    }
  });
  register('kiwi.open', async (caseId: number) => {
    if (!(await goToCode(caseId))) {
      await d.documents.showCase(caseId);
    }
  });
  register('kiwi.openCaseDetails', async (arg?: unknown) => {
    const caseId = await caseIdFrom(arg);
    if (caseId !== undefined) {
      await d.documents.showCase(caseId);
    }
  });
  register('kiwi.openInBrowser', async (arg?: unknown) => {
    let urlPath: string | undefined;
    if (arg instanceof RunNode) {
      urlPath = `/runs/${arg.run.id}/`;
    } else if (arg instanceof PlanNode) {
      urlPath = `/plan/${arg.plan.id}/`;
    } else {
      const caseId = await caseIdFrom(arg);
      urlPath = caseId === undefined ? undefined : `/case/${caseId}/`;
    }
    const url = urlPath && session.webUrl(urlPath);
    if (url) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  });

  register('kiwi.findCase', async () => {
    const c = await pickCase(d, 'Find a test case');
    if (!c) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const execution = activeRun.executionForCase(c.id);
    type Action = vscode.QuickPickItem & { run: () => unknown };
    const actions: Action[] = [];
    if (index.isMapped(c.id)) {
      actions.push({ label: '$(go-to-file) Go to code', run: () => goToCode(c.id) });
    }
    actions.push({ label: '$(play) Run', run: () => runner.run([{ caseId: c.id }]) });
    if (execution) {
      actions.push({ label: '$(edit) Set status in active run…', run: () => setStatus({ caseId: c.id }) });
    } else if (activeRun.run) {
      actions.push({ label: '$(add) Add to active run', run: () => vscode.commands.executeCommand('kiwi.addCaseToActiveRun', c.id) });
    }
    if (editor && editor.document.uri.scheme === 'file') {
      actions.push({
        label: '$(link) Link the test at the cursor to this case',
        description: path.basename(editor.document.fileName),
        run: () => insertMarker(editor, c.id),
      });
    }
    actions.push(
      { label: '$(preview) Show details', run: () => d.documents.showCase(c.id) },
      { label: '$(link-external) Open in Kiwi TCMS', run: () => vscode.commands.executeCommand('kiwi.openInBrowser', c.id) },
    );
    const pick = await vscode.window.showQuickPick(actions, { title: `${caseLabel(c.id)}: ${truncate(c.summary, 80)}` });
    await pick?.run();
  });

  // ---- mapping ----------------------------------------------------------------

  register('kiwi.linkTestToCase', async (arg?: unknown) => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('Open a test file and put the cursor on a test first.');
      return;
    }
    const caseId =
      typeof arg === 'number' ? arg : arg instanceof CaseNode ? arg.testCase.id : (await pickCase(d, 'Link the test at the cursor to…'))?.id;
    if (caseId === undefined) {
      return;
    }
    if (await insertMarker(editor, caseId)) {
      void vscode.window.setStatusBarMessage(`Kiwi: linked to ${caseLabel(caseId)}`, 4000);
    }
  });

  register('kiwi.createCaseFromTest', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('Open a test file and put the cursor on a test first.');
      return;
    }
    const api = session.api;
    const doc = editor.document;
    const info = detectTest(documentLines(doc), editor.selection.active.line, path.extname(doc.fileName));
    const summary = await vscode.window.showInputBox({
      title: 'New Kiwi test case (1/2): summary',
      value: humanizeTestName(info.testName),
      prompt: info.testName ? `Detected test: ${info.testClass ? info.testClass + '.' : ''}${info.testName}` : 'No test definition detected at the cursor',
      validateInput: (v) => (v.trim() ? undefined : 'Summary is required'),
    });
    if (!summary) {
      return;
    }
    const plan = await pickPlan(d, 'New Kiwi test case (2/2): add to test plan');
    if (!plan) {
      return;
    }
    const s = getSettings();
    const [categories, priorities, caseStatuses, author] = await Promise.all([
      api.filterCategories({ product: plan.product }),
      api.filterPriorities({}),
      api.filterCaseStatuses({}),
      session.currentUserId(),
    ]);
    let category = categories.find((c) => c.name === s.newCaseCategory) ?? (categories.length === 1 ? categories[0] : undefined);
    if (!category && categories.length) {
      const pick = await vscode.window.showQuickPick(
        [...categories].sort((a, b) => (a.name === '--default--' ? -1 : b.name === '--default--' ? 1 : a.name.localeCompare(b.name))).map((c) => ({ label: c.name, category: c })),
        { title: 'Category (set "kiwi.newCase.category" to skip this step)' },
      );
      category = pick?.category;
    }
    if (!category) {
      return;
    }
    const activePriorities = priorities.filter((p) => p.is_active !== false);
    const priority = activePriorities.find((p) => p.value === s.newCasePriority) ?? activePriorities[0];
    const caseStatus =
      caseStatuses.find((st) => st.name.toUpperCase() === s.newCaseStatus.toUpperCase()) ??
      caseStatuses.find((st) => st.is_confirmed) ??
      caseStatuses[0];
    if (!priority || !caseStatus) {
      throw new Error('Kiwi TCMS has no priorities or test case statuses configured.');
    }
    const relativeFile = vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, '/');
    const testRef = info.testName ? `${info.testClass ? info.testClass + '.' : ''}${info.testName}` : undefined;
    const created = await api.createCase({
      summary: summary.trim(),
      product: plan.product,
      category: category.id,
      priority: priority.id,
      case_status: caseStatus.id,
      author,
      is_automated: true,
      script: relativeFile,
      arguments: testRef ?? '',
      text: `Automated test \`${relativeFile}\`${testRef ? ` → \`${testRef}\`` : ''}.`,
    });
    await api.addCaseToPlan(plan.id, created.id);
    await d.context.workspaceState.update(LAST_PLAN_KEY, plan.id);
    cache.put([{ ...created, summary: created.summary ?? summary.trim() }]);
    await insertMarker(editor, created.id);
    d.plansTree.refreshPlan(plan.id);

    const buttons = [activeRun.run ? 'Add to Active Run' : undefined, 'Open in Kiwi TCMS'].filter((b): b is string => !!b);
    const pick = await vscode.window.showInformationMessage(
      `Created ${caseLabel(created.id)} in plan "${plan.name}" and linked it to the test.`,
      ...buttons,
    );
    if (pick === 'Add to Active Run') {
      await vscode.commands.executeCommand('kiwi.addCaseToActiveRun', created.id);
    } else if (pick) {
      await vscode.commands.executeCommand('kiwi.openInBrowser', created.id);
    }
  });

  register('kiwi.mappingReport', async (arg?: unknown) => {
    const plan = arg instanceof PlanNode ? arg.plan : await pickPlan(d, 'Mapping report for test plan');
    if (!plan) {
      return;
    }
    const report = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Kiwi: building mapping report for "${plan.name}"…` },
      () => buildMappingReport(d, plan),
    );
    await d.documents.showReport(`plan-${plan.id}`, report);
  });

  // ---- runs & plans ---------------------------------------------------------

  register('kiwi.createRun', async (arg?: unknown) => {
    const api = session.api;
    const plan = arg instanceof PlanNode ? arg.plan : await pickPlan(d, 'Create a test run from plan');
    if (!plan) {
      return;
    }
    const build = await pickBuild(d, plan);
    if (!build) {
      return;
    }
    const cases = await api.filterCases({ plan: plan.id });
    cache.put(cases);
    if (!cases.length) {
      void vscode.window.showWarningMessage(`Plan "${plan.name}" has no test cases.`);
      return;
    }
    const preferConfirmed = cases.some((c) => c.case_status__name === 'CONFIRMED');
    const selected = await vscode.window.showQuickPick(
      cases.map((c) => ({
        label: `${caseLabel(c.id)}: ${c.summary}`,
        description: [c.case_status__name, c.is_automated ? 'automated' : 'manual', index.isMapped(c.id) ? 'mapped' : undefined]
          .filter(Boolean)
          .join(' · '),
        picked: !preferConfirmed || c.case_status__name === 'CONFIRMED',
        testCase: c,
      })),
      { canPickMany: true, title: `Test cases for the new run (${cases.length} in plan)`, matchOnDescription: true },
    );
    if (!selected?.length) {
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const summary = await vscode.window.showInputBox({
      title: 'Test run summary',
      value: `${plan.name} — ${build.name} — ${today}`,
      validateInput: (v) => (v.trim() ? undefined : 'Summary is required'),
    });
    if (!summary) {
      return;
    }
    const manager = await session.currentUserId();
    const run = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Kiwi: creating test run…' },
      async (progress) => {
        const created = await api.createRun({ summary: summary.trim(), plan: plan.id, build: build.id, manager, default_tester: manager });
        let done = 0;
        await mapLimit(selected, 4, async (item) => {
          await api.addCaseToRun(created.id, item.testCase.id);
          progress.report({ message: `${++done}/${selected.length} test cases added`, increment: 100 / selected.length });
        });
        return created;
      },
    );
    await activeRun.setRun(run.id);
    d.runsTree.refresh(true);
    const pick = await vscode.window.showInformationMessage(
      `Created test run #${run.id} with ${selected.length} test cases; it is now the active run.`,
      'Run Automated Cases',
      'Open in Kiwi TCMS',
    );
    if (pick === 'Run Automated Cases') {
      await vscode.commands.executeCommand('kiwi.runTestRun');
    } else if (pick) {
      const url = session.webUrl(`/runs/${run.id}/`);
      if (url) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }
  });

  register('kiwi.addCaseToActiveRun', async (arg?: unknown) => {
    const runId = activeRun.runId;
    if (runId === undefined) {
      void vscode.window.showWarningMessage('Kiwi TCMS: select an active test run first.');
      return;
    }
    const caseId = await caseIdFrom(arg);
    if (caseId === undefined) {
      return;
    }
    if (activeRun.executionForCase(caseId)) {
      void vscode.window.showInformationMessage(`${caseLabel(caseId)} is already part of test run #${runId}.`);
      return;
    }
    await session.api.addCaseToRun(runId, caseId);
    await activeRun.reload();
    d.runsTree.refreshRun(runId);
    void vscode.window.setStatusBarMessage(`Kiwi: added ${caseLabel(caseId)} to run #${runId}`, 4000);
  });
}

// ---- pickers ----------------------------------------------------------------------

type CaseItem = vscode.QuickPickItem & { testCase: TestCase };

/** Live search by ID (`123`, `TC-123`) or summary text. */
export async function pickCase(d: Pick<Deps, 'session' | 'cache' | 'index'>, title: string): Promise<TestCase | undefined> {
  const api = d.session.api;
  const qp = vscode.window.createQuickPick<CaseItem>();
  qp.title = title;
  qp.placeholder = 'Type a test case ID (e.g. 123 or TC-123) or at least 3 characters of the summary';
  qp.matchOnDescription = true;
  let timer: NodeJS.Timeout | undefined;
  let seq = 0;

  const toItem = (c: TestCase): CaseItem => ({
    label: `${caseLabel(c.id)}: ${c.summary}`,
    description: [c.case_status__name, c.is_automated ? 'automated' : 'manual', d.index.isMapped(c.id) ? 'mapped' : undefined]
      .filter(Boolean)
      .join(' · '),
    testCase: c,
  });

  const search = async (value: string) => {
    const q = value.trim();
    const mySeq = ++seq;
    const idMatch = /^(?:tc-?)?(\d+)$/i.exec(q);
    const query = idMatch ? { pk: Number(idMatch[1]) } : q.length >= 3 ? { summary__icontains: q } : undefined;
    if (!query) {
      return;
    }
    qp.busy = true;
    try {
      const found = await api.filterCases(query);
      if (mySeq !== seq) {
        return;
      }
      d.cache.put(found);
      qp.items = found.sort((a, b) => b.id - a.id).slice(0, 200).map(toItem);
    } catch (err) {
      if (mySeq === seq) {
        qp.items = [];
        qp.title = `${title} — ${errorMessage(err)}`;
      }
    } finally {
      if (mySeq === seq) {
        qp.busy = false;
      }
    }
  };

  // Start with the cases mapped in the current file, if any.
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const ids = unique(d.index.markersInFile(editor.document.uri).map((m) => m.caseId));
    qp.items = ids.map((id) => d.cache.get(id)).filter((c): c is TestCase => !!c).map(toItem);
  }

  return new Promise<TestCase | undefined>((resolve) => {
    qp.onDidChangeValue((v) => {
      clearTimeout(timer);
      timer = setTimeout(() => void search(v), 300);
    });
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0]?.testCase);
      qp.hide();
    });
    qp.onDidHide(() => {
      clearTimeout(timer);
      resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}

async function pickPlan(d: Deps, title: string): Promise<TestPlan | undefined> {
  const plans = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Kiwi: loading test plans' },
    () => loadPlans(d.session),
  );
  if (!plans.length) {
    void vscode.window.showWarningMessage('Kiwi TCMS: no active test plans found (check "kiwi.product").');
    return undefined;
  }
  const lastId = d.context.workspaceState.get<number>(LAST_PLAN_KEY);
  const ordered = [...plans].sort((a, b) => Number(b.id === lastId) - Number(a.id === lastId));
  const pick = await vscode.window.showQuickPick(
    ordered.map((p) => ({
      label: `#${p.id} ${p.name}`,
      description: [p.product__name, p.product_version__value, p.id === lastId ? 'last used' : undefined].filter(Boolean).join(' · '),
      plan: p,
    })),
    { title, matchOnDescription: true },
  );
  return pick?.plan;
}

async function pickBuild(d: Deps, plan: TestPlan): Promise<Build | undefined> {
  const api = d.session.api;
  const builds = (await api.filterBuilds({ version: plan.product_version, is_active: true })).sort((a, b) => b.id - a.id);
  type Item = vscode.QuickPickItem & { build?: Build };
  const pick = await vscode.window.showQuickPick<Item>(
    [
      ...builds.map((b) => ({ label: b.name, build: b })),
      { label: '$(add) Create a new build…', description: `for version ${plan.product_version__value ?? plan.product_version}` },
    ],
    { title: `Build for the new run of "${plan.name}"` },
  );
  if (!pick) {
    return undefined;
  }
  if (pick.build) {
    return pick.build;
  }
  const name = await vscode.window.showInputBox({ title: 'New build name', validateInput: (v) => (v.trim() ? undefined : 'Name is required') });
  return name ? api.createBuild({ name: name.trim(), version: plan.product_version, is_active: true }) : undefined;
}

async function buildMappingReport(d: Deps, plan: TestPlan): Promise<string> {
  const cases = await d.session.api.filterCases({ plan: plan.id });
  d.cache.put(cases);
  cases.sort((a, b) => a.id - b.id);
  const url = (p: string) => d.session.webUrl(p) ?? p;
  const caseLink = (c: TestCase) => `[${caseLabel(c.id)}](${url(`/case/${c.id}/`)})`;
  const locations = (id: number) =>
    d.index
      .markersForCase(id)
      .map((m) => {
        const line = m.range.start.line + 1;
        return `[${vscode.workspace.asRelativePath(m.uri)}:${line}](${m.uri.with({ fragment: `L${line}` }).toString()})`;
      })
      .join('<br>');
  const cell = (text: string) => text.replace(/\|/g, '\\|');

  const automatedMapped = cases.filter((c) => c.is_automated && d.index.isMapped(c.id));
  const automatedUnmapped = cases.filter((c) => c.is_automated && !d.index.isMapped(c.id));
  const manualMapped = cases.filter((c) => !c.is_automated && d.index.isMapped(c.id));
  const manual = cases.filter((c) => !c.is_automated && !d.index.isMapped(c.id));

  // Markers anywhere in the workspace that point to non-existing cases.
  const allIds = d.index.caseIds();
  for (const ids of chunk(allIds, 200)) {
    await d.cache.ensure(ids);
  }
  const unknown = allIds.filter((id) => d.cache.isMissing(id)).sort((a, b) => a - b);

  const pct = cases.length ? Math.round(((automatedMapped.length + manualMapped.length) / cases.length) * 100) : 0;
  const out: string[] = [
    `# Mapping report — [#${plan.id} ${plan.name}](${url(`/plan/${plan.id}/`)})`,
    '',
    `Generated ${new Date().toLocaleString()} · ${cases.length} test cases · **${pct}% mapped to code**`,
    '',
    '| Group | Cases |',
    '|---|---|',
    `| Automated and mapped | ${automatedMapped.length} |`,
    `| Automated but **not mapped** | ${automatedUnmapped.length} |`,
    `| Manual but mapped (consider marking automated) | ${manualMapped.length} |`,
    `| Manual | ${manual.length} |`,
    `| Markers referencing unknown cases (workspace) | ${unknown.length} |`,
    '',
  ];
  if (automatedUnmapped.length) {
    out.push('## Automated but not mapped', '', ...automatedUnmapped.map((c) => `- ${caseLink(c)} ${c.summary}${c.script ? ` — script: \`${c.script}\`` : ''}`), '');
  }
  if (manualMapped.length) {
    out.push('## Manual but mapped', '', ...manualMapped.map((c) => `- ${caseLink(c)} ${c.summary} — ${locations(c.id)}`), '');
  }
  if (unknown.length) {
    out.push(
      '## Markers referencing unknown test cases',
      '',
      ...unknown.map((id) => `- ${caseLabel(id)} — ${locations(id)}`),
      '',
    );
  }
  if (automatedMapped.length) {
    out.push(
      '## Mapped',
      '',
      '| Case | Summary | Location |',
      '|---|---|---|',
      ...automatedMapped.map((c) => `| ${caseLink(c)} | ${cell(c.summary)} | ${locations(c.id)} |`),
      '',
    );
  }
  return out.join('\n');
}
