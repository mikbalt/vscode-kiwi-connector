import * as assert from 'node:assert/strict';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { KiwiCertificateError, KiwiClient } from '../kiwi/client';
import { TEST_CERT, TEST_KEY } from './fixtures/tls';

// HTTPS fake of Kiwi with a self-signed certificate for "kiwi.test.invalid",
// reached through 127.0.0.1: both "self-signed" and "host name / IP mismatch".
let server: https.Server;
let baseUrl: string;

before(async () => {
  server = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { method, id } = JSON.parse(body);
      const result = method === 'Auth.login' ? 'tls-session' : [{ id: 1, summary: 'over https' }];
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

test('untrusted certificate is reported as KiwiCertificateError with a readable reason', async () => {
  await assert.rejects(new KiwiClient(baseUrl).login('u', 'p'), (err: unknown) => {
    assert.ok(err instanceof KiwiCertificateError, `expected KiwiCertificateError, got ${err}`);
    assert.match(err.message, /not trusted \((self-signed certificate|the certificate does not match)/);
    return true;
  });
});

test('allowSelfSigned skips certificate verification', async () => {
  const client = new KiwiClient(baseUrl, { allowSelfSigned: true });
  await client.login('u', 'p');
  assert.equal((await client.filterCases({}))[0].summary, 'over https');
});

test('allowSelfSigned still works when the agent is replaced (VS Code proxy support)', async () => {
  // Patch the real module object (the client reads it through getters), like VS Code's proxy patch does.
  const realHttps: { request: unknown } = require('node:https');
  const original = https.request;
  const patched = (...args: unknown[]) => {
    const options = args.find((a) => a && typeof a === 'object' && !(a instanceof URL)) as https.RequestOptions | undefined;
    if (options) {
      options.agent = new https.Agent(); // default agent: verifies certificates
    }
    return (original as (...a: unknown[]) => ReturnType<typeof https.request>)(...args);
  };
  realHttps.request = patched;
  try {
    const client = new KiwiClient(baseUrl, { allowSelfSigned: true });
    await client.login('u', 'p');
    assert.equal((await client.filterCases({}))[0].summary, 'over https');
  } finally {
    realHttps.request = original;
  }
});
