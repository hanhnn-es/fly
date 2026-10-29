import assert from 'node:assert/strict';
import test from 'node:test';
import {load, deferred, tick, characteristic, device} from './helpers.mjs';

const defaults = {reverse: 0, center_left: 1500, center_right: 1500, min_us: 1000,
  max_us: 2000, amplitude_us: 350, freq_min_dhz: 20, freq_max_dhz: 50,
  pitch_gain: 20, roll_gain: 20, yaw_gain: 20, turn_comp: 0};
const protocol = app => app.context.window.FlightProtocol;

function setup(options = {}) {
  const app = load(options.requireArm ? {requireArm: true} : {});
  const packets = [], events = [];
  let stored = protocol(app).configPacket({...defaults, ...options.config});
  let reads = 0, saves = 0;
  const config = {
    properties: {read: true, write: true},
    async readValue() {
      events.push('read'); reads++;
      if (options.read) return options.read({stored, reads});
      return new DataView(stored.slice(0));
    },
    async writeValue(packet) {
      events.push('save'); saves++;
      if (options.save) await options.save(packet);
      stored = packet.slice(0);
    }
  };
  const control = characteristic(async packet => {
    events.push('control:' + new Uint8Array(packet)[1]); packets.push(new Uint8Array(packet));
    if (options.control) await options.control(packet);
  });
  let selected;
  selected = device(app, control, async () => ({getCharacteristic: async uuid => {
    if (uuid.includes('0002-')) return control;
    if (uuid.includes('0003-')) return selected.notifications;
    assert.ok(uuid.includes('0004-'));
    if (options.missing) throw new Error('Settings are not supported by this drone.');
    return config;
  }}));
  app.context.navigator.bluetooth.requestDevice = async () => selected.device;
  return {app, config, selected, packets, events, get reads() {return reads;},
    get saves() {return saves;}, get stored() {return stored;}};
}

function edit(app) {
  for (const [id, value] of Object.entries({configCenterLeft:1470, configCenterRight:1530,
    configMinPulse:900, configMaxPulse:2100, configAmplitude:425, configTurnComp:25,
    configMinFrequency:1.7, configMaxFrequency:4.5, configPitchGain:-50,
    configRollGain:75, configYawGain:125})) app.element(id).value = String(value);
  app.element('configReverseLeft').checked = true;
  app.element('configReverseRight').checked = true;
}

const edited = {reverse:3, center_left:1470, center_right:1530, min_us:900, max_us:2100,
  amplitude_us:425, turn_comp:25, freq_min_dhz:17, freq_max_dhz:45,
  pitch_gain:-10, roll_gain:15, yaw_gain:25};

test('20-byte settings codec preserves field offsets, signed gains, CRC and DataView offsets', () => {
  const app = load(), p = protocol(app), packet = p.configPacket(edited), view = new DataView(packet);
  assert.equal(packet.byteLength,20);
  assert.deepEqual([...new Uint8Array(packet).slice(0,18)],
    [1,3,0xbe,5,0xfa,5,0x84,3,0x34,8,0xa9,1,17,45,246,15,25,25]);
  assert.equal(view.getUint16(18,true),app.crc16(new Uint8Array(packet),18));
  const framed = new Uint8Array(24); framed.set(new Uint8Array(packet),2);
  assert.deepEqual({...p.readConfig(new DataView(framed.buffer,2,20))},edited);
  assert.throws(()=>p.readConfig(new DataView(packet,0,19)),/length/);
  const corrupt = packet.slice(0); new Uint8Array(corrupt)[8]^=1;
  assert.throws(()=>p.readConfig(new DataView(corrupt)),/CRC/);
  const invalid = packet.slice(0), data = new DataView(invalid);
  data.setUint8(0,2); data.setUint16(18,app.crc16(new Uint8Array(invalid),18),true);
  assert.throws(()=>p.readConfig(data),/version/);
  data.setUint8(0,1); data.setUint8(1,4); data.setUint16(18,app.crc16(new Uint8Array(invalid),18),true);
  assert.throws(()=>p.readConfig(data),/reversal/);
});

test('SETUP sends STOP, pauses all joystick writes and reads actual settings without saving', async () => {
  const fixture=setup(), {app}=fixture;
  assert.equal(app.element('settingsButton').disabled,true);
  assert.equal(await app.connect(),true);
  Object.assign(app.state,{throttle:.9,pitch:.8});
  assert.equal(await app.element('settingsButton').listeners.get('click')(),true);
  assert.deepEqual(fixture.events,['control:0','control:2','read']);
  assert.equal(app.element('settingsDialog').open,true);
  assert.equal(app.state.throttle,0);
  assert.equal(fixture.saves,0);
  assert.equal(app.element('configMinFrequency').value,'2');
  assert.equal(app.element('configMaxFrequency').value,'5');
  assert.equal(app.element('configPitchGain').value,'100');
  assert.equal(app.element('settingsSave').disabled,false);
  app.state.throttle=.8; app.setTime(5000); app.requestControlUpdate(); await app.runTimers();
  assert.equal(await app.sendControl(false,false),false);
  assert.equal(fixture.packets.length,2);
  assert.equal(app.closeSettings(),true); await tick();
  assert.equal(app.element('settingsDialog').open,false);
  assert.equal(app.state.throttle,0);
  assert.equal(new DataView(fixture.packets.at(-1).buffer).getUint16(4,true),0);
});

test('form submit converts Hz and µs, saves once with response and verifies readback', async () => {
  const fixture=setup(), {app}=fixture;
  await app.connect(); await app.openSettings(); edit(app);
  let prevented=false;
  app.element('settingsForm').listeners.get('submit')({preventDefault(){prevented=true;}});
  await tick();
  assert.equal(prevented,true);
  assert.equal(fixture.saves,1); assert.equal(fixture.reads,2);
  assert.deepEqual({...protocol(app).readConfig(new DataView(fixture.stored))},edited);
  assert.match(app.element('settingsStatus').textContent,/Saved to flash and verified/);
});

test('invalid travel, frequency, gain steps and empty fields never write flash', async () => {
  const fixture=setup(), {app}=fixture;
  await app.connect(); await app.openSettings();
  for (const [id,value] of [['configCenterLeft','1000'],['configMinFrequency','6'],
    ['configPitchGain','7'],['configTurnComp','']]) {
    const input=app.element(id), before=input.value;
    input.value=value;
    assert.equal(await app.saveSettings(),false);
    assert.equal(fixture.saves,0);
    input.value=before;
  }
});

test('unsupported configuration does not break control and read errors cannot save defaults', async () => {
  const fixture=setup({missing:true}), {app}=fixture;
  assert.equal(await app.connect(),true);
  assert.equal(await app.openSettings(),false);
  assert.match(app.element('settingsStatus').textContent,/not supported/);
  assert.equal(app.element('settingsSave').disabled,true);
  assert.equal(await app.saveSettings(),false);
  assert.equal(app.closeSettings(),true);
  assert.equal(await app.sendControl(false,false),true);
});

test('corrupt settings disable SAVE until a subsequent valid read', async () => {
  const fixture=setup({read({stored,reads}) {
    const copy=stored.slice(0); if(reads===1) new Uint8Array(copy)[8]^=1;
    return new DataView(copy);
  }}), {app}=fixture;
  await app.connect(); assert.equal(await app.openSettings(),false);
  assert.match(app.element('settingsStatus').textContent,/CRC/);
  assert.equal(app.element('settingsSave').disabled,true);
  assert.equal(await app.readSettings(),true);
  assert.equal(app.element('settingsSave').disabled,false);
});

test('a stalled control write and queued STOP both finish before configuration discovery/read', async () => {
  let held=null;
  const fixture=setup({control:async()=>{if(held) {const wait=held;held=null;await wait.promise;}}}), {app}=fixture;
  await app.connect();
  const old=deferred(); held=old;
  const writing=app.sendControl(false,false);
  const opening=app.openSettings();
  assert.equal(fixture.reads,0);
  assert.equal(app.closeSettings(),false);
  assert.equal(app.element('settingsClose').disabled,true);
  old.resolve(); await writing;
  assert.equal(await opening,true);
  assert.deepEqual(fixture.events.slice(-3),['control:0','control:2','read']);
});

test('settings writes and following STOP remain serialized; concurrent saves do not duplicate flash writes', async () => {
  const held=deferred(), fixture=setup({save:()=>held.promise}), {app}=fixture;
  await app.connect(); await app.openSettings(); edit(app);
  const saving=app.saveSettings(); await tick();
  assert.equal(fixture.saves,1);
  assert.equal(await app.saveSettings(),false); assert.equal(await app.readSettings(),false);
  assert.equal(app.closeSettings(),false);
  const stopping=app.stop();
  assert.notEqual(fixture.events.at(-1),'control:2');
  held.resolve(); assert.equal(await saving,true); assert.equal(await stopping,true);
  assert.deepEqual(fixture.events.slice(-3),['save','read','control:2']);
});

test('an uncertain save requires readback and never retries a flash write automatically', async () => {
  const fixture=setup({read({stored,reads}) {
    if(reads===2) throw new Error('Readback interrupted');
    return new DataView(stored.slice(0));
  }}), {app}=fixture;
  await app.connect(); await app.openSettings(); edit(app);
  assert.equal(await app.saveSettings(),false);
  assert.equal(fixture.saves,1);
  assert.match(app.element('settingsStatus').textContent,/could not be confirmed/);
  assert.equal(app.element('settingsSave').disabled,true);
  assert.equal(await app.saveSettings(),false);
  assert.equal(await app.readSettings(),true);
  assert.equal(app.element('configCenterLeft').value,'1470');
  assert.equal(fixture.saves,1);
});

test('readback mismatch is not reported as a successful save', async () => {
  const fixture=setup({read({stored,reads}) {
    if(reads===2) return new DataView(protocol(fixture.app).configPacket(defaults));
    return new DataView(stored.slice(0));
  }}), {app}=fixture;
  await app.connect(); await app.openSettings(); edit(app);
  assert.equal(await app.saveSettings(),false);
  assert.match(app.element('settingsStatus').textContent,/different settings/);
  assert.equal(app.element('settingsSave').disabled,true);
});

test('a disconnected settings read cannot update a later connection or block its writes', async () => {
  const held=deferred(), fixture=setup({read({stored,reads}) {
    return reads===1?held.promise:new DataView(stored.slice(0));
  }}), {app}=fixture;
  await app.connect(); const old=app.openSettings(); await tick();
  assert.equal(fixture.reads,1);
  app.element('settingsDisconnect').listeners.get('click')();
  assert.equal(app.element('settingsDialog').open,false); assert.equal(app.ble.connected,false);
  assert.equal(await app.connect(),true);
  assert.equal(await app.openSettings(),true);
  const status=app.element('settingsStatus').textContent;
  held.resolve(new DataView(protocol(app).configPacket({...defaults,center_left:1400})));
  assert.equal(await old,false);
  assert.equal(app.element('configCenterLeft').value,'1500');
  assert.equal(app.element('settingsStatus').textContent,status);
});

test('configuration requires write-with-response and does not retry failed legacy writes', async () => {
  const fixture=setup(), {app}=fixture;
  await app.connect(); await app.openSettings();
  let modern=0;
  fixture.config.writeValue=async()=>{throw 'Native settings write rejected';};
  fixture.config.writeValueWithResponse=async()=>{modern++;};
  assert.equal(await app.saveSettings(),false);
  assert.match(app.element('settingsStatus').textContent,/Native settings write rejected/);
  assert.equal(modern,0);
  await app.readSettings();
  delete fixture.config.writeValue; delete fixture.config.writeValueWithResponse;
  fixture.config.writeValueWithoutResponse=async()=>{throw new Error('Must not use this API');};
  assert.equal(await app.saveSettings(),false);
  assert.match(app.element('settingsStatus').textContent,/writes with response/);
});

test('modern-only config writes and optional ARM mode work without telemetry gating', async () => {
  const fixture=setup({requireArm:true}), {app}=fixture;
  fixture.config.writeValueWithResponse=fixture.config.writeValue; delete fixture.config.writeValue;
  await app.connect(); await app.toggleArm();
  assert.equal(app.state.armed,true);
  assert.equal(await app.openSettings(),true);
  assert.equal(app.state.armed,false,'opening settings explicitly sends STOP');
  assert.equal(await app.toggleArm(),false);
  assert.equal(await app.saveSettings(),true);
  app.element('settingsDialog').listeners.get('cancel')({preventDefault(){}});
  assert.equal(app.element('settingsDialog').open,false);
  assert.equal(app.state.armed,false);
});

test('a canceled save never starts a readback on the old connection or alters a new panel', async () => {
  const held=deferred(), fixture=setup({save:()=>held.promise}), {app}=fixture;
  await app.connect(); await app.openSettings(); edit(app);
  const saving=app.saveSettings(); await tick();
  assert.equal(fixture.saves,1);
  let prevented=false;
  app.element('settingsDialog').listeners.get('cancel')({preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  assert.equal(app.element('settingsDialog').open,true,'Escape must not silently resume control during a save');
  app.element('settingsDisconnect').listeners.get('click')();
  await app.connect(); await app.openSettings();
  const status=app.element('settingsStatus').textContent;
  held.resolve(); assert.equal(await saving,false);
  assert.equal(fixture.reads,2,'canceled writes must not start another GATT read');
  assert.equal(app.element('configCenterLeft').value,'1500');
  assert.equal(app.element('settingsStatus').textContent,status);
});

test('settings can open and close on browsers without native dialog methods', async () => {
  const fixture=setup(), {app}=fixture, dialog=app.element('settingsDialog');
  delete dialog.showModal; delete dialog.close;
  await app.connect(); assert.equal(await app.openSettings(),true);
  assert.equal(dialog.open,true);
  assert.equal(await app.sendControl(false,false),false);
  assert.equal(app.closeSettings(),true);
  assert.equal(dialog.open,false);
});
