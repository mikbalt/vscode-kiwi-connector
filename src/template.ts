// Pure helpers (no vscode import) for `${variable}` substitution in run commands.

export class MissingVariableError extends Error {
  constructor(readonly variable: string) {
    super(`\${${variable}} is not available`);
    this.name = 'MissingVariableError';
  }
}

export type Variables = Record<string, string | undefined>;

const VARIABLE = /\$\{(env:)?([A-Za-z_]\w*)\}/g;

/**
 * Replaces `${name}` with `vars[name]` and `${env:NAME}` with the environment variable.
 * Unknown names are left untouched (so shell syntax such as `${HOME}` keeps working).
 * A known name whose value is `undefined` throws {@link MissingVariableError} unless `lenient` is set.
 */
export function substitute(
  template: string,
  vars: Variables,
  options: { lenient?: boolean; env?: NodeJS.ProcessEnv } = {},
): string {
  const env = options.env ?? process.env;
  return template.replace(VARIABLE, (whole, envPrefix: string | undefined, name: string) => {
    if (envPrefix) {
      return env[name] ?? '';
    }
    if (!Object.prototype.hasOwnProperty.call(vars, name)) {
      return whole;
    }
    const value = vars[name];
    if (value === undefined) {
      if (options.lenient) {
        return '';
      }
      throw new MissingVariableError(name);
    }
    return value;
  });
}
