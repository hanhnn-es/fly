import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\s[^>]*src="([^" ]+)"[^>]*><\/script>/g)]
  .map(match => new URL('../' + match[1], import.meta.url));
assert.ok(scripts.length > 0, 'Controller scripts must exist');
assert.ok(scripts.some(script => script.pathname.endsWith('/app.js')), 'HTML must load the controller entry point');
assert.equal(new Set(scripts.map(script => script.href)).size, scripts.length, 'Page scripts must not repeat');
const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const elementIds = new Set(htmlIds);
assert.equal(elementIds.size, htmlIds.length, 'HTML IDs must be unique');
for (const [, asset] of html.matchAll(/(?:src|href)="(\.\/[^" ]+)"/g)) {
  assert.ok(fs.existsSync(new URL('../' + asset, import.meta.url)), 'Missing page asset: ' + asset);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

const tick = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

function node(id) {
  const classes = new Set();
  return {
    id, textContent: id === 'rtt' ? '-- ms' : id === 'txRate' ? '0 Hz' : '',
    disabled: false, value: '', checked: false, open: false,
    style: {}, clientWidth: 200, clientHeight: 240,
    children: [], listeners: new Map(), classList: {toggle(name, enabled) {
      enabled ? classes.add(name) : classes.delete(name);
    }},
    addEventListener(type, fn) { this.listeners.set(type, fn); },
    removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); },
    setAttribute(name, value) { this[name] = name === 'open' ? true : value; },
    removeAttribute(name) { if (name === 'open') this.open = false; else delete this[name]; },
    showModal() { this.open = true; },
    close() { this.open = false; },
    appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentElement = null; },
    contains(child) { return this.children.includes(child); },
    getBoundingClientRect() {
      const parent = this.parentElement?.getBoundingClientRect() || {left: 0, top: 0, width: 200, height: 200};
      const offset = (value, span) => String(value).endsWith('%') ? parseFloat(value) * span / 100 : parseFloat(value) || 0;
      const left = parent.left + offset(this.style.left, parent.width);
      const top = parent.top + offset(this.style.top, parent.height);
      return {left, top, width: this.clientWidth, height: this.clientHeight,
        right: left + this.clientWidth, bottom: top + this.clientHeight};
    }
  };
}

function load(config = {}, {realNipple = false, touch = false} = {}) {
  const elements = new Map(), managers = [], intervals = [], frames = new Map(), timers = new Map();
  let timerId = 0;
  let now = 100, frameId = 0;
  const element = id => {
    if (!elementIds.has(id)) return null;
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
    listeners: new Map(),
    addEventListener(type, fn) { this.listeners.set(type, fn); },
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
    document: Object.assign(node('document'), {getElementById: element, body: node('body'), documentElement: node('html'), hidden: false}),
    navigator: {bluetooth: {}}, performance: {now: () => now},
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (fn, ms) => { timers.set(++timerId, {fn, at: now + ms}); return timerId; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { intervals.push({fn, ms}); return intervals.length; },
    console
  };
  vm.createContext(context);
  if (realNipple) {
    Object.assign(window, {scrollX: 0, scrollY: 0, setTimeout: context.setTimeout,
      setInterval: context.setInterval, removeEventListener() {}});
    context.clearInterval = () => {};
    context.document.createElement = () => node('div');
    context.getComputedStyle = () => ({position: 'absolute', display: 'block'});
    if (touch) window.ontouchstart = null;
    else window.PointerEvent = function() {};
  }
  let controller;
  for (const script of scripts) {
    if (script.pathname.endsWith('/nipplejs.min.js') && !realNipple) continue;
    if (script.pathname.endsWith('/app.js')) {
      // Capture the instance while executing the real entry point in HTML order.
      const factory = window.FlightController;
      assert.ok(factory, 'Controller must load before its entry point');
      window.FlightController = {create: options => { controller = factory.create(options); }};
      try {
        vm.runInContext(fs.readFileSync(script, 'utf8'), context, {filename: script.pathname});
      } finally {
        window.FlightController = factory;
      }
    } else {
      vm.runInContext(fs.readFileSync(script, 'utf8'), context, {filename: script.pathname});
      if (script.pathname.endsWith('/nipplejs.min.js')) {
        window.nipplejs = context.nipplejs;
        const create = context.nipplejs.create;
        window.nipplejs.create = options => {
          const manager = create(options); managers.push(manager); return manager;
        };
      }
    }
  }
  assert.ok(controller, 'Page entry point must initialize the controller');
  return {...controller, context, element, managers, intervals,
    setTime: time => { now = time; },
    async runTimers() {
      for (const [id, timer] of [...timers]) {
        if (timers.has(id) && timer.at <= now) { timers.delete(id); timer.fn(); }
      }
      await tick();
    },
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

export {load, deferred, tick, node, characteristic, attach, telemetry, device};
