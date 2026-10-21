import * as vscode from 'vscode';

interface StatusLook {
  icon: string;
  color: string;
}

const BY_NAME: Record<string, StatusLook> = {
  PASSED: { icon: 'pass', color: 'testing.iconPassed' },
  FAILED: { icon: 'error', color: 'testing.iconFailed' },
  ERROR: { icon: 'warning', color: 'testing.iconErrored' },
  BLOCKED: { icon: 'circle-slash', color: 'charts.orange' },
  WAIVED: { icon: 'debug-step-over', color: 'charts.blue' },
  RUNNING: { icon: 'sync', color: 'charts.blue' },
  PAUSED: { icon: 'debug-pause', color: 'charts.yellow' },
  IDLE: { icon: 'circle-large-outline', color: 'testing.iconQueued' },
};

function look(name: string | undefined, weight: number | undefined): StatusLook {
  const known = name ? BY_NAME[name.toUpperCase()] : undefined;
  if (known) {
    return known;
  }
  if (weight !== undefined && weight > 0) {
    return BY_NAME.PASSED;
  }
  if (weight !== undefined && weight < 0) {
    return BY_NAME.FAILED;
  }
  return BY_NAME.IDLE;
}

export function statusThemeIcon(name: string | undefined, weight?: number): vscode.ThemeIcon {
  const l = look(name, weight);
  const id = l.icon === 'sync' ? 'sync~spin' : l.icon;
  return new vscode.ThemeIcon(id, new vscode.ThemeColor(l.color));
}

/** `$(pass)`-style codicon for CodeLens / hover text. */
export function statusCodicon(name: string | undefined, weight?: number): string {
  return `$(${look(name, weight).icon})`;
}
