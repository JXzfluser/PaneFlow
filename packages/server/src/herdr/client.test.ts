import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HerdrClient, HerdrRequestError } from './client.js';

let dir: string;
let sockPath: string;

interface MockServer {
  server: net.Server;
  close: () => Promise<void>;
  /** Count of events.subscribe confirmations served. */
  subsSeen: () => number;
}

function startMockServer(
  sockPath: string,
  opts: { pushCannedEvent?: boolean; splitResponses?: boolean } = {},
): Promise<MockServer> {
  return new Promise((resolve, reject) => {
    let subs = 0;
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) onLine(line, socket);
        }
      });
    });
    const reply = (socket: net.Socket, obj: unknown): void => {
      const s = JSON.stringify(obj) + '\n';
      if (opts.splitResponses) {
        const half = Math.floor(s.length / 2);
        socket.write(s.slice(0, half));
        setTimeout(() => socket.write(s.slice(half)), 30);
      } else {
        socket.write(s);
      }
    };
    const onLine = (line: string, socket: net.Socket): void => {
      const msg = JSON.parse(line) as { id: string; method: string; params?: unknown };
      if (msg.method === 'ping') {
        reply(socket, { id: msg.id, result: { pong: true } });
      } else if (msg.method === 'fail') {
        reply(socket, { id: msg.id, error: { code: 'not_found', message: 'nope' } });
      } else if (msg.method === 'slow') {
        // never replies → client timeout path
      } else if (msg.method === 'hangup') {
        setTimeout(() => socket.destroy(), 50); // drop without replying
      } else if (
        msg.method === 'workspace.close' &&
        (msg.params as { workspace_id?: string } | undefined)?.workspace_id === 'w404'
      ) {
        reply(socket, { id: msg.id, error: { code: 'not_found', message: 'no such workspace' } });
      } else if (msg.method === 'events.subscribe') {
        subs += 1;
        reply(socket, { id: msg.id, result: { subscribed: true } });
        if (opts.pushCannedEvent) {
          socket.write(
            JSON.stringify({
              event: { type: 'pane_agent_status_changed', pane_id: 'w9:p1', agent_status: 'blocked' },
            }) + '\n',
          );
        }
      } else {
        reply(socket, { id: msg.id, result: { echo: msg.params } });
      }
    };
    const close = async (): Promise<void> => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    };
    server.on('error', reject);
    server.listen(sockPath, () => resolve({ server, close, subsSeen: () => subs }));
  });
}

let mock: MockServer;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-client-test-'));
  sockPath = path.join(dir, 'test.sock');
  mock = await startMockServer(sockPath);
});

afterAll(async () => {
  await mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeClient(): HerdrClient {
  return new HerdrClient({ socketPath: sockPath, connectTimeoutMs: 2000 });
}

describe('HerdrClient', () => {
  it('completes a request/response roundtrip on its own connection', async () => {
    const client = makeClient();
    const result = await client.request<{ pong: boolean }>('ping');
    expect(result).toEqual({ pong: true });
    await client.request('ping');
    await client.close();
  });

  it('supports concurrent requests on separate connections', async () => {
    const client = makeClient();
    const [a, b, c] = await Promise.all([
      client.request<{ echo: unknown }>('echo', { n: 1 }),
      client.request<{ echo: unknown }>('echo', { n: 2 }),
      client.request<{ pong: boolean }>('ping'),
    ]);
    expect(a.echo).toEqual({ n: 1 });
    expect(b.echo).toEqual({ n: 2 });
    expect(c).toEqual({ pong: true });
    await client.close();
  });

  it('rejects with HerdrRequestError carrying the server error code', async () => {
    const client = makeClient();
    await expect(client.request('fail')).rejects.toMatchObject({
      name: 'HerdrRequestError',
      code: 'not_found',
    });
    await client.close();
  });

  it('times out when the server never replies', async () => {
    const client = makeClient();
    await expect(client.request('slow', {}, 150)).rejects.toMatchObject({
      name: 'HerdrRequestError',
      code: 'timeout',
    });
    await expect(client.request('ping')).resolves.toEqual({ pong: true });
    await client.close();
  });

  it('rejects with HerdrConnectionError when the socket drops mid-request', async () => {
    const client = makeClient();
    await expect(client.request('hangup')).rejects.toMatchObject({ name: 'HerdrConnectionError' });
    await client.close();
  });

  it('buffers partial response frames until the newline arrives', async () => {
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-split-'));
    const p = path.join(dir3, 'split.sock');
    const splitMock = await startMockServer(p, { splitResponses: true });
    const client = new HerdrClient({ socketPath: p });
    await expect(client.request<{ pong: boolean }>('ping')).resolves.toEqual({ pong: true });
    await client.close();
    await splitMock.close();
    fs.rmSync(dir3, { recursive: true, force: true });
  });

  it('routes pushed events on the event connection to subscribers', async () => {
    const client = makeClient();
    // dedicated mock that pushes a canned event right after subscribe confirm
    const pushDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-push-'));
    const pushSock = path.join(pushDir, 'push.sock');
    const pushMock = await startMockServer(pushSock, { pushCannedEvent: true });
    const pushClient = new HerdrClient({ socketPath: pushSock });
    const received: unknown[] = [];
    await pushClient.subscribe([{ type: 'pane.agent_status_changed' }], (ev) => {
      received.push(ev);
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toEqual([
      { event: { type: 'pane_agent_status_changed', pane_id: 'w9:p1', agent_status: 'blocked' } },
    ]);
    await pushClient.close();
    await pushMock.close();
    fs.rmSync(pushDir, { recursive: true, force: true });
    await client.close();
  });

  it('reconnects the event connection after a drop and re-subscribes', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-reconnect-'));
    const p = path.join(dir2, 'rc.sock');
    let srv = await startMockServer(p, { pushCannedEvent: true });
    const client = new HerdrClient({
      socketPath: p,
      reconnect: { initialDelayMs: 50, maxDelayMs: 200, maxAttempts: 10 },
    });
    await client.subscribe([{ type: 'pane.agent_status_changed' }], () => {});
    expect(srv.subsSeen()).toBe(1);

    await srv.close(); // destroys connections → client sees the drop
    fs.rmSync(p, { force: true });
    await new Promise((r) => setTimeout(r, 30));
    srv = await startMockServer(p, { pushCannedEvent: true });

    await new Promise((r) => setTimeout(r, 800));
    expect(client.connected).toBe(true);
    // the re-created server saw exactly one re-subscription
    expect(srv.subsSeen()).toBe(1);
    await expect(client.ping()).resolves.toEqual({ pong: true });
    await client.close();
    await srv.close();
    fs.rmSync(dir2, { recursive: true, force: true });
  });

  it('surfaces server errors through typed helpers', async () => {
    const client = makeClient();
    await expect(client.workspaceClose('w404')).rejects.toMatchObject({
      name: 'HerdrRequestError',
    });
    await client.close();
  });
});
