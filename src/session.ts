import * as vscode from 'vscode';
import { getSettings, updateSetting } from './config';
import { KiwiCertificateError, KiwiClient } from './kiwi/client';
import type { ExecutionStatus } from './kiwi/types';
import { errorMessage, normalizeBaseUrl } from './util';

export class NotConnectedError extends Error {
  constructor() {
    super('Not signed in to Kiwi TCMS.');
    this.name = 'NotConnectedError';
  }
}

export type StatusKind = 'PASSED' | 'FAILED' | 'RUNNING';

const secretKey = (url: string, username: string) => `kiwi.password:${normalizeBaseUrl(url)}|${username}`;

/** Owns the authenticated Kiwi client and data that is stable for the whole session. */
export class Session implements vscode.Disposable {
  private client: KiwiClient | undefined;
  private user: string | undefined;
  private statuses: ExecutionStatus[] | undefined;
  private userId: number | undefined;
  private signingIn = false;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly log: vscode.LogOutputChannel,
  ) {
    void vscode.commands.executeCommand('setContext', 'kiwi.connected', false);
  }

  get connected(): boolean {
    return this.client !== undefined;
  }

  get username(): string | undefined {
    return this.user;
  }

  get api(): KiwiClient {
    if (!this.client) {
      throw new NotConnectedError();
    }
    return this.client;
  }

  /** Absolute URL in the Kiwi web UI, e.g. `webUrl('/case/12/')`. Works from settings even when signed out. */
  webUrl(path: string): string | undefined {
    if (this.client) {
      return this.client.webUrl(path);
    }
    const { url } = getSettings();
    return url ? normalizeBaseUrl(url) + path : undefined;
  }

  /** True when the current connection already reflects the configured URL / user / TLS option. */
  matchesSettings(): boolean {
    const s = getSettings();
    return (
      !!this.client &&
      this.client.baseUrl === normalizeBaseUrl(s.url) &&
      this.user === s.username &&
      this.client.allowSelfSigned === s.allowSelfSigned
    );
  }

  async tryAutoConnect(): Promise<boolean> {
    if (this.signingIn) {
      // Settings written by the sign-in flow must not race with it.
      return this.connected;
    }
    const { url, username } = getSettings();
    const password = url && username ? await this.secrets.get(secretKey(url, username)) : undefined;
    if (!url || !username || !password) {
      this.disconnect();
      return false;
    }
    try {
      await this.connect(url, username, password, getSettings().allowSelfSigned);
      return true;
    } catch (err) {
      this.disconnect();
      this.log.error(`Automatic sign-in to ${url} failed: ${errorMessage(err)}`);
      if (err instanceof KiwiCertificateError) {
        // Accepting stores the setting; the configuration change reconnects automatically.
        await this.offerSkipVerification(err);
        return false;
      }
      const pick = await vscode.window.showWarningMessage(
        `Kiwi TCMS: could not sign in to ${url} — ${errorMessage(err)}`,
        'Sign In',
      );
      if (pick) {
        void vscode.commands.executeCommand('kiwi.signIn');
      }
      return false;
    }
  }

  /** Asks whether to skip TLS verification for this server; stores the choice in `kiwi.allowSelfSignedCertificate`. */
  private async offerSkipVerification(err: KiwiCertificateError): Promise<boolean> {
    const skip = 'Skip Certificate Verification';
    const pick = await vscode.window.showWarningMessage(
      `Kiwi TCMS: ${err.message} Connect anyway without verifying the certificate? Only do this for a server you trust (e.g. an internal Kiwi instance).`,
      { modal: true },
      skip,
    );
    if (pick !== skip) {
      return false;
    }
    await updateSetting('allowSelfSignedCertificate', true);
    this.log.warn(`TLS certificate verification disabled for Kiwi TCMS (${err.url}).`);
    return true;
  }

  async signIn(): Promise<boolean> {
    this.signingIn = true;
    try {
      return await this.runSignIn();
    } finally {
      this.signingIn = false;
    }
  }

  private async runSignIn(): Promise<boolean> {
    const s = getSettings();
    const url = await vscode.window.showInputBox({
      title: 'Kiwi TCMS: Sign In (1/3)',
      prompt: 'Base URL of your Kiwi TCMS instance',
      value: s.url || 'https://',
      ignoreFocusOut: true,
      validateInput: (v) => (/^https?:\/\/\S+$/i.test(v.trim()) ? undefined : 'Enter a URL such as https://tcms.example.com'),
    });
    if (!url) {
      return false;
    }
    const username = await vscode.window.showInputBox({
      title: 'Kiwi TCMS: Sign In (2/3)',
      prompt: 'Username',
      value: s.username,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Username is required'),
    });
    if (!username) {
      return false;
    }
    const password = await vscode.window.showInputBox({
      title: 'Kiwi TCMS: Sign In (3/3)',
      prompt: `Password for ${username.trim()}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) {
      return false;
    }
    const baseUrl = normalizeBaseUrl(url);
    const user = username.trim();
    const attempt = (allowSelfSigned: boolean) =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Signing in to ${baseUrl}…` },
        () => this.connect(baseUrl, user, password, allowSelfSigned),
      );
    try {
      try {
        await attempt(getSettings().allowSelfSigned);
      } catch (err) {
        if (!(err instanceof KiwiCertificateError) || !(await this.offerSkipVerification(err))) {
          throw err;
        }
        await attempt(true);
      }
    } catch (err) {
      this.log.error(`Sign-in to ${baseUrl} failed: ${errorMessage(err)}`);
      void vscode.window.showErrorMessage(`Kiwi TCMS sign-in failed: ${errorMessage(err)}`);
      return false;
    }
    // Store the secret before touching settings: the settings change triggers a reconnect check.
    await this.secrets.store(secretKey(baseUrl, user), password);
    await updateSetting('url', baseUrl);
    await updateSetting('username', user);
    void vscode.window.showInformationMessage(`Signed in to Kiwi TCMS as ${user}.`);
    return true;
  }

  async signOut(): Promise<void> {
    const { url, username } = getSettings();
    try {
      await this.client?.logout();
    } catch (err) {
      this.log.warn(`Logout failed: ${errorMessage(err)}`);
    }
    if (url && username) {
      await this.secrets.delete(secretKey(url, username));
    }
    this.disconnect();
  }

  async executionStatuses(): Promise<ExecutionStatus[]> {
    if (!this.statuses) {
      this.statuses = await this.api.executionStatuses();
    }
    return this.statuses;
  }

  /** Synchronous lookup; returns undefined until {@link executionStatuses} has been loaded once. */
  statusById(id: number): ExecutionStatus | undefined {
    return this.statuses?.find((s) => s.id === id);
  }

  async findStatus(kind: StatusKind): Promise<ExecutionStatus | undefined> {
    const list = await this.executionStatuses();
    const exact = list.find((s) => s.name.toUpperCase() === kind);
    if (exact) {
      return exact;
    }
    if (kind === 'PASSED') {
      return list.find((s) => s.weight > 0);
    }
    if (kind === 'FAILED') {
      return list.find((s) => s.weight < 0);
    }
    return undefined;
  }

  async setExecutionStatus(executionId: number, statusId: number, comment?: string): Promise<void> {
    await this.api.updateExecution(executionId, { status: statusId });
    if (comment) {
      await this.api.addExecutionComment(executionId, comment);
    }
  }

  async currentUserId(): Promise<number> {
    if (this.userId === undefined) {
      const users = await this.api.filterUsers({ username: this.user });
      if (!users.length) {
        throw new Error(`User "${this.user}" was not found in Kiwi TCMS.`);
      }
      this.userId = users[0].id;
    }
    return this.userId;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  private async connect(url: string, username: string, password: string, allowSelfSigned: boolean): Promise<void> {
    const client = new KiwiClient(url, { allowSelfSigned });
    await client.login(username, password);
    this.client = client;
    this.user = username;
    this.statuses = undefined;
    this.userId = undefined;
    this.log.info(
      `Signed in to ${client.baseUrl} as ${username}${allowSelfSigned && url.startsWith('https') ? ' (TLS certificate verification skipped)' : ''}`,
    );
    await vscode.commands.executeCommand('setContext', 'kiwi.connected', true);
    this.changeEmitter.fire();
  }

  private disconnect(): void {
    if (!this.client) {
      return;
    }
    this.client = undefined;
    this.user = undefined;
    this.statuses = undefined;
    this.userId = undefined;
    void vscode.commands.executeCommand('setContext', 'kiwi.connected', false);
    this.changeEmitter.fire();
  }
}
