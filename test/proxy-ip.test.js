import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { lookupProxyLocation } from 'realaddr';

const primary = { success: true, ip: '8.8.8.8', country_code: 'US', region: 'California', city: 'Mountain View', latitude: 37.4, longitude: -122.1, timezone: { id: 'America/Los_Angeles' } };
const fallback = { ip: '2001:4860:4860::8888', country: 'US', stateProv: 'California', city: 'Mountain View', ll: ['37.4', '-122.1'], timezone: 'America/Los_Angeles' };
const ok = data => ({ ok: true, json: async () => data });
const proxy = 'http://user:password@127.0.0.1:8080';

test('public proxy helper returns normalized primary location and destroys agent', async () => {
  let agent, destroyed = false, calls = 0;
  const result = await lookupProxyLocation(proxy, { fetchImpl: async (url, init) => {
    calls++;
    assert.equal(url, 'https://ipwho.is/');
    assert.equal(init.headers, undefined);
    assert.equal(init.redirect, 'error');
    agent = init.agent;
    const destroy = agent.destroy.bind(agent);
    agent.destroy = () => { destroyed = true; destroy(); };
    return ok(primary);
  } });
  assert.deepEqual(result, { ip: primary.ip, country: 'US', state: 'California', city: primary.city, latitude: 37.4, longitude: -122.1, timezone: 'America/Los_Angeles', provider: 'ipwho.is' });
  assert.equal(calls, 1);
  assert.equal(destroyed, true);
});

test('HTTP, network, JSON and incomplete data fall back through proxy agents that are released', async () => {
  let cancelled = false;
  for (const fail of [
    () => ({ ok: false, status: 429, body: { cancel: async () => { cancelled = true; } } }),
    () => { throw new Error('network'); },
    () => ({ ok: true, json: async () => { throw new SyntaxError(); } }),
    () => ok({ ...primary, city: '' }),
    () => ok({ ...primary, ip: 'invalid' }),
    () => ok({ ...primary, latitude: null }),
  ]) {
    let agent, destroyed = false, calls = 0;
    const result = await lookupProxyLocation(proxy, { fetchImpl: async (url, init) => {
      const destroy = init.agent.destroy.bind(init.agent);
      init.agent.destroy = () => { destroyed = true; destroy(); };
      if (++calls === 1) { agent = init.agent; return fail(); }
      assert.equal(url, 'https://geo.myip.link/');
      assert.notEqual(init.agent, agent);
      assert.equal(init.agent.proxy.href, agent.proxy.href);
      assert.equal(destroyed, true);
      destroyed = false;
      return ok(fallback);
    } });
    assert.equal(result.ip, fallback.ip);
    assert.equal(result.latitude, 37.4);
    assert.equal(result.provider, 'geo.myip.link');
    assert.equal(calls, 2);
    assert.equal(destroyed, true);
  }
  assert.ok(cancelled);
});

test('two failed providers return null; invalid options and cancellation fail immediately', async () => {
  let calls = 0;
  assert.equal(await lookupProxyLocation(proxy, { fetchImpl: async () => { calls++; return ok({}); } }), null);
  assert.equal(calls, 2);
  const fetchImpl = () => assert.fail('Unexpected request');
  for (const input of ['', 'host:8080', 'socks4://host:1080', 'http://user:secret@host/path', 'http://user:%ZZ@host']) {
    await assert.rejects(lookupProxyLocation(input, { fetchImpl }), error => error instanceof TypeError && !error.message.includes('secret'));
  }
  for (const timeoutMs of [0, -1, NaN, 1.5, 2147483648]) await assert.rejects(lookupProxyLocation(proxy, { timeoutMs, fetchImpl }), TypeError);
  await assert.rejects(lookupProxyLocation(proxy, { signal: AbortSignal.abort(), fetchImpl }), { name: 'AbortError' });
  const controller = new AbortController();
  calls = 0;
  await assert.rejects(lookupProxyLocation(proxy, { signal: controller.signal, fetchImpl: async () => {
    calls++;
    controller.abort();
    throw controller.signal.reason;
  } }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('SOCKS5 transport authenticates and routes both providers using remote DNS', async t => {
  const targets = [], credentials = [];
  const server = createTcpServer(socket => {
    let pending = Buffer.alloc(0), phase = 'greeting';
    socket.on('error', () => {});
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk]);
      if (phase === 'greeting') {
        if (pending.length < 2 || pending.length < 2 + pending[1]) return;
        const auth = pending.subarray(2, 2 + pending[1]).includes(2);
        pending = pending.subarray(2 + pending[1]);
        phase = auth ? 'auth' : 'connect';
        socket.write(Buffer.from([5, auth ? 2 : 0]));
      }
      if (phase === 'auth') {
        if (pending.length < 2) return;
        const userLength = pending[1];
        if (pending.length < 3 + userLength) return;
        const passLength = pending[2 + userLength];
        if (pending.length < 3 + userLength + passLength) return;
        credentials.push([pending.subarray(2, 2 + userLength).toString(), pending.subarray(3 + userLength, 3 + userLength + passLength).toString()]);
        pending = pending.subarray(3 + userLength + passLength);
        phase = 'connect';
        socket.write(Buffer.from([1, 0]));
      }
      if (phase === 'connect') {
        if (pending.length < 5 || pending.length < 7 + pending[4]) return;
        assert.equal(pending[0], 5);
        assert.equal(pending[1], 1);
        assert.equal(pending[3], 3);
        targets.push(pending.subarray(5, 5 + pending[4]).toString());
        assert.equal(pending.readUInt16BE(5 + pending[4]), 443);
        phase = 'done';
        // Refuse the tunnel after recording its destination: no external traffic.
        socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const scheme of ['socks5', 'socks']) {
    for (const auth of ['', 'user:p%40ss@']) {
      assert.equal(await lookupProxyLocation(`${scheme}://${auth}127.0.0.1:${server.address().port}`, { timeoutMs: 1000 }), null);
    }
  }
  assert.deepEqual(targets, Array(4).fill(['ipwho.is', 'geo.myip.link']).flat());
  assert.deepEqual(credentials, Array(4).fill(['user', 'p@ss']));
});

test('per-provider timeout allows fallback', async () => {
  // Keep the event loop alive while AbortSignal.timeout uses an unref timer.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    let calls = 0;
    const result = await lookupProxyLocation(proxy, { timeoutMs: 10, fetchImpl: async (_, { signal }) => {
      if (++calls === 2) return ok(fallback);
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
    assert.equal(result.provider, 'geo.myip.link');
  } finally {
    clearInterval(keepAlive);
  }
});

test('real transport sends both CONNECT requests and credentials to supplied proxy', async t => {
  const requests = [];
  const server = createServer();
  server.on('connect', (req, socket) => {
    requests.push({ target: req.url, auth: req.headers['proxy-authorization'] });
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await lookupProxyLocation(`http://user:p%40ss@127.0.0.1:${server.address().port}`, { timeoutMs: 1000 });
  assert.equal(result, null);
  assert.deepEqual(requests.map(r => r.target), ['ipwho.is:443', 'geo.myip.link:443']);
  assert.ok(requests.every(r => r.auth === `Basic ${Buffer.from('user:p@ss').toString('base64')}`));
});

test('stalled proxy handshakes time out or abort and release sockets', async t => {
  const sockets = new Set();
  const server = createTcpServer(socket => {
    sockets.add(socket);
    socket.on('data', () => {});
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise(resolve => server.close(resolve));
  });
  for (const scheme of ['http', 'socks5']) {
    const url = `${scheme}://127.0.0.1:${server.address().port}`;
    assert.equal(await lookupProxyLocation(url, { timeoutMs: 50 }), null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      const started = performance.now();
      await assert.rejects(lookupProxyLocation(url, { signal: controller.signal, timeoutMs: 200 }), { name: 'AbortError' });
      assert.ok(performance.now() - started < 180, 'Cancellation should not wait for handshake timeout');
    } finally {
      clearTimeout(timer);
    }
  }
  for (let i = 0; i < 20 && sockets.size; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sockets.size, 0);
});
