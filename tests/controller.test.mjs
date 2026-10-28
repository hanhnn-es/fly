// Run without dependencies: node --test tests/*.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {load, deferred, tick, characteristic, attach, telemetry, device} from './helpers.mjs';

test('wire format, CRC, axis order and default heartbeat remain compatible', () => {
  const app = load();
  assert.equal(app.crc16(new TextEncoder().encode('123456789'), 9), 0x29b1);
  Object.assign(app.state, {seq: 0x1233, armed: true, throttle: .5, yaw: -.25, pitch: .75, roll: -1});
  const packet = new DataView(app.makePacket(false));
  assert.equal(packet.byteLength, 14);
  assert.deepEqual([...new Uint8Array(packet.buffer).slice(0, 12)],
    [1, 0, 0x34, 0x12, 0xf4, 1, 6, 0xff, 0xee, 2, 0x18, 0xfc]);
  assert.equal(app.TX_INTERVAL_MS, 20);
  assert.ok(app.intervals.some(timer => timer.ms === 20));
  app.state.seq = 65535;
  assert.equal(new DataView(app.makePacket(true)).getUint16(2, true), 0);
});

test('optional ARM mode preserves the ON/OFF switch without waiting for telemetry', async () => {
  const app = load({requireArm: true}), packets = [];
  attach(app, characteristic(async packet => packets.push(new DataView(packet))));
  Object.assign(app.state, {throttle: .9, yaw: .2, pitch: -.3, roll: .4});
  assert.equal(await app.toggleArm(), true);
  assert.equal(app.state.armed, true);
  assert.equal(app.element('armButton').textContent, 'ARM ON');
  assert.equal(app.element('armButton').disabled, false);
  assert.equal(app.element('flightState').textContent, 'UNKNOWN');
  assert.equal(packets.length, 1);
  assert.equal(packets[0].getUint8(1), 1);
  assert.equal(packets[0].getUint16(4, true), 900);
  assert.equal(await app.toggleArm(), true);
  assert.equal(app.element('armButton').textContent, 'ARM OFF');
  assert.equal(packets.length, 2);
  assert.equal(packets[1].getUint8(1), 0);
  assert.equal(packets[1].getUint16(4, true), 900);
  assert.equal(app.state.pitch, -.3, 'the switch must not reset joystick input');
});

test('telemetry reports the drone state without changing the switch or sending commands', async () => {
  const app = load({requireArm: true}), packets = [];
  attach(app, characteristic(async packet => packets.push(packet)));
  await app.toggleArm();
  for (const [flags, label] of [[4, 'REJECTED'], [2, 'FAILSAFE'], [0, 'SAFE'], [1, 'ARMED']]) {
    app.onTelemetry(telemetry(app, flags));
    assert.equal(app.element('flightState').textContent, label);
    assert.equal(app.state.armed, true);
    assert.equal(app.element('armButton').textContent, 'ARM ON');
    assert.equal(packets.length, 1);
  }
  app.onTelemetry(telemetry(app, 4, app.state.seq, true));
  assert.equal(app.element('flightState').textContent, 'ARMED');
});

test('lost telemetry clears statistics and status but does not turn off the switch', async () => {
  const app = load({requireArm: true}), packets = [];
  attach(app, characteristic(async packet => packets.push(new Uint8Array(packet))));
  await app.toggleArm();
  app.onTelemetry(telemetry(app, 1));
  app.setTime(2600); app.updateMetrics(); await app.runTimers();
  assert.equal(app.element('flightState').textContent, 'UNKNOWN');
  assert.equal(app.element('rtt').textContent, '-- ms');
  assert.equal(app.state.armed, true);
  assert.equal(packets.length, 1);
  await app.sendControl(false, false);
  assert.equal(packets.at(-1)[1], 1);
});

test('rapid toggles keep the latest switch value while writes remain serialized', async () => {
  const app = load({requireArm: true}), writes = [];
  attach(app, characteristic(packet => {
    const held = deferred(); writes.push({packet: new Uint8Array(packet), ...held}); return held.promise;
  }));
  const first = app.toggleArm();
  assert.equal(app.element('armButton').disabled, false);
  const superseded = app.toggleArm();
  const latest = app.toggleArm();
  assert.equal(await superseded, false);
  assert.equal(app.state.armed, true);
  assert.equal(writes.length, 1);
  writes[0].resolve(); await tick();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].packet[1], 1);
  writes[1].resolve();
  assert.equal(await first, true);
  assert.equal(await latest, true);
});

test('STOP resets input and survives a busy write plus subsequent joystick updates', async () => {
  const app = load(), writes = [];
  attach(app, characteristic(packet => {
    const held = deferred(); writes.push({packet: new Uint8Array(packet), ...held}); return held.promise;
  }));
  const writing = app.sendControl(false, false);
  app.state.throttle = .8; app.state.pitch = .4;
  app.managers[1].joystick.setPosition(null, {x: 50, y: -30});
  const stopping = app.stop();
  assert.equal(app.state.armed, false);
  assert.equal(app.state.throttle, 0);
  assert.equal(Math.abs(app.managers[1].joystick.frontPosition.y), 0);
  app.state.throttle = .4;
  assert.equal(await app.sendControl(false, false), false);
  writes[0].resolve(); await tick();
  assert.equal(writes.length, 2);
  assert.equal(writes[1].packet[1], 2);
  assert.deepEqual([...writes[1].packet.slice(4, 12)], Array(8).fill(0));
  writes[1].resolve();
  assert.equal(await writing, true);
  assert.equal(await stopping, true);
  assert.match(app.element('message').textContent, /STOP requested/);
});

test('CONNECT resets the joysticks and starts direct control without ARM or telemetry', async () => {
  const app = load(), packets = [], selected = device(app, characteristic(async p => packets.push(new Uint8Array(p))));
  Object.assign(app.state, {throttle: .9, yaw: 1, pitch: -1, roll: .5});
  app.context.navigator.bluetooth.requestDevice = async options => {
    assert.equal(options.filters[0].services[0], 'd4f20001-8f69-4b7f-9f5a-6c253728d1a0');
    return selected.device;
  };
  assert.equal(await app.connect(), true);
  assert.deepEqual(packets.map(p => p[1]), [0]);
  assert.equal(app.element('armButton').hidden, true);
  assert.equal(app.element('armButton').disabled, true);
  assert.deepEqual([...packets[0].slice(4, 12)], Array(8).fill(0));
  assert.equal(app.element('flightState').textContent, 'UNKNOWN');
  Object.assign(app.state, {throttle: .9, pitch: -.3});
  await app.sendControl(false, false);
  assert.equal(packets[1][1], 0);
  assert.equal(new DataView(packets[1].buffer).getUint16(4, true), 900);
  assert.equal(new DataView(packets[1].buffer).getInt16(8, true), -300);
  app.onTelemetry(telemetry(app, 1));
  assert.equal(app.element('flightState').textContent, 'READY');
  assert.equal(await app.toggleArm(), false);
  assert.equal(packets.length, 2, 'disabled ARM must never send or block a packet');
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
});

test('failed initial write cleans up a partially connected device', async () => {
  const app = load();
  const selected = device(app, characteristic(async () => { throw new Error('Initial write failed'); }));
  app.context.navigator.bluetooth.requestDevice = async () => selected.device;
  assert.equal(await app.connect(), false);
  assert.equal(app.ble.connected, false);
  assert.equal(selected.device.gatt.connected, false);
  assert.match(app.element('message').textContent, /Initial write failed/);
});

test('DISCONNECT closes the BLE link immediately even if a write is stalled', async () => {
  const app = load(), selected = device(app);
  app.context.navigator.bluetooth.requestDevice = async () => selected.device;
  assert.equal(await app.connect(), true);
  const held = deferred();
  app.ble.control = characteristic(() => held.promise);
  const writing = app.sendControl(false, false);
  assert.equal(await app.connect(), true);
  assert.equal(selected.device.gatt.connected, false);
  assert.equal(await writing, false);
  assert.equal(app.state.armed, false);
  held.resolve(); await tick();
});

test('hidden pages pause input and resume direct control without an ARM step', async () => {
  const app = load(), packets = [];
  attach(app, characteristic(async p => packets.push(new Uint8Array(p))));
  app.state.throttle = .7;
  await app.sendControl(false, false);
  app.context.document.hidden = true;
  app.setTime(600); app.requestControlUpdate(); await app.runTimers();
  assert.equal(packets.length, 1);
  assert.equal(app.state.throttle, .7);
  app.context.document.hidden = false;
  app.requestControlUpdate(); await tick();
  assert.equal(packets.length, 2);
  assert.equal(packets.at(-1)[1], 0);
  assert.equal(new DataView(packets.at(-1).buffer).getUint16(4, true), 700);
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
  assert.equal(await app.sendControl(false, false), false);
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
