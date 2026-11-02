import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { InvocationContext } from './contracts.js';

// Detect cold-state database/WAL and top-level preference replacement without
// loading SQLite or credentials. Nested/external resources also have a cache TTL.
export async function liteProfileVersion(profile: string, owner: string): Promise<string> {
  const root = path.join(profile, 'owners', createHash('sha256').update(owner).digest('hex').slice(0, 32));
  const entries = await Promise.all([profile, root].map(async directory => {
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    return Promise.all(names.sort().map(async name => {
      try {
        const value = await stat(path.join(directory, name), { bigint: true });
        return [name, String(value.ino), String(value.size), String(value.mtimeNs), String(value.ctimeNs)];
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [name, 'missing']; throw error; }
    }));
  }));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

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
  'maker:goal:get-status', 'maker:get-session-agent-switch-intent',
  'maker:list-agent-commands', 'maker:list-agent-skills', 'maker:get-new-maker-defaults',
  'local-db:messages:estimatedSessionValue', 'local-db:messages:work-details',
  'local-db:subagent-runs:list', 'maker:plugins:get-state', 'maker:side-chat:list:v1',
  'maker:session-background-activity', 'maker:session-background-activity:list', 'maker:session-background-tasks:list',
  'ghosts:composer-list', 'maker:get-context-window-bounds', 'git-context:get-for-session',
  'maker:task-copy', 'learn:list-runs',
]);

type Entry = { channel: string; args: unknown[]; context: InvocationContext; value: unknown; error?: string; bytes: number; expires: number };
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
  private readyChild?: ChildProcess;
  private cleanDrain?: ChildProcess;
  private cacheGeneration = 0;
  starts = 0;
  cacheHits = 0;
  constructor(private readonly options: {
    file: string; profile: string; region: string; auth(): unknown; refresh(): Promise<unknown>;
    push(channel: string, args: unknown[]): void;
    idleMs?: number; startupMs?: number; requestMs?: number; cacheMs?: number;
    cacheVersion?(): Promise<string>;
  }) {
    this.timer = setInterval(() => { void this.idle().catch(() => {}); }, 5_000);
    this.timer.unref();
  }
  get state() { return { executorPid: this.child?.pid ?? null, starts: this.starts, cacheEntries: this.cache.size, cacheBytes: this.bytes, cacheHits: this.cacheHits, draining: !!this.draining }; }
  updateAuth(auth: unknown) { if (this.child) this.send(this.child, { type: 'auth-state', auth }); }
  async busy() {
    if (!this.child) return false;
    if (this.pending.size || this.draining || this.readyChild !== this.child) return true;
    return (await this.rpc('terminal:status', []) as { busy: boolean }).busy;
  }
  invalidate() { this.cacheGeneration++; this.cache.clear(); this.bytes = 0; }
  revoke() {
    this.suspended = true; clearInterval(this.timer); this.invalidate();
    if (this.child?.connected) this.child.disconnect();
  }
  private key(channel: string, args: unknown[], context: InvocationContext) {
    return JSON.stringify([context.source, context.deviceId, context.ownerId, context.controllerCapabilities, channel, args]);
  }
  private diskVersion?: string;
  private put(key: string, entry: Omit<Entry, 'bytes' | 'expires'>) {
    // Remove an old value even when its replacement is too large to retain.
    const previous = this.cache.get(key); if (previous) this.bytes -= previous.bytes;
    this.cache.delete(key);
    const bytes = Buffer.byteLength(JSON.stringify([key, entry]));
    if (bytes > 512 * 1024) return;
    this.cache.set(key, { ...structuredClone(entry), bytes, expires: Date.now() + (this.options.cacheMs ?? 300_000) }); this.bytes += bytes;
    while (this.bytes > 4 * 1024 * 1024 || this.cache.size > 256) {
      const first = this.cache.keys().next().value!;
      this.bytes -= this.cache.get(first)!.bytes; this.cache.delete(first);
    }
  }
  async invoke(channel: string, args: unknown[], context: InvocationContext = { source: 'local' }) {
    const current = () => {
      if (this.suspended) throw new Error('LITE_RESIDENT_STOPPING');
      if (context.signal?.aborted) throw new Error('INVOCATION_CANCELLED');
      context.assertCurrent?.();
    };
    current();
    await this.draining;
    current();
    if (!this.child && this.cache.size && this.options.cacheVersion) {
      const version = await this.options.cacheVersion(); current();
      if (version !== this.diskVersion) this.invalidate();
    }
    const readable = LITE_READS.has(channel), key = this.key(channel, args, context);
    const cached = this.cache.get(key);
    if (!this.child && readable && cached && cached.expires > Date.now()) { this.cacheHits++; if (cached.error) throw new Error(cached.error); return structuredClone(cached.value); }
    if (!readable) this.invalidate();
    if (!this.child || !readable) this.lastWork = Date.now();
    const generation = this.cacheGeneration;
    await this.start(); current();
    const cacheContext = { source: context.source, deviceId: context.deviceId, ownerId: context.ownerId, controllerCapabilities: context.controllerCapabilities };
    let value: unknown;
    try { value = await this.rpc(channel, args, context); }
    catch (error) {
      current();
      if (generation === this.cacheGeneration && readable && error instanceof Error && error.message === 'UNSUPPORTED_CHANNEL')
        this.put(key, { channel, args, context: cacheContext, value: null, error: error.message });
      throw error;
    }
    current();
    if (readable && generation === this.cacheGeneration) this.put(key, { channel, args, context: cacheContext, value });
    return value;
  }
  private start(): Promise<void> {
    if (this.starting) return this.starting;
    // Linux owns a separate process group so an executor crash cannot strand
    // its engines. Normal drains still close them through TerminalService.
    const child = fork(this.options.file, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', detached: process.platform !== 'win32' });
    this.child = child; this.starts++;
    this.starting = new Promise<void>((resolve, reject) => {
      let startupError: Error | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const startupTimer = setTimeout(() => failStart('EXECUTOR_START_TIMEOUT'), this.options.startupMs ?? 120_000);
      const failStart = (code: string) => {
        if (startupError) return;
        startupError = new Error(code); this.invalidate();
        child.kill('SIGTERM');
        killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1_000);
        killTimer.unref();
      };
      child.on('message', (message: any) => {
        if (this.child !== child) return;
        if (message.type === 'ready' && !startupError) { clearTimeout(startupTimer); this.readyChild = child; resolve(); }
        if (message.type === 'startup-error') failStart(message.code);
        if (message.type === 'push') {
          // While awake every query still goes to the authoritative host.
          this.options.push(message.channel, message.args);
        }
        if (message.type === 'auth-refresh') void this.options.refresh().then(
          auth => this.send(child, { type: 'auth-result', id: message.id, auth }),
          () => this.send(child, { type: 'auth-result', id: message.id, error: 'AUTH_REFRESH_FAILED' }));
        if (message.type === 'result') {
          const pending = this.pending.get(message.id); if (!pending) return;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.value);
        }
      });
      child.on('error', () => {
        this.invalidate();
        if (!child.pid) { clearTimeout(startupTimer); this.child = undefined; this.starting = undefined; reject(new Error('EXECUTOR_START_FAILED')); }
      });
      child.once('exit', (code, signal) => {
        clearTimeout(startupTimer); clearTimeout(killTimer);
        if (this.cleanDrain !== child || code !== 0 || signal) {
          this.invalidate();
          if (process.platform !== 'win32' && child.pid) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The owned group has already exited. */ }
          }
        }
        if (this.child === child) { this.child = undefined; this.starting = undefined; this.readyChild = undefined; }
        reject(startupError ?? new Error('EXECUTOR_EXITED'));
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('EXECUTOR_EXITED_OUTCOME_UNKNOWN')); }
        this.pending.clear();
      });
      try { this.send(child, { type: 'init', profile: this.options.profile, region: this.options.region, auth: this.options.auth() }, () => failStart('EXECUTOR_START_FAILED')); }
      catch { failStart('EXECUTOR_START_FAILED'); }
    });
    return this.starting;
  }
  private send(child: ChildProcess, message: object, failed: () => void = () => {}) {
    if (!child.connected) { failed(); return; }
    child.send(message, error => { if (error) failed(); });
  }
  private rpc(channel: string, args: unknown[], context: InvocationContext = { source: 'local' }): Promise<unknown> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(new Error('EXECUTOR_UNAVAILABLE'));
    const id = randomUUID();
    if (context.signal?.aborted) return Promise.reject(new Error('INVOCATION_CANCELLED'));
    const cancel = () => {
      this.invalidate(); this.send(child, { type: 'cancel', id });
      const pending = this.pending.get(id);
      if (pending) { this.pending.delete(id); clearTimeout(pending.timer); pending.reject(new Error('INVOCATION_CANCELLED')); }
    };
    context.signal?.addEventListener('abort', cancel, { once: true });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); cancel(); reject(new Error('EXECUTOR_TIMEOUT_OUTCOME_UNKNOWN')); }, this.options.requestMs ?? 120_000);
      this.pending.set(id, { resolve, reject, timer });
      const { assertCurrent: _check, signal: _signal, ...wire } = context;
      this.send(child, { type: 'invoke', id, channel, args, context: wire }, () => {
        clearTimeout(timer); this.pending.delete(id); this.invalidate(); reject(new Error('EXECUTOR_SEND_FAILED_OUTCOME_UNKNOWN'));
      });
    }).finally(() => context.signal?.removeEventListener('abort', cancel));
  }
  async idle() {
    if (this.suspended || this.polling || this.draining || !this.child || this.readyChild !== this.child || this.pending.size || Date.now() - this.lastWork < (this.options.idleMs ?? 30_000)) return;
    this.polling = true;
    try {
      const status = await this.rpc('terminal:status', []) as { busy: boolean };
      if (status.busy) this.lastWork = Date.now();
      else if (!this.pending.size) await this.drain();
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
      const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      this.cleanDrain = child;
      await this.rpc('lite:drain', []);
      const result = await exited;
      if (result.code !== 0 || result.signal) throw new Error('EXECUTOR_DRAIN_FAILED');
      this.diskVersion = await this.options.cacheVersion?.();
    })().catch(error => { this.invalidate(); throw error; }).finally(() => { this.cleanDrain = undefined; this.draining = undefined; });
    return this.draining;
  }
  async close() {
    const wasSuspended = this.suspended;
    this.suspended = true;
    try { if (await this.busy()) throw new Error('STOP_RUNNING_TASKS_BEFORE_SERVICE_STOP'); }
    catch (error) { this.suspended = wasSuspended; throw error; }
    clearInterval(this.timer);
    await this.draining;
    if (this.child) {
      await this.starting;
      await this.drain();
    }
    this.invalidate();
  }
}
