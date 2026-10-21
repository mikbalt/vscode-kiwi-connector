import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { KiwiClient, KiwiRpcError } from '../kiwi/client';

// Tiny fake of the Kiwi TCMS JSON-RPC endpoint.
let server: http.Server;
let baseUrl: string;
let validSession = 'session-1';
const calls: { method: string; params: unknown[]; cookie?: string }[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url !== '/kiwi/json-rpc/') {
        res.writeHead(404, { 'Content-Type': 'text/html' }).end('<html>not found</html>');
        return;
      }
      const { method, params, id } = JSON.parse(body);
      calls.push({ method, params, cookie: req.headers.cookie });
      const reply = (payload: object, headers: Record<string, string> = {}) =>
        res.writeHead(200, { 'Content-Type': 'application/json', ...headers }).end(JSON.stringify({ jsonrpc: '2.0', id, ...payload }));

      if (method === 'Auth.login') {
        if (params[0] === 'alice' && params[1] === 'secret') {
          reply({ result: validSession }, { 'Set-Cookie': `sessionid=${validSession}; Path=/; HttpOnly` });
        } else {
          reply({ error: { code: -32603, message: 'Wrong username or password' } });
        }
        return;
      }
      if (req.headers.cookie !== `sessionid=${validSession}`) {
        reply({ error: { code: -32603, message: `Authentication failed when calling "${method}"` } });
        return;
      }
      if (method === 'TestCase.filter') {
        reply({ result: [{ id: 12, summary: 'Login works', is_automated: true }] });
      } else if (method === 'TestExecution.update') {
        reply({ result: { id: params[0], ...params[1] } });
      } else {
        reply({ error: { code: -32601, message: `Method not found: "${method}"` } });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/kiwi/`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

test('logs in, sends the session cookie and decodes results', async () => {
  const client = new KiwiClient(baseUrl);
  await client.login('alice', 'secret');
  const cases = await client.filterCases({ pk__in: [12] });
  assert.equal(cases[0].summary, 'Login works');
  const last = calls[calls.length - 1];
  assert.equal(last.method, 'TestCase.filter');
  assert.deepEqual(last.params, [{ pk__in: [12] }]);
  assert.equal(last.cookie, 'sessionid=session-1');
});

test('accepts URLs ending with /json-rpc/', () => {
  assert.equal(new KiwiClient('https://tcms.example.com/json-rpc/').baseUrl, 'https://tcms.example.com');
});

test('wrong password surfaces the RPC error', async () => {
  await assert.rejects(new KiwiClient(baseUrl).login('alice', 'nope'), /Wrong username or password/);
});

test('signs in again when the session expired', async () => {
  const client = new KiwiClient(baseUrl);
  await client.login('alice', 'secret');
  validSession = 'session-2'; // server "forgets" the old session
  const updated = await client.updateExecution(5, { status: 4 });
  assert.deepEqual(updated, { id: 5, status: 4 });
});

test('RPC errors are KiwiRpcError with code', async () => {
  const client = new KiwiClient(baseUrl);
  await client.login('alice', 'secret');
  await assert.rejects(client.call('Nope.method'), (err: unknown) => err instanceof KiwiRpcError && err.code === -32601);
});

test('non-JSON responses give a helpful message', async () => {
  const client = new KiwiClient(baseUrl.replace('/kiwi/', '/wrong/'));
  await assert.rejects(client.login('alice', 'secret'), /Is this the correct Kiwi TCMS URL/);
});
