// Pure heuristics (no vscode import) that find the test a marker belongs to.

export interface TestInfo {
  testName?: string;
  testClass?: string;
  /** 0-based line of the test definition (`def`, `it(`, `@Test void`, Robot test name, `Scenario:` …). */
  definitionLine?: number;
}

interface DefPattern {
  re: RegExp;
  groups: number[];
}

const NOT_A_NAME = new Set([
  'return', 'new', 'else', 'throw', 'await', 'yield', 'case', 'if', 'while', 'for', 'switch', 'catch',
  'do', 'typeof', 'delete', 'in', 'of', 'using', 'lock', 'sizeof', 'when', 'function', 'import', 'package',
]);

const QUOTED = String.raw`(['"\x60])((?:\\.|(?!\1)[^\\])*)\1`;

const DEF_PATTERNS: DefPattern[] = [
  // Python / Ruby
  { re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*[?!]?)/, groups: [1] },
  // Go
  { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, groups: [1] },
  // Gherkin
  { re: /^\s*(?:Scenario(?: Outline| Template)?|Example)\s*:\s*(.+?)\s*$/, groups: [1] },
  // Jest / Mocha / Vitest / Playwright / Cypress / Jasmine
  { re: new RegExp(String.raw`\b(?:it|test|specify|scenario)(?:\.(?:only|skip|concurrent|failing|todo|fixme))?\s*\(\s*${QUOTED}`), groups: [2] },
  // JavaScript functions
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/, groups: [1] },
  // Kotlin
  {
    re: /^\s*(?:(?:public|private|protected|internal|override|open|suspend)\s+)*fun\s+(?:`([^`]+)`|([A-Za-z_]\w*))\s*\(/,
    groups: [1, 2],
  },
  // Java / C# / Groovy / Scala method declaration
  {
    re: /^\s*(?:(?:public|private|protected|internal|static|final|override|virtual|abstract|synchronized|async|unsafe|def)\s+)*([\w<>[\],.?]+)\s+([A-Za-z_]\w*)\s*\([^;]*$/,
    groups: [2],
  },
];

const CLASS_PATTERNS: DefPattern[] = [
  { re: /^\s*(?:export\s+)?(?:(?:public|private|protected|internal|abstract|final|sealed|static|data|open|partial)\s+)*class\s+([A-Za-z_]\w*)/, groups: [1] },
  { re: new RegExp(String.raw`\bdescribe(?:\.\w+)?\s*\(\s*${QUOTED}`), groups: [2] },
  { re: /^\s*Feature\s*:\s*(.+?)\s*$/, groups: [1] },
];

/** Lines a marker usually sits on when it is attached to the definition below it. */
const ANNOTATION_LINE = /^\s*(?:#|\/\/|\/\*|\*|@|\[|--|"""|'''|<!--|$)/;

function matchName(line: string, patterns: DefPattern[]): string | undefined {
  for (const { re, groups } of patterns) {
    const m = re.exec(line);
    if (!m) {
      continue;
    }
    const name = groups.map((g) => m[g]).find((g) => g !== undefined);
    if (!name) {
      continue;
    }
    // Reject statements such as `return foo(` or `else if (` caught by the Java-like pattern.
    if (re === DEF_PATTERNS[DEF_PATTERNS.length - 1].re && (NOT_A_NAME.has(m[1]) || NOT_A_NAME.has(name))) {
      continue;
    }
    return name;
  }
  return undefined;
}

function indentOf(line: string): number {
  return /^\s*/.exec(line)![0].length;
}

function findClass(lines: string[], definitionLine: number): string | undefined {
  const defIndent = indentOf(lines[definitionLine]);
  for (let i = definitionLine - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim()) {
      continue;
    }
    const name = matchName(line, CLASS_PATTERNS);
    if (name && (indentOf(line) < defIndent || /^\s*Feature\s*:/.test(line))) {
      return name;
    }
  }
  return undefined;
}

function robotTest(lines: string[], line: number): TestInfo {
  for (let i = Math.min(line, lines.length - 1); i >= 0; i--) {
    const text = lines[i];
    if (/^\*{3}/.test(text)) {
      break;
    }
    if (/^[^\s#|]/.test(text)) {
      return { testName: text.split(/\s{2,}|\t/)[0].trim(), definitionLine: i };
    }
  }
  return {};
}

/**
 * Finds the test that a marker on `line` belongs to.
 * `extension` is the file extension including the dot (e.g. `.py`), used to pick language specific rules.
 * A marker attached to a class / `describe` block yields only `testClass` (the whole class is the test).
 */
export function detectTest(lines: string[], line: number, extension: string): TestInfo {
  const ext = extension.toLowerCase();
  if (ext === '.robot' || ext === '.resource') {
    return robotTest(lines, line);
  }
  const at = (i: number): TestInfo | undefined => {
    const testName = matchName(lines[i], DEF_PATTERNS);
    if (testName) {
      return { testName, testClass: findClass(lines, i), definitionLine: i };
    }
    const testClass = matchName(lines[i], CLASS_PATTERNS);
    return testClass ? { testClass, definitionLine: i } : undefined;
  };

  const here = lines[line] ?? '';
  const onLine = at(line);
  if (onLine) {
    return onLine;
  }

  // Marker in a comment / decorator / annotation directly above the definition.
  if (ANNOTATION_LINE.test(here)) {
    for (let i = line + 1; i < Math.min(lines.length, line + 20); i++) {
      const found = at(i);
      if (found) {
        return found;
      }
      if (!ANNOTATION_LINE.test(lines[i])) {
        break;
      }
    }
  }

  // Marker inside the body / docstring: take the enclosing definition.
  const indent = indentOf(here);
  for (let i = line - 1; i >= Math.max(0, line - 300); i--) {
    const text = lines[i];
    const found = text.trim() && indentOf(text) < indent ? at(i) : undefined;
    if (found) {
      return found;
    }
  }
  return {};
}

/** Title from an Allure decorator right above the definition, e.g. `@allure.title("[E2E] Login")`. */
export function detectTitle(lines: string[], definitionLine: number): string | undefined {
  for (let i = definitionLine - 1; i >= Math.max(0, definitionLine - 20); i--) {
    const m = /^\s*@allure\.title\(\s*(['"])(.*?)\1\s*\)/.exec(lines[i]);
    if (m) {
      return m[2];
    }
    if (lines[i].trim() && !ANNOTATION_LINE.test(lines[i]) && !/^\s*\)/.test(lines[i])) {
      break;
    }
  }
  return undefined;
}

/** `test_login_with_valid_user` / `testLoginWithValidUser` → `Login with valid user` */
export function humanizeTestName(name: string | undefined): string {
  if (!name) {
    return '';
  }
  let text = name
    .replace(/^test[_\s]+/i, '')
    .replace(/^[Tt]est(?=[A-Z])/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  text = text.toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
