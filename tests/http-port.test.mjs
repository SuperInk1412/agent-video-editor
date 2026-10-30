// Regression for the flaky `fetch failed: bad port` in the HTTP suites:
// `tests/helpers/http.mjs` used to boot the engine with `port: 0`, and when the
// OS happened to pick a port undici refuses (6000, 6665-6669, 10080, …) every
// `fetch` against the test server died before opening a socket.
//
// These assertions hold the harness to its promise: it only ever hands a test a
// port that `fetch` actually accepts.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  BLOCKED_PORTS, PORT_RANGE, isBlockedPort, pickPort, setup,
} from './helpers/http.mjs';

test('the blocked set covers undici badPorts and never overlaps the harness range', () => {
  // The ports from the reported flake plus a spread of the fetch spec list.
  for (const port of [1, 7, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]) {
    assert.equal(isBlockedPort(port), true, `${port} should be blocked`);
  }
  assert.ok(BLOCKED_PORTS.size >= 82, `badPorts list looks short: ${BLOCKED_PORTS.size}`);
  for (let port = PORT_RANGE.start; port <= PORT_RANGE.end; port += 1) {
    assert.equal(isBlockedPort(port), false, `${port} is inside the harness range but blocked`);
  }
});

test('pickPort only returns ports a real fetch accepts', async () => {
  for (let i = 0; i < 25; i += 1) {
    const port = await pickPort();
    assert.equal(isBlockedPort(port), false, `pickPort returned blocked port ${port}`);
    assert.ok(port >= PORT_RANGE.start && port <= PORT_RANGE.end, `${port} is outside ${PORT_RANGE.start}..${PORT_RANGE.end}`);

    // Strongest form of the check: a server on that port answers a fetch.
    const server = http.createServer((req, res) => res.end('ok'));
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
    } catch (error) {
      if (error.code === 'EADDRINUSE') continue; // lost the probe race; another draw covers it
      throw error;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      assert.equal(await response.text(), 'ok');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test('setup() boots the engine on a fetch-safe port', async (t) => {
  for (let i = 0; i < 3; i += 1) {
    const options = i === 0 ? { port: await pickPort() } : undefined; // also covers explicit-port pass-through
    const { service, get } = await setup(t, options);
    assert.equal(isBlockedPort(service.info.port), false, `engine bound blocked port ${service.info.port}`);
    assert.ok(service.info.port >= PORT_RANGE.start && service.info.port <= PORT_RANGE.end, `engine port ${service.info.port} escaped the range`);
    const response = await get('api/state');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).project.rev, 1);
  }
});
