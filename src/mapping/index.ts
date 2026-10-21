import * as vscode from 'vscode';
import { getSettings } from '../config';
import { errorMessage } from '../util';
import { compilePatterns, findMarkers, globToRegExp } from './markers';

export interface Marker {
  caseId: number;
  uri: vscode.Uri;
  range: vscode.Range;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Workspace-wide index of test case markers (`# kiwi: 12`, `TC-12`, …), kept up to date while editing. */
export class MarkerIndex implements vscode.Disposable {
  private readonly byFile = new Map<string, Marker[]>();
  private byCase = new Map<number, Marker[]>();
  private regexes: RegExp[] = [];
  private includeRe: RegExp | undefined;
  private excludeRe: RegExp | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;
  private rebuildSeq = 0;
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly log: vscode.LogOutputChannel) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.scheduleDocument(e.document)),
      // Closing a dirty document without saving reverts it to the content on disk.
      vscode.workspace.onDidCloseTextDocument((doc) => void this.scanUri(doc.uri)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.rebuild()),
    );
  }

  markersInFile(uri: vscode.Uri): Marker[] {
    return this.byFile.get(uri.toString()) ?? [];
  }

  markersForCase(caseId: number): Marker[] {
    return this.byCase.get(caseId) ?? [];
  }

  isMapped(caseId: number): boolean {
    return this.byCase.has(caseId);
  }

  caseIds(): number[] {
    return [...this.byCase.keys()];
  }

  files(): IterableIterator<Marker[]> {
    return this.byFile.values();
  }

  markerAt(uri: vscode.Uri, position: vscode.Position): Marker | undefined {
    return this.markersInFile(uri).find((m) => m.range.contains(position));
  }

  async rebuild(): Promise<void> {
    const seq = ++this.rebuildSeq;
    const s = getSettings();
    const { regexes, errors } = compilePatterns(s.mappingPatterns);
    if (errors.length) {
      this.log.warn(`Invalid kiwi.mapping.patterns: ${errors.join('; ')}`);
      void vscode.window.showWarningMessage(`Kiwi TCMS: invalid mapping pattern(s): ${errors.join('; ')}`);
    }
    this.regexes = regexes;
    this.includeRe = globToRegExp(s.mappingInclude);
    this.excludeRe = s.mappingExclude ? globToRegExp(s.mappingExclude) : undefined;

    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(s.mappingInclude);
    this.watcher.onDidCreate((uri) => void this.scanUri(uri));
    this.watcher.onDidChange((uri) => void this.scanUri(uri));
    this.watcher.onDidDelete((uri) => this.setFile(uri, []));

    const started = Date.now();
    const uris = await vscode.workspace.findFiles(s.mappingInclude, s.mappingExclude || undefined, s.mappingMaxFiles);
    const fresh = new Map<string, Marker[]>();
    for (let i = 0; i < uris.length; i += 64) {
      if (seq !== this.rebuildSeq) {
        return;
      }
      await Promise.all(
        uris.slice(i, i + 64).map(async (uri) => {
          const markers = await this.readAndScan(uri);
          if (markers.length) {
            fresh.set(uri.toString(), markers);
          }
        }),
      );
    }
    if (seq !== this.rebuildSeq) {
      return;
    }
    this.byFile.clear();
    fresh.forEach((markers, key) => this.byFile.set(key, markers));
    this.reindex();
    let count = 0;
    fresh.forEach((m) => (count += m.length));
    this.log.info(
      `Mapping index: ${count} marker(s) for ${this.byCase.size} test case(s) in ${fresh.size} file(s); ${uris.length} file(s) scanned in ${Date.now() - started} ms`,
    );
    this.emitter.fire();
  }

  dispose(): void {
    this.watcher?.dispose();
    this.pending.forEach((t) => clearTimeout(t));
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }

  private isTracked(uri: vscode.Uri): boolean {
    if (uri.scheme !== 'file' || !this.includeRe) {
      return false;
    }
    const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
    return this.includeRe.test(rel) && !this.excludeRe?.test(rel);
  }

  private scheduleDocument(doc: vscode.TextDocument): void {
    if (!this.isTracked(doc.uri)) {
      return;
    }
    const key = doc.uri.toString();
    clearTimeout(this.pending.get(key));
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        this.setFile(doc.uri, this.scanText(doc.uri, doc.getText()));
      }, 300),
    );
  }

  private async scanUri(uri: vscode.Uri): Promise<void> {
    if (!this.isTracked(uri)) {
      return;
    }
    this.setFile(uri, await this.readAndScan(uri));
  }

  private async readAndScan(uri: vscode.Uri): Promise<Marker[]> {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) {
      return this.scanText(uri, open.getText());
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_FILE_BYTES) {
        return [];
      }
      return this.scanText(uri, new TextDecoder('utf-8').decode(bytes));
    } catch (err) {
      if (!(err instanceof vscode.FileSystemError)) {
        this.log.warn(`Could not read ${uri.fsPath}: ${errorMessage(err)}`);
      }
      return [];
    }
  }

  private scanText(uri: vscode.Uri, text: string): Marker[] {
    return findMarkers(text, this.regexes).map((m) => ({
      caseId: m.caseId,
      uri,
      range: new vscode.Range(m.line, m.character, m.endLine, m.endCharacter),
    }));
  }

  private setFile(uri: vscode.Uri, markers: Marker[]): void {
    const key = uri.toString();
    const before = this.byFile.get(key) ?? [];
    if (sameMarkers(before, markers)) {
      return;
    }
    if (markers.length) {
      this.byFile.set(key, markers);
    } else {
      this.byFile.delete(key);
    }
    this.reindex();
    this.emitter.fire();
  }

  private reindex(): void {
    const byCase = new Map<number, Marker[]>();
    for (const markers of this.byFile.values()) {
      for (const m of markers) {
        const list = byCase.get(m.caseId);
        if (list) {
          list.push(m);
        } else {
          byCase.set(m.caseId, [m]);
        }
      }
    }
    this.byCase = byCase;
  }
}

function sameMarkers(a: Marker[], b: Marker[]): boolean {
  return a.length === b.length && a.every((m, i) => m.caseId === b[i].caseId && m.range.isEqual(b[i].range));
}
