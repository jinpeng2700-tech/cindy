/** Experimental child: the resident process owns authentication and Device Link. */
import { TerminalAuthController, type TerminalAuthSnapshot } from '@cindy/auth-client';
import { TerminalService } from './service.js';
import { TerminalSecretStore } from './secrets.js';
import type { InvocationContext } from './contracts.js';

type AuthState = { snapshot: TerminalAuthSnapshot; token: string | null };
let authState: AuthState;
let service: TerminalService;
let ready: Promise<void>;
let closing = false;
let authId = 0;
const refreshes = new Map<number, { resolve(value: TerminalAuthSnapshot): void; reject(error: Error): void }>();
const requests = new Map<string, AbortController>();
const send = (value: unknown) => { if (process.connected) process.send?.(value as object, () => {}); };
const code = (error: unknown) => error instanceof Error && error.message.startsWith('UNSUPPORTED_CHANNEL:') ? 'UNSUPPORTED_CHANNEL'
  : error instanceof Error && /^[A-Z_]{3,80}$/.test(error.message) ? error.message : 'EXECUTOR_OPERATION_FAILED';

// Only the resident can write the vault. Both processes use the existing encrypted
// store; refresh credentials never travel over IPC or the remote protocol.
class ReadOnlySecrets extends TerminalSecretStore {
  override set(): Promise<void> { return Promise.reject(new Error('LITE_PROTOTYPE_READ_ONLY_VAULT')); }
  override delete(): Promise<void> { return Promise.reject(new Error('LITE_PROTOTYPE_READ_ONLY_VAULT')); }
  override setSync(): void { throw new Error('LITE_PROTOTYPE_READ_ONLY_VAULT'); }
  override deleteSync(): void { throw new Error('LITE_PROTOTYPE_READ_ONLY_VAULT'); }
  override setManySync(): void { throw new Error('LITE_PROTOTYPE_READ_ONLY_VAULT'); }
}

process.on('message', (message: any) => {
  if (message.type === 'auth-state') { authState = message.auth; return; }
  if (message.type === 'init' && !ready) {
    authState = message.auth;
    const profile: string = message.profile;
    service = new TerminalService(profile, message.region, { executionHost: {
      secrets: new ReadOnlySecrets(profile),
      transport: { async listen() {}, async close() {}, publish(channel, args) { send({ type: 'push', channel, args }); } },
      createAuth(options) {
        return new class extends TerminalAuthController {
          override snapshot() { return structuredClone(authState.snapshot); }
          override getAccessToken() { return authState.token; }
          override async initialize() { options.onChange?.(this.snapshot()); return this.snapshot(); }
          override refresh() {
            const id = ++authId;
            return new Promise<TerminalAuthSnapshot>((resolve, reject) => {
              refreshes.set(id, { resolve, reject }); send({ type: 'auth-refresh', id });
            });
          }
          override async logout(): Promise<TerminalAuthSnapshot> { throw new Error('LITE_PROTOTYPE_AUTH_CHANGE_UNSUPPORTED'); }
        }(options);
      },
    } });
    ready = service.start();
    void ready.then(() => send({ type: 'ready' }), error => {
      send({ type: 'startup-error', code: code(error) });
      void service.close().catch(() => {}).finally(() => process.exit(1));
    });
    return;
  }
  if (message.type === 'auth-result') {
    const pending = refreshes.get(message.id); refreshes.delete(message.id);
    if (message.error) pending?.reject(new Error(message.error));
    else { authState = message.auth; pending?.resolve(structuredClone(authState.snapshot)); }
    return;
  }
  if (message.type === 'cancel') { requests.get(message.id)?.abort(); return; }
  if (message.type !== 'invoke' || !ready || closing) return;
  const controller = new AbortController(); requests.set(message.id, controller);
  void (async () => {
    await ready;
    const context: InvocationContext = { ...message.context, signal: controller.signal,
      assertCurrent() { if (controller.signal.aborted || closing) throw new Error('INVOCATION_CANCELLED'); } };
    context.assertCurrent?.();
    if (message.channel === 'lite:drain') {
      const status = await service.invoke('terminal:status', [], { source: 'local' }) as { busy: boolean };
      if (status.busy || requests.size !== 1) throw new Error('EXECUTOR_BUSY');
      closing = true;
      await service.close();
      if (process.connected) process.send?.({ type: 'result', id: message.id, value: { closed: true } }, () => process.exit(0));
      else process.exit(0);
      return;
    }
    const value = await service.invoke(message.channel, message.args, context);
    context.assertCurrent?.();
    send({ type: 'result', id: message.id, value });
  })().catch(error => send({ type: 'result', id: message.id, error: code(error) }))
    .finally(() => requests.delete(message.id));
});
process.on('disconnect', () => {
  closing = true;
  for (const controller of requests.values()) controller.abort();
  for (const pending of refreshes.values()) pending.reject(new Error('RESIDENT_DISCONNECTED'));
  refreshes.clear();
  void Promise.resolve(ready).catch(() => {}).then(() => service?.close()).catch(() => {}).finally(() => process.exit(1));
});
