// Pure helpers (no vscode import) for finding test case markers in source text.

export interface MarkerMatch {
  caseId: number;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
}

export interface CompiledPatterns {
  regexes: RegExp[];
  errors: string[];
}

export function compilePatterns(patterns: string[]): CompiledPatterns {
  const regexes: RegExp[] = [];
  const errors: string[] = [];
  for (const pattern of patterns) {
    try {
      const re = new RegExp(pattern, 'gi');
      const groups = new RegExp(`${pattern}|`).exec('')!.length - 1;
      if (groups < 1) {
        errors.push(`"${pattern}" has no capture group for the test case ID`);
        continue;
      }
      regexes.push(re);
    } catch (err) {
      errors.push(`"${pattern}": ${(err as Error).message}`);
    }
  }
  return { regexes, errors };
}

export function findMarkers(text: string, regexes: RegExp[]): MarkerMatch[] {
  const lineStarts = computeLineStarts(text);
  const seen = new Set<string>();
  const results: MarkerMatch[] = [];

  for (const re of regexes) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const captured = m.slice(1).find((g) => g !== undefined);
      if (!captured) {
        continue;
      }
      const start = offsetToPosition(lineStarts, m.index);
      const end = offsetToPosition(lineStarts, m.index + m[0].length);
      for (const idText of captured.match(/\d+/g) ?? []) {
        const caseId = Number(idText);
        const key = `${caseId}@${start.line}`;
        if (!caseId || seen.has(key)) {
          continue;
        }
        seen.add(key);
        results.push({
          caseId,
          line: start.line,
          character: start.character,
          endLine: end.line,
          endCharacter: end.character,
        });
      }
    }
  }
  return results.sort((a, b) => a.line - b.line || a.character - b.character);
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) {
      starts.push(i + 1);
    }
  }
  return starts;
}

function offsetToPosition(lineStarts: number[], offset: number): { line: number; character: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return { line: lo, character: offset - lineStarts[lo] };
}

/** Converts a VS Code style glob (`**`, `*`, `?`, `{a,b}`) into a RegExp matched against `/`-separated relative paths. */
export function globToRegExp(glob: string, ignoreCase = process.platform === 'win32'): RegExp {
  let re = '';
  let groupDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      groupDepth++;
      re += '(?:';
    } else if (c === '}' && groupDepth > 0) {
      groupDepth--;
      re += ')';
    } else if (c === ',' && groupDepth > 0) {
      re += '|';
    } else {
      re += c.replace(/[.+^$()|[\]\\}]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, ignoreCase ? 'i' : '');
}
