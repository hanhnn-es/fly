/* Run the shipped NippleJS, including its DOM event adapters, in the host DOM.
 * This checks library integration and input math; it does not replace browser
 * layout, OS Bluetooth or hardware testing. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {load, attach, characteristic, tick} from './helpers.mjs';

test('shipped NippleJS maps pointer input, releases axes and holds throttle', async () => {
  const app = load({}, {realNipple: true}), packets = [];
  attach(app, characteristic(async packet => packets.push(new DataView(packet))));
  const left = app.managers[0].getJoystickByUid(), right = app.managers[1].getJoystickByUid();
  function pointer(zone, type, x, y, pointerId) {
    const joystick = zone === 'leftStick' ? left : right;
    const event = {type, pointerId, buttons: type === 'pointerup' ? 0 : 1,
      pageX: joystick.position.x + x * joystick.options.size / 2,
      pageY: joystick.position.y - y * joystick.options.size / 2, preventDefault() {}};
    const target = type === 'pointerdown' ? app.element(zone) : app.context.document;
    const handler = target.listeners.get(type);
    assert.ok(handler, 'NippleJS must install the actual pointer handler');
    handler(event);
  }
  pointer('leftStick', 'pointerdown', 0, -1, 1);
  await tick();
  assert.equal(Math.round(app.state.throttle * 1000), 0);
  pointer('leftStick', 'pointermove', .25, .6, 1);
  pointer('rightStick', 'pointerdown', -.7, .4, 2);
  await app.sendControl(false, false);
  const sent = packets.at(-1);
  assert.equal(sent.getUint16(4, true), 800);
  assert.equal(sent.getInt16(6, true), 250);
  assert.equal(sent.getInt16(8, true), 400);
  assert.equal(sent.getInt16(10, true), -700);
  pointer('leftStick', 'pointerup', .25, .6, 1);
  pointer('rightStick', 'pointerup', -.7, .4, 2);
  await app.sendControl(false, false);
  assert.equal(packets.at(-1).getUint16(4, true), 800);
  assert.deepEqual([app.state.yaw, app.state.pitch, app.state.roll], [0, 0, 0]);
  assert.equal(left.frontPosition.x, 0);
  assert.equal(right.frontPosition.x, 0); assert.equal(right.frontPosition.y, 0);
});

test('shipped NippleJS supports two touch identifiers at the same time', async () => {
  const app = load({}, {realNipple: true, touch: true});
  const active = new Map();
  function touch(zone, type, x, y, id) {
    const stick = app.managers[zone === 'leftStick' ? 0 : 1].getJoystickByUid();
    const point = {identifier: id,
      pageX: stick.position.x + x * stick.options.size / 2,
      pageY: stick.position.y - y * stick.options.size / 2};
    if (type === 'touchend') active.delete(id); else active.set(id, point);
    const target = type === 'touchstart' ? app.element(zone) : app.context.document;
    target.listeners.get(type)({type, changedTouches: [point], touches: [...active.values()], preventDefault() {}});
  }
  touch('leftStick', 'touchstart', 0, -1, 7);
  touch('rightStick', 'touchstart', .5, -.5, 8);
  touch('leftStick', 'touchmove', -.4, .4, 7);
  const packet = new DataView(app.makePacket(false));
  assert.equal(packet.getUint16(4, true), 700);
  assert.equal(packet.getInt16(6, true), -400);
  assert.equal(packet.getInt16(8, true), -500);
  assert.equal(packet.getInt16(10, true), 500);
  touch('rightStick', 'touchend', .5, -.5, 8);
  assert.deepEqual([app.state.roll, app.state.pitch], [0, 0]);
  assert.equal(Math.round(app.state.throttle * 1000), 700);
  touch('leftStick', 'touchend', -.4, .4, 7);
  assert.equal(app.state.yaw, 0);
  assert.equal(Math.round(app.state.throttle * 1000), 700);
});
