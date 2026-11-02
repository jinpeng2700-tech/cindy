import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { InvocationContext } from './contracts.js';

// Explicit, side-effect-free projections only. A cache miss wakes the real host.
// Never cache auth/permission decisions, files, writes, or remote-resource actions.
export const LITE_READS = new Set([
  'terminal:tasks:list', 'terminal:models:get', 'terminal:engines:list',
  'local-db:sessions:list', 'local-db:sessions:get', 'local-db:sessions:get-many',
  'local-db:messages:list', 'local-db:messages:view', 'local-db:messages:view-intent',
  'local-db:messages:around', 'local-db:messages:around-client-id', 'local-db:history:messages',
  'maker:input:get-projection', 'maker:session-in-turn', 'maker:get-pending-interactions',
  'maker:get-context-usage', 'maker:get-capabilities', 'maker:list-available-agents',
  'maker:provider:list', 'maker:model-disable:get', 'maker:remote-resources:manifest',
  'maker:remote-resources:list', 'maker:remote-resources:get', 'local-db:history:query',
  'maker:schedule:list', 'maker:schedule:list-sidebar-index-runs', 'maker:git-safety:get',
  'sidebar-settings:get-project-aliases', 'terminal:settings:get',
  'git-context:pr-refs:list',
]);

type Entry = { channel: string; args: unknown[]; context: InvocationContext; value: unknown; error?: string; bytes: number };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
export class LiteExecution {
  private child?: ChildProcess;
  private starting?: Promise<void>;
  private draining?: Promise<void>;
  private pending = new Map<string, Pending>();
  private cache = new Map<string, Entry>();
  private bytes = 0;
  private lastWork = Date.now();
  private polling = false;
  private timer: ReturnType<typeof setInterval>;
  private suspended = false;
  starts = 0;
  cacheHits = 0;
  constructor(private readonly options: {
    file: string; profile: string; region: string; auth(): unknown; refresh(): Promise<unknown>;
    push(channel: string, args: unknown[]): void;
    idleMs?: number;
  }) {
    this.timer = setInterval(() => { void this.idle().catch(() => {}); }, 5_000);
    this.timer.unref();
  }
  get state() { return { executorPid: this.child?.pid ?? null, starts: this.starts, cacheEntries: this.cache.size, cacheBytes: this.bytes, cacheHits: this.cacheHits, draining: !!this.draining }; }
  updateAuth(auth: unknown) { if (this.child?.connected) this.child.send({ type: 'auth-state', auth }); }
  async busy() {
    if (!this.child) return false;
    if (this.pending.size || this.draining) return true;
    await this.starting;
    return (await this.rpc('terminal:status', []) as { busy: boolean }).busy;
  }
  invalidate() { this.cache.clear(); this.bytes = 0; }
  revoke() {
    this.suspended = true; clearInterval(this.timer); this.invalidate();
    if (this.child?.connected) this.child.disconnect();
  }
  private key(channel: string, args: unknown[], context: InvocationContext) {
    return JSON.stringify([context.source, context.deviceId, context.ownerId, context.controllerCapabilities, channel, args]);
  }
  private put(key: string, entry: Omit<Entry, 'bytes'>) {
    const bytes = Buffer.byteLength(JSON.stringify([key, entry.value]));
    if (bytes > 512 * 1024) return;
    const previous = this.cache.get(key); if (previous) this.bytes -= previous.bytes;
    this.cache.delete(key); this.cache.set(key, { ...entry, bytes }); this.bytes += bytes;
    while (this.bytes > 4 * 1024 * 1024 || this.cache.size > 256) {
      const first = this.cache.keys().next().value!;
      this.bytes -= this.cache.get(first)!.bytes; this.cache.delete(first);
    }
  }
  async invoke(channel: string, args: unknown[], context: InvocationContext = { source: 'local' }) {
    if (this.suspended) throw new Error('LITE_RESIDENT_STOPPING');
    context.assertCurrent?.();
    await this.draining;
    context.assertCurrent?.();
    const readable = LITE_READS.has(channel), key = this.key(channel, args, context);
    const cached = this.cache.get(key);
    if (!this.child && readable && cached) { this.cacheHits++; if (cached.error) throw new Error(cached.error); return structuredClone(cached.value); }
    if (!readable) this.invalidate();
    if (!this.child || !readable) this.lastWork = Date.now();
    await this.start(); context.assertCurrent?.();
    const cacheContext = { source: context.source, deviceId: context.deviceId, ownerId: context.ownerId, controllerCapabilities: context.controllerCapabilities };
    let value: unknown;
    try { value = await this.rpc(channel, args, context); }
    catch (error) {
      if (readable && error instanceof Error && error.message === 'UNSUPPORTED_CHANNEL')
        this.put(key, { channel, args, context: cacheContext, value: null, error: error.message });
      throw error;
    }
    context.assertCurrent?.();
    if (readable) this.put(key, { channel, args, context: cacheContext, value });
    return value;
  }
  private start(): Promise<void> {
    if (this.starting) return this.starting;
    const child = fork(this.options.file, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced' });
    this.child = child; this.starts++;
    this.starting = new Promise<void>((resolve, reject) => {
      child.on('message', (message: any) => {
        if (message.type === 'ready') resolve();
        if (message.type === 'startup-error') reject(new Error(message.code));
        if (message.type === 'push') {
          // While awake every query still goes to the authoritative host.
          this.options.push(message.channel, message.args);
        }
        if (message.type === 'auth-refresh') void this.options.refresh().then(
          auth => { if (child.connected) child.send({ type: 'auth-result', id: message.id, auth }); },
          () => { if (child.connected) child.send({ type: 'auth-result', id: message.id, error: 'AUTH_REFRESH_FAILED' }); });
        if (message.type === 'result') {
          const pending = this.pending.get(message.id); if (!pending) return;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.value);
        }
      });
      child.once('error', () => reject(new Error('EXECUTOR_START_FAILED')));
      child.once('exit', () => {
        if (this.child === child) { this.child = undefined; this.starting = undefined; }
        reject(new Error('EXECUTOR_EXITED'));
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('EXECUTOR_EXITED_OUTCOME_UNKNOWN')); }
        this.pending.clear();
      });
      child.send({ type: 'init', profile: this.options.profile, region: this.options.region, auth: this.options.auth() });
    });
    return this.starting;
  }
  private rpc(channel: string, args: unknown[], context: InvocationContext = { source: 'local' }): Promise<unknown> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(new Error('EXECUTOR_UNAVAILABLE'));
    const id = randomUUID();
    const cancel = () => { if (child.connected) child.send({ type: 'cancel', id }); };
    context.signal?.addEventListener('abort', cancel, { once: true });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); cancel(); reject(new Error('EXECUTOR_TIMEOUT_OUTCOME_UNKNOWN')); }, 120_000);
      this.pending.set(id, { resolve, reject, timer });
      const { assertCurrent: _check, signal: _signal, ...wire } = context;
      child.send({ type: 'invoke', id, channel, args, context: wire });
    }).finally(() => context.signal?.removeEventListener('abort', cancel));
  }
  async idle() {
    if (this.polling || this.draining || !this.child || this.pending.size || Date.now() - this.lastWork < (this.options.idleMs ?? 30_000)) return;
    this.polling = true;
    try {
      const status = await this.rpc('terminal:status', []) as { busy: boolean };
      if (!status.busy && !this.pending.size) await this.drain();
    } finally { this.polling = false; }
  }
  private drain() {
    this.draining = (async () => {
      // Refresh each bounded read before disposing the owner of mutable state.
      for (const [key, entry] of [...this.cache]) {
        if (entry.error) continue;
        const value = await this.rpc(entry.channel, entry.args, entry.context);
        this.put(key, { ...entry, value });
      }
      const child = this.child!;
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      await this.rpc('lite:drain', []);
      await exited;
    })().finally(() => { this.draining = undefined; });
    return this.draining;
  }
  async close() {
    if (await this.busy()) throw new Error('STOP_RUNNING_TASKS_BEFORE_SERVICE_STOP');
    this.suspended = true; clearInterval(this.timer);
    await this.draining;
    if (this.child) {
      await this.starting;
      await this.drain();
    }
    this.invalidate();
  }
}
