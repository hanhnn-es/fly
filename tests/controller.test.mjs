// Run without dependencies: node --test tests/controller.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map(match => match[1]).find(script => script.includes('function makePacket'));
const entry = "render();renderFullscreen();setConnection(false,'NOT CONNECTED');";
assert.ok(source.includes(entry), 'Controller entry point must exist');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function node(id) {
  const classes = new Set();
  return {
    id, textContent: id === 'rtt' ? '-- ms' : id === 'txRate' ? '0 Hz' : '',
    disabled: false, style: {}, clientWidth: 200, clientHeight: 240,
    listeners: new Map(), classList: {toggle(name, enabled) {
      enabled ? classes.add(name) : classes.delete(name);
    }},
    addEventListener(type, fn) { this.listeners.set(type, fn); },
    removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); }
  };
}

function load(config = {}) {
  const elements = new Map(), managers = [], intervals = [], frames = new Map();
  let now = 100, frameId = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, node(id));
    return elements.get(id);
  };
  for (const id of ['leftStick', 'rightStick']) {
    element(id).parentElement = node(id + '-pad');
    element(id).parentElement.parentElement = node(id + '-wrap');
    element(id).clientHeight = 200;
  }
  const window = {
    FLIGHT_CONTROL_CONFIG: config,
    matchMedia: query => ({matches: query.includes('landscape')}),
    addEventListener() {},
    nipplejs: {create(options) {
      const joystick = {
        options: {...options}, ui: {back: node('back'), front: node('front')},
        setPosition(_, position) { this.frontPosition = position; }
      };
      const manager = {options: {...options}, joystick, handlers: {},
        getJoystickByUid: () => joystick,
        on(type, fn) { this.handlers[type] = fn; }
      };
      managers.push(manager);
      return manager;
    }}
  };
  const context = {
    window, nipplejs: window.nipplejs,
    document: {getElementById: element, body: node('body'), documentElement: node('html'), addEventListener() {}},
    navigator: {bluetooth: {}}, performance: {now: () => now},
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: () => 1, clearTimeout() {},
    setInterval: (fn, ms) => { intervals.push({fn, ms}); return intervals.length; },
    console
  };
  const exports = 'window.__test={state,ble,pendingTimes,sendControl,connect,onDisconnected,onTelemetry,stop,toggleArm,makePacket,crc16,updateMetrics,TX_INTERVAL_MS};';
  vm.runInNewContext(source.replace(entry, exports + entry), context);
  return {...window.__test, context, element, managers, intervals,
    setTime: time => { now = time; },
    flushFrames() {
      const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn());
    },
    get frameCount() { return frames.size; }
  };
}

function characteristic(write = async () => {}) {
  return {properties: {write: true, writeWithoutResponse: true},
    writeValue: write, writeValueWithResponse: write, writeValueWithoutResponse: write};
}

function attach(app, control = characteristic()) {
  app.ble.connected = true;
  app.ble.control = control;
}

function telemetry(app, flags = 0, seq = app.state.seq, corrupt = false) {
  const bytes = new Uint8Array(8), view = new DataView(bytes.buffer);
  view.setUint8(0, 1); view.setUint8(1, flags); view.setUint16(2, seq, true);
  view.setUint16(6, app.crc16(bytes, 6) ^ Number(corrupt), true);
  return {target: {value: view}};
}

function device(app, control = characteristic(), getService) {
  const result = node('device'), notifications = node('telemetry');
  notifications.startNotifications = async () => notifications;
  result.name = 'Test controller';
  result.gatt = {
    connected: false,
    connect: async () => { result.gatt.connected = true; return result.gatt; },
    getPrimaryService: getService || (async () => ({getCharacteristic: async uuid =>
      uuid.includes('0002-') ? control : notifications})),
    disconnect() {
      result.gatt.connected = false;
      result.listeners.get('gattserverdisconnected')?.({target: result});
    }
  };
  return {device: result, notifications};
}

test('wire format, CRC, axis order and default heartbeat remain compatible', () => {
  const app = load();
  assert.equal(app.crc16(new TextEncoder().encode('123456789'), 9), 0x29b1);
  Object.assign(app.state, {seq: 0x1233, armed: true, throttle: .5, yaw: -.25, pitch: .75, roll: -1});
  const packet = new DataView(app.makePacket(false));
  assert.equal(packet.byteLength, 14);
  assert.deepEqual([...new Uint8Array(packet.buffer).slice(0, 12)],
    [1, 1, 0x34, 0x12, 0xf4, 1, 6, 0xff, 0xee, 2, 0x18, 0xfc]);
  assert.equal(app.TX_INTERVAL_MS, 20);
  assert.ok(app.intervals.some(timer => timer.ms === 20));
  app.state.seq = 65535;
  assert.equal(new DataView(app.makePacket(true)).getUint16(2, true), 0);
});

test('failed ARM rolls back intent and failed STOP never announces remote safety', async () => {
  const app = load();
  attach(app, characteristic(async () => { throw new Error('GATT failed'); }));
  assert.equal(await app.toggleArm(), false);
  assert.equal(app.state.armed, false);
  assert.match(app.element('message').textContent, /ARM could not be sent/);
  assert.equal(app.element('flightState').textContent, 'UNKNOWN');
  app.state.throttle = .7;
  assert.equal(await app.stop(), false);
  assert.equal(app.state.throttle, 0);
  assert.match(app.element('message').textContent, /STOP could not be sent/);
  assert.doesNotMatch(app.element('message').textContent, /system is SAFE/);
});

test('ARM remains pending until write completion and only telemetry confirms ARMED', async () => {
  const app = load(), write = deferred();
  attach(app, characteristic(() => write.promise));
  const arm = app.toggleArm();
  assert.equal(app.element('flightState').textContent, 'ARMING');
  assert.equal(app.element('armButton').disabled, true);
  assert.equal(await app.toggleArm(), false);
  write.resolve();
  assert.equal(await arm, true);
  assert.equal(app.element('flightState').textContent, 'ARM SENT');
  app.onTelemetry(telemetry(app, 1));
  assert.equal(app.element('flightState').textContent, 'ARMED');
});

test('controller rejection is not overwritten by a late ARM completion', async () => {
  const app = load(), write = deferred();
  attach(app, characteristic(() => write.promise));
  const arm = app.toggleArm();
  app.onTelemetry(telemetry(app, 4));
  const rejection = app.element('message').textContent;
  write.resolve();
  assert.equal(await arm, false);
  assert.equal(app.state.armed, false);
  assert.equal(app.element('message').textContent, rejection);
});

test('STOP overrides an in-flight ARM and resets both thumb positions', async () => {
  const app = load(), writes = [];
  attach(app, characteristic(() => { const write = deferred(); writes.push(write); return write.promise; }));
  const arm = app.toggleArm();
  app.state.roll = .7; app.state.pitch = .4;
  app.managers[1].joystick.setPosition(null, {x: 50, y: -30});
  const stop = app.stop();
  assert.equal(app.managers[1].joystick.frontPosition.x, 0);
  assert.equal(Math.abs(app.managers[1].joystick.frontPosition.y), 0);
  assert.equal(app.element('connectButton').disabled, true);
  writes[0].resolve(); await tick();
  writes[1].resolve();
  assert.equal(await arm, false);
  assert.equal(await stop, true);
  assert.equal(app.state.armed, false);
  assert.match(app.element('message').textContent, /STOP command sent/);
});

test('double CONNECT opens one picker; old listeners cannot alter a new session', async () => {
  const app = load(), selection = deferred();
  let requests = 0;
  app.context.navigator.bluetooth.requestDevice = () => { requests++; return selection.promise; };
  const first = app.connect();
  assert.equal(await app.connect(), false);
  assert.equal(requests, 1);
  assert.equal(app.element('connectButton').disabled, true);
  const firstDevice = device(app);
  selection.resolve(firstDevice.device);
  assert.equal(await first, true);
  const oldListener = firstDevice.device.listeners.get('gattserverdisconnected');
  app.onDisconnected({target: firstDevice.device});
  assert.equal(firstDevice.notifications.listeners.size, 0);
  const secondDevice = device(app);
  app.context.navigator.bluetooth.requestDevice = async () => secondDevice.device;
  assert.equal(await app.connect(), true);
  oldListener({target: firstDevice.device});
  assert.equal(app.ble.connected, true);
  assert.equal(app.ble.device, secondDevice.device);
});

test('old write completion cannot unlock the active write of a new session', async () => {
  const app = load(), oldWrite = deferred(), writes = [];
  attach(app, characteristic(() => oldWrite.promise));
  const oldJob = app.sendControl(false, false);
  app.onDisconnected();
  assert.equal(await oldJob, false);
  attach(app, characteristic(() => { const write = deferred(); writes.push(write); return write.promise; }));
  const first = app.sendControl(false, false), second = app.sendControl(false, false);
  oldWrite.resolve(); await tick();
  assert.equal(writes.length, 1);
  assert.equal(app.ble.busy, true);
  writes[0].resolve(); await tick();
  assert.equal(writes.length, 2);
  writes[1].resolve();
  assert.equal(await first, true);
  assert.equal(await second, true);
});

test('missing GATT service is not misreported as a canceled picker', async () => {
  const app = load();
  const error = new Error('Required service missing'); error.name = 'NotFoundError';
  const selected = device(app, characteristic(), async () => { throw error; });
  app.context.navigator.bluetooth.requestDevice = async () => selected.device;
  assert.equal(await app.connect(), false);
  assert.match(app.element('message').textContent, /Required service missing/);
  assert.doesNotMatch(app.element('message').textContent, /canceled/);
  assert.equal(selected.device.gatt.connected, false);
  assert.equal(app.element('connectButton').disabled, false);
});

test('failed initial safety command cleans up a partially connected device', async () => {
  const app = load();
  const selected = device(app, characteristic(async () => { throw new Error('Initial write failed'); }));
  app.context.navigator.bluetooth.requestDevice = async () => selected.device;
  assert.equal(await app.connect(), false);
  assert.equal(app.ble.connected, false);
  assert.equal(selected.device.gatt.connected, false);
  assert.equal(selected.notifications.listeners.size, 0);
  assert.match(app.element('message').textContent, /Initial write failed/);
});

test('RTT expires without incoming telemetry and pending samples stay bounded', async () => {
  const app = load(); attach(app);
  for (let i = 0; i < 250; i++) {
    app.setTime(100 + i * 20);
    await app.sendControl(false, false);
    if (i % 60 === 59) {
      app.setTime(100 + (i + 1) * 20);
      app.updateMetrics();
    }
  }
  assert.ok(app.pendingTimes.size <= 160);
  app.setTime(5110);
  app.onTelemetry(telemetry(app));
  assert.equal(app.element('rtt').textContent, '-- ms');
  app.setTime(6100); app.updateMetrics();
  assert.equal(app.element('rtt').textContent, '30 ms');
  app.setTime(8500); app.updateMetrics();
  assert.equal(app.pendingTimes.size, 0);
  assert.equal(app.element('rtt').textContent, '-- ms');
  app.onDisconnected();
  assert.equal(app.element('txRate').textContent, '0 Hz');
  assert.equal(app.element('rtt').textContent, '-- ms');
});

test('corrupt telemetry cannot change ARM intent', async () => {
  const app = load(); attach(app);
  await app.toggleArm();
  app.onTelemetry(telemetry(app, 4, app.state.seq, true));
  assert.equal(app.state.armed, true);
});

test('joystick data changes immediately while DOM rendering batches into one frame', () => {
  const app = load();
  for (let i = 0; i < 30; i++) app.managers[1].handlers.move({data: {vector: {x: i / 100, y: .2}}});
  assert.equal(app.state.roll, .29);
  assert.equal(app.frameCount, 1);
  app.flushFrames();
  assert.equal(app.element('rightValue').textContent, 'R +029 · P +020');
});

test('invalid interval configuration falls back to the default', () => {
  assert.equal(load({txIntervalMs: Infinity}).TX_INTERVAL_MS, 20);
});

test('connection uses the proven legacy write API when newer bridge methods also exist', async () => {
  const app = load();
  let legacyCalls = 0, modernCalls = 0;
  const control = characteristic(async () => { legacyCalls++; });
  control.writeValueWithResponse = async () => { modernCalls++; throw 'Native bridge rejected the newer write method'; };
  const selected = device(app, control);
  app.context.navigator.bluetooth.requestDevice = async () => selected.device;
  assert.equal(await app.connect(), true);
  assert.equal(legacyCalls, 1);
  assert.equal(modernCalls, 0);
});

test('notification subscription starts before the listener is attached, as in the working commit', async () => {
  const app = load(), selected = device(app);
  let started = false;
  const add = selected.notifications.addEventListener;
  selected.notifications.startNotifications = async () => { started = true; return selected.notifications; };
  selected.notifications.addEventListener = function(type, handler) {
    if (!started) throw 'Notifications have not started';
    add.call(this, type, handler);
  };
  app.context.navigator.bluetooth.requestDevice = async () => selected.device;
  assert.equal(await app.connect(), true);
  assert.equal(selected.notifications.listeners.size, 1);
});

test('native string errors retain the reason and the failing connection stage', async () => {
  const app = load();
  const selected = device(app, characteristic(), async () => { throw 'Native service discovery rejected'; });
  app.context.navigator.bluetooth.requestDevice = async () => selected.device;
  assert.equal(await app.connect(), false);
  assert.match(app.element('message').textContent, /service discovery/);
  assert.match(app.element('message').textContent, /Native service discovery rejected/);
  assert.doesNotMatch(app.element('message').textContent, /undefined/);
});

test('empty native rejection produces a useful error without throwing from catch', async () => {
  const app = load();
  app.context.navigator.bluetooth.requestDevice = async () => { throw undefined; };
  assert.equal(await app.connect(), false);
  assert.match(app.element('message').textContent, /device selection/);
  assert.match(app.element('message').textContent, /no details/i);
  assert.equal(app.element('connectButton').disabled, false);
});

test('legacy-only characteristic works even when properties are omitted by the bridge', async () => {
  const app = load(); let writes = 0;
  const selected = device(app, {writeValue: async () => { writes++; }});
  app.context.navigator.bluetooth.requestDevice = async () => selected.device;
  assert.equal(await app.connect(), true);
  assert.equal(await app.sendControl(false, false), true);
  assert.equal(writes, 2);
});

test('modern-only characteristic still connects when no legacy write API is available', async () => {
  const app = load(); let writes = 0;
  const selected = device(app, {properties: {write: true}, writeValueWithResponse: async () => { writes++; }});
  app.context.navigator.bluetooth.requestDevice = async () => selected.device;
  assert.equal(await app.connect(), true);
  assert.equal(await app.sendControl(false, false), true);
  assert.equal(writes, 2);
});

test('a failed native write preserves its reason and does not retry a command through another API', async () => {
  const app = load(); let writes = 0, retries = 0;
  const control = characteristic(async () => { writes++; throw 'Native write rejected'; });
  control.writeValueWithResponse = async () => { retries++; };
  attach(app, control);
  assert.equal(await app.toggleArm(), false);
  assert.equal(app.state.armed, false);
  assert.match(app.element('message').textContent, /Native write rejected/);
  assert.equal(writes, 1);
  assert.equal(retries, 0);
});

test('the device picker is called directly from the click before disabling its button', async () => {
  const app = load(), selection = deferred(), selected = device(app);
  let disabledWhenCalled;
  app.context.navigator.bluetooth.requestDevice = () => {
    disabledWhenCalled = app.element('connectButton').disabled;
    return selection.promise;
  };
  const attempt = app.connect();
  assert.equal(disabledWhenCalled, false);
  assert.equal(app.element('connectButton').disabled, true);
  selection.resolve(selected.device);
  assert.equal(await attempt, true);
});

test('TX reports packets per second averaged over a 1.2-second reporting window', async () => {
  const app = load(); attach(app);
  assert.ok(app.intervals.some(timer => timer.ms === 1200));
  for (let i = 0; i < 60; i++) {
    app.setTime(100 + i * 20);
    await app.sendControl(false, false);
  }
  app.setTime(1299); app.updateMetrics();
  assert.equal(app.element('txRate').textContent, '0 Hz');
  app.setTime(1300); app.updateMetrics();
  assert.equal(app.element('txRate').textContent, '50 Hz');
});

test('a delayed statistics timer divides by real elapsed time', async () => {
  const app = load(); attach(app);
  for (let i = 0; i < 60; i++) {
    app.setTime(100 + i * 20);
    await app.sendControl(false, false);
  }
  app.setTime(2500); app.updateMetrics();
  assert.equal(app.element('txRate').textContent, '25 Hz');
});

test('failed writes are excluded from the average TX rate', async () => {
  const app = load(); let attempts = 0;
  attach(app, characteristic(async () => { if (++attempts % 2 === 0) throw new Error('Radio busy'); }));
  for (let i = 0; i < 60; i++) {
    app.setTime(100 + i * 20);
    await app.sendControl(false, false);
  }
  app.setTime(1300); app.updateMetrics();
  assert.equal(app.element('txRate').textContent, '25 Hz');
});

test('RTT averages replies in each reporting window without updating per packet', async () => {
  const app = load(); attach(app);
  for (const [started, rtt] of [[100, 20], [200, 40], [300, 90]]) {
    app.setTime(started); await app.sendControl(false, false);
    app.setTime(started + rtt); app.onTelemetry(telemetry(app));
    assert.equal(app.element('rtt').textContent, '-- ms');
  }
  app.setTime(1300); app.updateMetrics();
  assert.equal(app.element('rtt').textContent, '50 ms');
  for (const [started, rtt] of [[1400, 20], [1500, 40]]) {
    app.setTime(started); await app.sendControl(false, false);
    app.setTime(started + rtt); app.onTelemetry(telemetry(app));
    assert.equal(app.element('rtt').textContent, '50 ms');
  }
  app.setTime(2499); app.updateMetrics();
  assert.equal(app.element('rtt').textContent, '50 ms');
  app.setTime(2500); app.updateMetrics();
  assert.equal(app.element('rtt').textContent, '30 ms');
  app.setTime(3700); app.updateMetrics();
  assert.equal(app.element('rtt').textContent, '-- ms');
});
