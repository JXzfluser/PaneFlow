import { EventEmitter } from 'node:events';
import net from 'node:net';
import type {
  AgentInfo,
  AgentPromptParams,
  AgentReadParams,
  AgentSendKeysParams,
  AgentStartParams,
  AgentWaitParams,
  PaneReadParams,
  PaneReadResult,
  PaneSplitParams,
  PaneWaitForOutputParams,
  PushMessage,
  ReadSource,
  Subscription,
  WorkspaceCreateParams,
  WorkspaceCreateResult,
  WorkspaceInfo,
} from './types.js';

export class HerdrRequestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`herdr ${code}: ${message}`);
    this.name = 'HerdrRequestError';
    this.code = code;
  }
}

export class HerdrConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HerdrConnectionError';
  }
}

export interface HerdrClientOptions {
  socketPath: string;
  /** Per-request timeout when the caller does not specify one. */
  defaultRequestTimeoutMs?: number;
  /** Timeout for each socket connection. */
  connectTimeoutMs?: number;
  /**
   * Event-connection reconnection with bounded backoff. When enabled, a
   * dropped event connection is re-established and re-subscribed.
   */
  reconnect?: { initialDelayMs?: number; maxDelayMs?: number; maxAttempts?: number } | false;
}

interface ReconnectConfig {
  initialDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

interface SubscriptionGroup {
  subscriptions: Subscription[];
  handler: (event: PushMessage) => void;
}

const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * Client for the Herdr server API.
 *
 * Protocol facts (verified against herdr 0.8.2, protocol 20):
 *  - NDJSON over a Unix domain socket: one JSON object per line.
 *  - The API socket serves ONE request per connection: the server closes the
 *    connection right after responding. Each `request()` therefore opens a
 *    fresh connection.
 *  - `events.subscribe` is the exception: on that connection the server keeps
 *    pushing subscription events after the confirmation. The client keeps one
 *    dedicated event connection mirroring the union of all active
 *    subscriptions, with automatic reconnect + re-subscribe.
 */
export class HerdrClient extends EventEmitter {
  private eventSocket: net.Socket | null = null;
  private eventBuffer = '';
  private connectingEvents: Promise<void> | null = null;
  private closedByUser = false;
  private reconnectAttempt = 0;
  private readonly groups = new Set<SubscriptionGroup>();
  private seq = 0;
  private readonly opts: { socketPath: string; defaultRequestTimeoutMs: number; connectTimeoutMs: number; reconnect: ReconnectConfig | false };

  constructor(options: HerdrClientOptions) {
    super();
    const rc =
      options.reconnect === false
        ? false
        : {
            initialDelayMs: options.reconnect?.initialDelayMs ?? 250,
            maxDelayMs: options.reconnect?.maxDelayMs ?? 5_000,
            maxAttempts: options.reconnect?.maxAttempts ?? Infinity,
          };
    this.opts = {
      socketPath: options.socketPath,
      defaultRequestTimeoutMs: options.defaultRequestTimeoutMs ?? 30_000,
      connectTimeoutMs: options.connectTimeoutMs ?? 5_000,
      reconnect: rc,
    };
  }

  get connected(): boolean {
    return this.eventSocket !== null && !this.eventSocket.destroyed;
  }

  // -- one-shot request -------------------------------------------------------

  /** Opens a fresh connection, sends one request, resolves with `result`. */
  async request<T = unknown>(method: string, params: unknown = {}, timeoutMs?: number): Promise<T> {
    const timeout = timeoutMs ?? this.opts.defaultRequestTimeoutMs;
    const id = `pf_${++this.seq}`;
    const line = JSON.stringify({ id, method, params }) + '\n';
    const socket = await this.openSocket();
    return await new Promise<T>((resolve, reject) => {
      let buffer = '';
      let settled = false;
      const finish = (err: Error | null, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (err) reject(err);
        else resolve(value as T);
      };
      const timer = setTimeout(
        () => finish(new HerdrRequestError('timeout', `${method} timed out after ${timeout}ms`)),
        timeout,
      );
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const l = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!l) continue;
          let msg: unknown;
          try {
            msg = JSON.parse(l);
          } catch {
            continue;
          }
          if (typeof msg === 'object' && msg !== null && (msg as { id?: unknown }).id === id) {
            const error = (msg as { error?: { code?: string; message?: string } }).error;
            if (error) {
              finish(new HerdrRequestError(error.code ?? 'unknown', error.message ?? ''));
            } else {
              finish(null, (msg as { result?: unknown }).result as T);
            }
            return;
          }
          // unrelated push on a request connection — ignore defensively
        }
      });
      socket.on('error', (err) => finish(new HerdrConnectionError(`${method}: ${err.message}`)));
      socket.on('close', () => {
        if (!settled) finish(new HerdrConnectionError(`${method}: connection closed before response`));
      });
      socket.write(line, (err) => {
        if (err) finish(new HerdrConnectionError(`${method}: write failed: ${err.message}`));
      });
    });
  }

  // -- event subscription -------------------------------------------------------

  /**
   * Register an event subscription group. All groups are served by a single
   * dedicated event connection mirroring the union of active subscriptions;
   * the connection is (re)built whenever the union changes. Resolves once the
   * server has confirmed the subscription. Returns an unsubscribe function.
   */
  async subscribe(
    subscriptions: Subscription[],
    handler: (event: PushMessage) => void,
  ): Promise<() => void> {
    const group: SubscriptionGroup = { subscriptions, handler };
    const first = this.groups.size === 0;
    this.groups.add(group);
    if (this.closedByUser) return () => this.groups.delete(group);
    if (first) {
      await this.ensureEventConnection();
    } else if (this.connected) {
      // union changed → rebuild so the server's active set matches exactly
      this.rebuildEventConnection();
      await this.ensureEventConnection();
    }
    return () => {
      const had = this.groups.delete(group);
      if (had && this.groups.size === 0) {
        const socket = this.eventSocket;
        this.eventSocket = null;
        socket?.destroy();
      } else if (had && this.connected) {
        this.rebuildEventConnection();
        void this.ensureEventConnection().catch(() => {});
      }
    };
  }

  async close(): Promise<void> {
    this.closedByUser = true;
    this.groups.clear();
    const socket = this.eventSocket;
    this.eventSocket = null;
    if (socket) socket.destroy();
  }

  // -- typed helpers ---------------------------------------------------------

  ping(): Promise<unknown> {
    return this.request('ping');
  }

  sessionSnapshot(): Promise<unknown> {
    return this.request('session.snapshot');
  }

  async workspaceCreate(params: WorkspaceCreateParams): Promise<WorkspaceCreateResult> {
    return this.request<WorkspaceCreateResult>('workspace.create', params);
  }

  workspaceClose(workspaceId: string): Promise<unknown> {
    return this.request('workspace.close', { workspace_id: workspaceId });
  }

  workspaceList(): Promise<{ workspaces: WorkspaceInfo[] }> {
    return this.request('workspace.list');
  }

  paneSplit(params: PaneSplitParams): Promise<{ pane: { pane_id: string; [k: string]: unknown } }> {
    return this.request('pane.split', params);
  }

  paneRead(params: PaneReadParams): Promise<PaneReadResult> {
    return this.request('pane.read', params);
  }

  paneWaitForOutput(params: PaneWaitForOutputParams): Promise<unknown> {
    return this.request('pane.wait_for_output', params);
  }

  paneClose(paneId: string): Promise<unknown> {
    return this.request('pane.close', { pane_id: paneId });
  }

  agentStart(params: AgentStartParams): Promise<unknown> {
    return this.request('agent.start', params);
  }

  agentPrompt(params: AgentPromptParams, timeoutMs?: number): Promise<unknown> {
    return this.request('agent.prompt', params, timeoutMs);
  }

  agentWait(params: AgentWaitParams, timeoutMs?: number): Promise<unknown> {
    return this.request('agent.wait', params, timeoutMs);
  }

  agentGet(target: string): Promise<{ agent: AgentInfo }> {
    return this.request('agent.get', { target });
  }

  agentList(): Promise<{ agents: AgentInfo[] }> {
    return this.request('agent.list');
  }

  agentRead(target: string, source: ReadSource, lines?: number): Promise<PaneReadResult> {
    const params: AgentReadParams = { target, source };
    if (lines !== undefined) params.lines = lines;
    return this.request('agent.read', params);
  }

  agentSendKeys(target: string, keys: string[]): Promise<unknown> {
    const params: AgentSendKeysParams = { target, keys };
    return this.request('agent.send_keys', params);
  }

  // -- event connection internals ---------------------------------------------

  private unionSubscriptions(): Subscription[] {
    const seen = new Set<string>();
    const out: Subscription[] = [];
    for (const g of this.groups) {
      for (const s of g.subscriptions) {
        const key = JSON.stringify(s);
        if (!seen.has(key)) {
          seen.add(key);
          out.push(s);
        }
      }
    }
    return out;
  }

  private rebuilding = false;

  private rebuildEventConnection(): void {
    const socket = this.eventSocket;
    this.eventSocket = null;
    this.eventBuffer = '';
    if (!socket) return;
    this.rebuilding = true;
    socket.once('close', () => {
      this.rebuilding = false;
    });
    socket.destroy();
  }

  private async ensureEventConnection(): Promise<void> {
    if (this.connected) return;
    if (this.connectingEvents) return this.connectingEvents;
    const subs = this.unionSubscriptions();
    this.connectingEvents = (async () => {
      const socket = await this.openSocket();
      this.eventSocket = socket;
      this.eventBuffer = '';
      this.reconnectAttempt = 0;
      const confirmed = this.attachEventSocket(socket, subs);
      this.emit('connect');
      await confirmed;
    })().finally(() => {
      this.connectingEvents = null;
    });
    return this.connectingEvents;
  }

  private attachEventSocket(socket: net.Socket, subs: Subscription[]): Promise<void> {
    const confirmId = `pf_sub_${++this.seq}`;
    // openSocket() resolves after 'connect' has fired, so write immediately.
    socket.write(JSON.stringify({ id: confirmId, method: 'events.subscribe', params: { subscriptions: subs } }) + '\n');
    const confirmed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        // tear the silent connection down so the reconnect loop takes over
        this.onEventSocketDown('subscribe confirm timeout');
        reject(new HerdrRequestError('timeout', 'events.subscribe not confirmed within 10s'));
      }, 10_000);
      const onConfirm = (msg: unknown): void => {
        const error = (msg as { error?: { code?: string; message?: string } } | null)?.error;
        if (error) reject(new HerdrRequestError(error.code ?? 'unknown', error.message ?? ''));
        else resolve();
        cleanup();
      };
      const onClose = (reason: unknown): void => {
        reject(new HerdrConnectionError(`subscription not confirmed: ${String(reason)}`));
        cleanup();
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.off('event-line', onConfirm);
        this.off('event-socket-down', onClose);
      };
      this.on('event-line', onConfirm);
      this.on('event-socket-down', onClose);
    });
    let confirmedNow = false;
    const onLine = (l: string): void => {
      let msg: unknown;
      try {
        msg = JSON.parse(l);
      } catch {
        return;
      }
      this.emit('message', msg);
      if (
        !confirmedNow &&
        typeof msg === 'object' &&
        msg !== null &&
        (msg as { id?: unknown }).id === confirmId
      ) {
        confirmedNow = true;
        this.emit('ready');
        this.emit('event-line', msg); // resolves the confirmation promise
        return;
      }
      // push event → fan out to all group handlers
      for (const g of [...this.groups]) {
        try {
          g.handler(msg as PushMessage);
        } catch (err) {
          this.emit('warn', `subscription handler threw: ${String(err)}`);
        }
      }
    };
    socket.on('data', (chunk: Buffer) => {
      this.eventBuffer += chunk.toString('utf8');
      if (this.eventBuffer.length > MAX_LINE_BYTES) {
        this.onEventSocketDown('protocol violation: line exceeds size limit');
        return;
      }
      let idx: number;
      while ((idx = this.eventBuffer.indexOf('\n')) >= 0) {
        const l = this.eventBuffer.slice(0, idx).trim();
        this.eventBuffer = this.eventBuffer.slice(idx + 1);
        if (l) onLine(l);
      }
    });
    socket.on('error', (err) => {
      if (this.eventSocket === socket) this.onEventSocketDown(`socket error: ${err.message}`);
    });
    socket.on('close', () => {
      if (!this.closedByUser && this.eventSocket === socket) this.onEventSocketDown('socket closed');
    });
    return confirmed;
  }

  private onEventSocketDown(reason: string): void {
    if (this.closedByUser || this.rebuilding) return;
    this.emit('event-socket-down', reason);
    const socket = this.eventSocket;
    this.eventSocket = null;
    this.eventBuffer = '';
    if (socket) socket.destroy();
    this.emit('disconnect', reason);
    if (this.groups.size === 0) return;
    const rc = this.opts.reconnect;
    if (!rc) return;
    if (this.reconnectAttempt >= rc.maxAttempts) {
      this.emit('giveup', reason);
      return;
    }
    const delay = Math.min(rc.initialDelayMs * 2 ** this.reconnectAttempt, rc.maxDelayMs);
    this.reconnectAttempt += 1;
    setTimeout(() => {
      if (this.closedByUser || this.groups.size === 0) return;
      this.ensureEventConnection().catch(() => this.onEventSocketDown('reconnect attempt failed'));
    }, delay);
  }

  private openSocket(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.opts.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new HerdrConnectionError(`connect timeout after ${this.opts.connectTimeoutMs}ms: ${this.opts.socketPath}`));
      }, this.opts.connectTimeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        socket.destroy();
        reject(new HerdrConnectionError(`connect failed: ${err.message}`));
      });
    });
  }
}
