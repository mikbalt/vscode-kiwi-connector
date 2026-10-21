import * as http from 'http';
import * as https from 'https';
import { normalizeBaseUrl } from '../util';
import type {
  Build,
  CaseStatus,
  Category,
  ExecutionStatus,
  Priority,
  Query,
  TestCase,
  TestExecution,
  TestPlan,
  TestRun,
  User,
} from './types';

export class KiwiRpcError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
    this.name = 'KiwiRpcError';
  }
}

/** The server's TLS certificate is not trusted (self-signed, internal CA, host name mismatch, expired…). */
export class KiwiCertificateError extends Error {
  constructor(
    readonly url: string,
    readonly code: string | undefined,
    detail: string,
  ) {
    super(`The TLS certificate of ${url} is not trusted (${detail}).`);
    this.name = 'KiwiCertificateError';
  }
}

const CERT_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
]);

function certificateProblem(err: NodeJS.ErrnoException): string | undefined {
  const code = err.code ?? '';
  if (!CERT_ERROR_CODES.has(code) && !/certificate|self[- ]signed/i.test(err.message)) {
    return undefined;
  }
  switch (code) {
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'self-signed certificate';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'HOSTNAME_MISMATCH':
      return 'the certificate does not match the host name / IP address';
    case 'CERT_HAS_EXPIRED':
      return 'the certificate has expired';
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
      return 'issued by an unknown / internal certificate authority';
    default:
      return err.message;
  }
}

export interface KiwiClientOptions {
  allowSelfSigned?: boolean;
  timeoutMs?: number;
}

const AUTH_ERROR = /authenticat|not logged in|login required|credentials/i;

/**
 * Minimal JSON-RPC client for Kiwi TCMS (`<base>/json-rpc/`).
 * Authenticates with `Auth.login` and sends the returned session id as the `sessionid` cookie,
 * the same way the official `tcms-api` Python client does.
 */
export class KiwiClient {
  readonly baseUrl: string;
  readonly allowSelfSigned: boolean;
  private readonly endpoint: URL;
  private readonly agent: http.Agent;
  private readonly timeoutMs: number;
  private sessionId: string | undefined;
  private credentials: { username: string; password: string } | undefined;
  private nextId = 1;

  constructor(baseUrl: string, options: KiwiClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.endpoint = new URL('json-rpc/', this.baseUrl + '/');
    this.allowSelfSigned = !!options.allowSelfSigned;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.agent =
      this.endpoint.protocol === 'https:'
        ? new https.Agent({ keepAlive: true, rejectUnauthorized: !this.allowSelfSigned })
        : new http.Agent({ keepAlive: true });
  }

  webUrl(path: string): string {
    return this.baseUrl + path;
  }

  async login(username: string, password: string): Promise<void> {
    this.credentials = { username, password };
    this.sessionId = await this.rawCall<string>('Auth.login', [username, password]);
  }

  async logout(): Promise<void> {
    try {
      await this.rawCall('Auth.logout', []);
    } finally {
      this.sessionId = undefined;
      this.credentials = undefined;
    }
  }

  /** Calls a JSON-RPC method, signing in again once if the session expired. */
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    try {
      return await this.rawCall<T>(method, params);
    } catch (err) {
      if (this.credentials && err instanceof KiwiRpcError && AUTH_ERROR.test(err.message)) {
        await this.login(this.credentials.username, this.credentials.password);
        return this.rawCall<T>(method, params);
      }
      throw err;
    }
  }

  // ---- typed helpers -------------------------------------------------------

  filterPlans(query: Query): Promise<TestPlan[]> {
    return this.call('TestPlan.filter', [query]);
  }
  filterCases(query: Query): Promise<TestCase[]> {
    return this.call('TestCase.filter', [query]);
  }
  filterRuns(query: Query): Promise<TestRun[]> {
    return this.call('TestRun.filter', [query]);
  }
  filterExecutions(query: Query): Promise<TestExecution[]> {
    return this.call('TestExecution.filter', [query]);
  }
  executionStatuses(): Promise<ExecutionStatus[]> {
    return this.call('TestExecutionStatus.filter', [{}]);
  }
  updateExecution(executionId: number, values: Query): Promise<TestExecution> {
    return this.call('TestExecution.update', [executionId, values]);
  }
  addExecutionComment(executionId: number, comment: string): Promise<unknown> {
    return this.call('TestExecution.add_comment', [executionId, comment]);
  }
  createRun(values: Query): Promise<TestRun> {
    return this.call('TestRun.create', [values]);
  }
  addCaseToRun(runId: number, caseId: number): Promise<unknown> {
    return this.call('TestRun.add_case', [runId, caseId]);
  }
  filterBuilds(query: Query): Promise<Build[]> {
    return this.call('Build.filter', [query]);
  }
  createBuild(values: Query): Promise<Build> {
    return this.call('Build.create', [values]);
  }
  filterUsers(query: Query): Promise<User[]> {
    return this.call('User.filter', [query]);
  }
  filterCategories(query: Query): Promise<Category[]> {
    return this.call('Category.filter', [query]);
  }
  filterPriorities(query: Query): Promise<Priority[]> {
    return this.call('Priority.filter', [query]);
  }
  filterCaseStatuses(query: Query): Promise<CaseStatus[]> {
    return this.call('TestCaseStatus.filter', [query]);
  }
  createCase(values: Query): Promise<TestCase> {
    return this.call('TestCase.create', [values]);
  }
  addCaseToPlan(planId: number, caseId: number): Promise<unknown> {
    return this.call('TestPlan.add_case', [planId, caseId]);
  }

  // ---- transport -----------------------------------------------------------

  private rawCall<T>(method: string, params: unknown[]): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: this.nextId++ });
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (this.sessionId) {
      headers.Cookie = `sessionid=${this.sessionId}`;
    }
    const isHttps = this.endpoint.protocol === 'https:';
    const transport = isHttps ? https : http;
    const options: https.RequestOptions = { method: 'POST', headers, agent: this.agent, timeout: this.timeoutMs };
    if (isHttps) {
      // Also set on the request itself: VS Code's proxy support may replace the agent.
      options.rejectUnauthorized = !this.allowSelfSigned;
    }

    return new Promise<T>((resolve, reject) => {
      const req = transport.request(
        this.endpoint,
        options,
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            this.captureSessionCookie(res.headers['set-cookie']);
            const text = Buffer.concat(chunks).toString('utf8');
            let payload: { result?: T; error?: { code?: number; message?: string } };
            try {
              payload = JSON.parse(text);
            } catch {
              reject(
                new KiwiRpcError(
                  `Unexpected response from ${this.endpoint.href} (HTTP ${res.statusCode}). Is this the correct Kiwi TCMS URL?`,
                  res.statusCode,
                ),
              );
              return;
            }
            if (payload.error) {
              reject(new KiwiRpcError(payload.error.message ?? JSON.stringify(payload.error), payload.error.code));
            } else {
              resolve(payload.result as T);
            }
          });
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Request to ${this.endpoint.href} timed out`)));
      req.on('error', (err: NodeJS.ErrnoException) => {
        const problem = certificateProblem(err);
        reject(problem ? new KiwiCertificateError(this.baseUrl, err.code, problem) : err);
      });
      req.end(body);
    });
  }

  private captureSessionCookie(setCookie: string[] | undefined): void {
    for (const cookie of setCookie ?? []) {
      const match = /^sessionid=([^;]*)/.exec(cookie);
      if (match && match[1]) {
        this.sessionId = match[1];
      }
    }
  }
}
