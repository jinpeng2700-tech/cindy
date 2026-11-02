/** Opt-in measurement prototype. Not the production CLI or an automatic upgrade. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { TerminalAuthController, type AuthRegion } from '@cindy/auth-client';
import { SettingsStore } from './settings.js';
import { TerminalSecretStore } from './secrets.js';
import { TerminalTransportServer } from './transport.js';
import { TerminalDeviceService } from './remote/service.js';
import { TerminalDeviceManagement } from './remote/management.js';
import { LiteExecution } from './lite-execution.js';
import type { InvocationContext } from './contracts.js';
import { VERSION } from './version.js';
import globalEndpoints from '../../../config/endpoint.global.json';
import chinaEndpoints from '../../../config/endpoint.json';

export async function startLiteResident(profile: string, region: AuthRegion) {
  const settings = new SettingsStore(profile), secrets = new TerminalSecretStore(profile);
  let remote: TerminalDeviceService, management: TerminalDeviceManagement, pool: LiteExecution;
  let owner: string | undefined, active = false, closing = false, generation = 0;
  const counts = new Map<string, number>();
  const failures = new Map<string, number>();
  let refreshTimer: ReturnType<typeof setInterval>;
  let auth: TerminalAuthController;
  const createAuth = () => new TerminalAuthController({
    deviceId: settings.deviceId, region, fetch,
    endpoints: { global: { baseUrl: globalEndpoints.authApiBaseUrl }, cn: { baseUrl: chinaEndpoints.authApiBaseUrl } },
    secretStore: { load: async () => { const value = await secrets.get('cindy-auth'); return value ? JSON.parse(value) : null; }, save: value => secrets.set('cindy-auth', JSON.stringify(value)) },
    onAuthorizeUrl() { throw new Error('LITE_PROTOTYPE_LOGIN_UNSUPPORTED'); },
    onChange(snapshot) {
      if (!owner) return;
      active = snapshot.session?.key === owner && snapshot.session.status === 'authenticated';
      if (!active) { generation++; pool?.revoke(); remote?.stop(); }
      pool?.updateAuth({ snapshot, token: auth.getAccessToken() });
      if (active && !closing) remote?.start();
    },
  });
  const check = () => { if (!active || closing) throw new Error('OWNER_UNAVAILABLE'); };
  const authState = () => { check(); return { snapshot: auth.snapshot(), token: auth.getAccessToken() }; };
  const close = async () => {
    if (closing) return;
    if (await pool.busy()) throw new Error('STOP_RUNNING_TASKS_BEFORE_SERVICE_STOP');
    closing = true;
    await pool.close(); clearInterval(refreshTimer);
    management.close(); remote.stop(); await auth.cancel();
    await secrets.flush(); secrets.lock(); await transport.close();
  };
  const invoke = async (channel: string, args: unknown[], context: InvocationContext): Promise<unknown> => {
    check(); context.assertCurrent?.();
    if (counts.size < 256 || counts.has(channel)) counts.set(channel, (counts.get(channel) ?? 0) + 1);
    if (context.source !== 'local' && channel.startsWith('terminal:')) throw new Error('LOCAL_ONLY_COMMAND');
    if (channel === 'terminal:status') return { version: VERSION, platform: process.platform, desktopAvailable: false,
      busy: await pool.busy(), deviceId: settings.deviceId, deviceName: settings.snapshot().effective.deviceName,
      settings: settings.snapshot().effective, vault: secrets.status(), auth: auth.snapshot(), connection: remote.getStatus(),
      prototype: { ...pool.state, memory: process.memoryUsage(), channels: Object.fromEntries(counts), failures: Object.fromEntries(failures), controllers: remote.activeControllers() } };
    if (channel === 'terminal:service:stop') {
      if (await pool.busy()) throw new Error('STOP_RUNNING_TASKS_BEFORE_SERVICE_STOP');
      setImmediate(() => { void close().then(() => process.exit(0)); }); return { stopping: true };
    }
    // Configuration/credential mutation and cross-account hosting are outside
    // this opt-in prototype; the normal service remains the full implementation.
    if (/^terminal:(auth|vault|providers|models:(add|default)|config|engines:(install|update|repair))/.test(channel)
      || channel === 'maker:provider:configure' || channel === 'maker:remote-resources:invoke') throw new Error('LITE_PROTOTYPE_CONFIGURATION_UNSUPPORTED');
    if (channel === 'terminal:devices:list') return management.list();
    if (channel === 'device-link:remote-desktop:v1') throw new Error('DESKTOP_UNAVAILABLE');
    try { return await pool.invoke(channel, args, context); }
    catch (error) {
      const code = error instanceof Error && /^[A-Z_]{3,80}$/.test(error.message) ? error.message : 'FAILED';
      const key = channel + ':' + code;
      if (failures.size < 256 || failures.has(key)) failures.set(key, (failures.get(key) ?? 0) + 1);
      throw error;
    }
  };
  const transport = new TerminalTransportServer(profile, (channel, args, deviceId) => {
    if (deviceId) { check(); return remote.invoke(deviceId, channel, args); }
    return invoke(channel, args, { source: 'local' });
  });
  // Acquire the same exclusive profile endpoint before loading any credentials.
  await transport.listen();
  try {
    await settings.open(); await secrets.open();
    if (secrets.status().locked) throw new Error('LITE_PROTOTYPE_REQUIRES_UNLOCKED_PROFILE');
    auth = createAuth();
    await auth.initialize(); owner = auth.snapshot().session?.key;
    active = !!owner && auth.snapshot().session?.status === 'authenticated'; check();
    pool = new LiteExecution({ file: path.join(path.dirname(fileURLToPath(import.meta.url)), 'lite-executor.js'), profile, region,
      auth: authState, refresh: async () => { await auth.refresh(); return authState(); },
      push(channel, args) {
        if (!active || closing) return;
        transport.publish(channel, args); void remote?.publish(channel, args[0]).catch(() => {});
      },
    });
    const endpoints = region === 'cn' ? chinaEndpoints : globalEndpoints;
    remote = new TerminalDeviceService({
      getToken: async () => active ? auth.getAccessToken() : null,
      getHello: () => ({ deviceName: settings.snapshot().effective.deviceName, platform: process.platform, appVersion: VERSION, remoteControlEnabled: settings.snapshot().effective.remoteEnabled, busy: false }),
      getWsUrl: () => { const url = new URL('/api/device-link/ws', endpoints.deviceLinkApiBaseUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; return url.href; },
      getOwnerScope: () => active && !closing ? `${owner}:${generation}` : null,
      createWebSocket: (url, headers) => new WebSocket(url, { headers }),
      isPeerRevoked: id => management.isRevoked(id),
      isControlTargetDisabled: id => settings.deviceLink.readDeviceLinkSettings().disabledControlDeviceIds.includes(id),
      async invokeLocal(channel, args, context) {
        context.assertCurrent(); check();
        if (context.source.kind !== 'owner') throw new Error('OWNER_REQUIRED');
        const epoch = generation;
        const sourceDevice = ['maker:send', 'maker:input:enqueue', 'maker:input:steer', 'maker:steer'].includes(channel) ? await remote.sourceDevice(context.sourceDeviceId) : undefined;
        const result = await invoke(channel, args, { source: 'remote', ownerId: owner, deviceId: context.sourceDeviceId,
          sourceDevice, controllerCapabilities: context.controllerCapabilities, signal: context.signal,
          assertCurrent() { context.assertCurrent(); check(); if (epoch !== generation) throw new Error('OWNER_CHANGED'); } });
        context.assertCurrent(); check(); return result;
      },
      onPush: push => transport.publish('terminal:remote-event', [push]),
      onLocalPush: (channel, payload) => transport.publish(channel, [payload]),
    });
    management = new TerminalDeviceManagement({ settings, remote, authenticated: () => active,
      ownerScope: () => active ? `${owner}:${generation}` : null, emit: (channel, payload) => transport.publish(channel, [payload]), closePeerResources() {} });
    remote.start();
    refreshTimer = setInterval(() => { void auth.refresh().catch(() => {}); }, 5 * 60_000);
    refreshTimer.unref();
    return { close, invoke: (channel: string, args: unknown[] = []) => invoke(channel, args, { source: 'local' }) };
  } catch (error) { await transport.close(); secrets.lock(); throw error; }
}

if (process.argv.includes('--memory-probe')) {
  console.log(JSON.stringify(process.memoryUsage()));
} else if (process.argv.includes('--profile-dir')) {
  const index = process.argv.indexOf('--profile-dir');
  const profile = process.argv[index + 1];
  const region = process.argv.includes('--cn') ? 'cn' : 'global';
  if (!profile || !path.isAbsolute(profile)) throw new Error('ABSOLUTE_PROFILE_REQUIRED');
  const host = await startLiteResident(profile, region);
  const shutdown = () => { void host.close().then(() => process.exit(0), () => { process.exitCode = 1; }); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
