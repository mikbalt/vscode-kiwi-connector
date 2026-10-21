import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { getSettings } from './config';
import { MarkerIndex } from './mapping/index';
import { TestRunner } from './runner';
import { Session } from './session';
import { ActiveRunStore } from './state/activeRun';
import { CaseCache } from './state/caseCache';
import { caseLabel, errorMessage } from './util';
import { KiwiDocuments, SCHEME } from './views/documents';
import { KiwiCodeLensProvider, KiwiHoverProvider, KiwiLinkProvider } from './views/editor';
import { KiwiStatusBar } from './views/statusBar';
import { PlansTreeProvider, RunsTreeProvider } from './views/trees';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Kiwi TCMS', { log: true });
  const session = new Session(context.secrets, log);
  const cache = new CaseCache(session);
  const index = new MarkerIndex(log);
  const activeRun = new ActiveRunStore(session, context.workspaceState, log);
  const runner = new TestRunner(session, index, activeRun, cache, log);
  const runsTree = new RunsTreeProvider(session, index, activeRun, cache);
  const plansTree = new PlansTreeProvider(session, index, cache);
  const documents = new KiwiDocuments(session, index, activeRun, cache);
  const codeLens = new KiwiCodeLensProvider(session, index, activeRun, cache);
  const statusBar = new KiwiStatusBar(session, activeRun);
  const diagnostics = vscode.languages.createDiagnosticCollection('kiwi');
  const selector: vscode.DocumentSelector = { scheme: 'file' };

  context.subscriptions.push(
    log,
    session,
    index,
    activeRun,
    statusBar,
    diagnostics,
    vscode.window.createTreeView('kiwi.runs', { treeDataProvider: runsTree, showCollapseAll: true }),
    vscode.window.createTreeView('kiwi.plans', { treeDataProvider: plansTree, showCollapseAll: true }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, documents),
    vscode.languages.registerCodeLensProvider(selector, codeLens),
    vscode.languages.registerHoverProvider(selector, new KiwiHoverProvider(session, index, activeRun, cache)),
    vscode.languages.registerDocumentLinkProvider(selector, new KiwiLinkProvider(session, index)),
  );

  // Warn about markers that point to test cases which do not exist.
  let validateTimer: NodeJS.Timeout | undefined;
  const scheduleValidation = () => {
    clearTimeout(validateTimer);
    validateTimer = setTimeout(async () => {
      if (!getSettings().validateMapping || !session.connected) {
        diagnostics.clear();
        return;
      }
      try {
        await cache.ensure(index.caseIds());
      } catch (err) {
        log.warn(`Mapping validation skipped: ${errorMessage(err)}`);
        return;
      }
      diagnostics.clear();
      for (const markers of index.files()) {
        const problems = markers
          .filter((m) => cache.isMissing(m.caseId))
          .map((m) => {
            const d = new vscode.Diagnostic(
              m.range,
              `${caseLabel(m.caseId)} does not exist in Kiwi TCMS (or you have no access to it).`,
              vscode.DiagnosticSeverity.Warning,
            );
            d.source = 'Kiwi TCMS';
            return d;
          });
        if (problems.length) {
          diagnostics.set(markers[0].uri, problems);
        }
      }
    }, 1000);
  };

  const refreshAll = async () => {
    cache.clear();
    runsTree.refresh(true);
    plansTree.refresh(true);
    await Promise.all([activeRun.reload(), index.rebuild()]);
  };

  context.subscriptions.push(
    session.onDidChange(() => {
      cache.clear();
      runsTree.refresh(true);
      plansTree.refresh(true);
      statusBar.update();
      codeLens.refresh();
      scheduleValidation();
      void activeRun.reload();
    }),
    index.onDidChange(() => {
      runsTree.refresh();
      plansTree.refresh();
      codeLens.refresh();
      scheduleValidation();
    }),
    activeRun.onDidChange(() => {
      void vscode.commands.executeCommand('setContext', 'kiwi.hasActiveRun', activeRun.run !== undefined);
      runsTree.refresh();
      codeLens.refresh();
      statusBar.update();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('kiwi.mapping')) {
        void index.rebuild();
      }
      if (
        (e.affectsConfiguration('kiwi.url') || e.affectsConfiguration('kiwi.username') || e.affectsConfiguration('kiwi.allowSelfSignedCertificate')) &&
        !session.matchesSettings()
      ) {
        void session.tryAutoConnect();
      }
      if (e.affectsConfiguration('kiwi.product') || e.affectsConfiguration('kiwi.runs')) {
        runsTree.refresh(true);
        plansTree.refresh(true);
      }
      if (e.affectsConfiguration('kiwi.codeLens')) {
        codeLens.refresh();
      }
    }),
    { dispose: () => clearTimeout(validateTimer) },
  );

  registerCommands({ context, session, cache, index, activeRun, runner, runsTree, plansTree, documents, log, refreshAll });

  void index.rebuild();
  void session.tryAutoConnect();
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
