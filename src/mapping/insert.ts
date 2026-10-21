import * as path from 'path';
import * as vscode from 'vscode';
import { EXTENSION_TEMPLATES, getSettings } from '../config';
import { detectTest } from './testName';

export function documentLines(doc: vscode.TextDocument): string[] {
  return doc.getText().split(/\r?\n/);
}

export function markerTextFor(doc: vscode.TextDocument, caseId: number): string {
  const templates = getSettings().insertTemplates;
  const ext = path.extname(doc.fileName).toLowerCase();
  const template = templates[doc.languageId] ?? EXTENSION_TEMPLATES[ext] ?? templates.default ?? '// kiwi: ${id}';
  return template.replace(/\$\{id\}/g, String(caseId));
}

/**
 * Links the test around the cursor to `caseId` by inserting a marker:
 * above the test definition (and its decorators/annotations), as a `[Tags]` entry for Robot Framework,
 * or at the cursor when no test definition can be found.
 */
export async function insertMarker(editor: vscode.TextEditor, caseId: number): Promise<boolean> {
  const doc = editor.document;
  const ext = path.extname(doc.fileName).toLowerCase();
  const lines = documentLines(doc);
  const cursorLine = editor.selection.active.line;
  const text = markerTextFor(doc, caseId);
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

  if (ext === '.robot' || ext === '.resource') {
    return insertRobotTag(editor, lines, cursorLine, text, eol);
  }

  const info = detectTest(lines, cursorLine, ext);
  if (info.definitionLine === undefined) {
    return editor.edit((b) => b.insert(editor.selection.active, text));
  }
  let line = info.definitionLine;
  const indent = /^\s*/.exec(lines[line])![0];
  // Keep decorators / annotations / attributes attached to the definition.
  while (line > 0 && /^\s*[@[]/.test(lines[line - 1]) && /^\s*/.exec(lines[line - 1])![0] === indent) {
    line--;
  }
  return editor.edit((b) => b.insert(new vscode.Position(line, 0), `${indent}${text}${eol}`));
}

function insertRobotTag(
  editor: vscode.TextEditor,
  lines: string[],
  cursorLine: number,
  tag: string,
  eol: string,
): Thenable<boolean> {
  const info = detectTest(lines, cursorLine, '.robot');
  if (info.definitionLine === undefined) {
    return editor.edit((b) => b.insert(editor.selection.active, tag));
  }
  const nameLine = info.definitionLine;
  for (let i = nameLine + 1; i < lines.length && !/^\S/.test(lines[i]); i++) {
    if (/^\s+\[Tags\]/i.test(lines[i])) {
      const end = lines[i].replace(/\s+$/, '').length;
      return editor.edit((b) => b.insert(new vscode.Position(i, end), `    ${tag}`));
    }
  }
  return editor.edit((b) => b.insert(new vscode.Position(nameLine + 1, 0), `    [Tags]    ${tag}${eol}`));
}
