(function(global) {
'use strict';

var VERSION = 1;
var CONTROL_SIZE = 14;
var TELEMETRY_SIZE = 8;
var CONFIG_SIZE = 20;
var CONFIG_FIELDS = [
  ['reverse', 1, 'Uint8'], ['center_left', 2, 'Uint16'], ['center_right', 4, 'Uint16'],
  ['min_us', 6, 'Uint16'], ['max_us', 8, 'Uint16'], ['amplitude_us', 10, 'Uint16'],
  ['freq_min_dhz', 12, 'Uint8'], ['freq_max_dhz', 13, 'Uint8'], ['pitch_gain', 14, 'Int8'],
  ['roll_gain', 15, 'Int8'], ['yaw_gain', 16, 'Int8'], ['turn_comp', 17, 'Uint8']
];

function clamp(value, min, max) {
  value = Number(value);
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : 0));
}

function crc16(bytes, length) {
  var crc = 0xffff;
  for (var i = 0; i < length; i++) {
    crc ^= bytes[i] << 8;
    for (var bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function controlPacket(sequence, requireArm, emergency, values, calibrate) {
  var buffer = new ArrayBuffer(CONTROL_SIZE);
  var view = new DataView(buffer);
  var stopped = emergency || calibrate;
  view.setUint8(0, VERSION);
  view.setUint8(1, calibrate ? 4 : emergency ? 2 : requireArm && values.armed ? 1 : 0);
  view.setUint16(2, sequence, true);
  view.setUint16(4, stopped ? 0 : Math.round(clamp(values.throttle, 0, 1) * 1000), true);
  view.setInt16(6, stopped ? 0 : Math.round(clamp(values.yaw, -1, 1) * 1000), true);
  view.setInt16(8, stopped ? 0 : Math.round(clamp(values.pitch, -1, 1) * 1000), true);
  view.setInt16(10, stopped ? 0 : Math.round(clamp(values.roll, -1, 1) * 1000), true);
  view.setUint16(12, crc16(new Uint8Array(buffer), 12), true);
  return buffer;
}

function readTelemetry(view) {
  if (!view || view.byteLength !== TELEMETRY_SIZE)
    return null;
  var bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  if (view.getUint8(0) !== VERSION || view.getUint16(6, true) !== crc16(bytes, 6))
    return null;
  var flags = view.getUint8(1);
  if (flags & ~15)
    return null;
  return {flags: flags, sequence: view.getUint16(2, true)};
}

function validateConfig(config) {
  function integer(key, label, min, max, scale) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) {
      var step = scale || 1;
      var low = Number((min * step).toFixed(2)), high = Number((max * step).toFixed(2));
      throw new Error(
          label + ' must be between ' + low + ' and ' + high + ' in steps of ' + step + '.');
    }
  }
  integer('reverse', 'Servo reversal flags', 0, 3);
  integer('min_us', 'Minimum pulse (µs)', 600, 1450);
  integer('max_us', 'Maximum pulse (µs)', 1550, 2400);
  integer('center_left', 'Left center (µs)', config.min_us + 50, config.max_us - 50);
  integer('center_right', 'Right center (µs)', config.min_us + 50, config.max_us - 50);
  integer('amplitude_us', 'Flap amplitude (µs)', 10, 900);
  integer('freq_min_dhz', 'Minimum frequency (Hz)', 5, 100, 0.1);
  integer('freq_max_dhz', 'Maximum frequency (Hz)', config.freq_min_dhz, 100, 0.1);
  integer('pitch_gain', 'Pitch gain (µs)', -100, 100, 5);
  integer('roll_gain', 'Roll gain (µs)', -100, 100, 5);
  integer('yaw_gain', 'Yaw gain (µs)', -100, 100, 5);
  integer('turn_comp', 'Turn compensation (%)', 0, 100);
}

function configPacket(config) {
  validateConfig(config);
  var buffer = new ArrayBuffer(CONFIG_SIZE), view = new DataView(buffer);
  view.setUint8(0, VERSION);
  CONFIG_FIELDS.forEach(function(field) {
    view['set' + field[2]](field[1], config[field[0]], true);
  });
  view.setUint16(18, crc16(new Uint8Array(buffer), 18), true);
  return buffer;
}

function readConfig(view) {
  if (!view || view.byteLength !== CONFIG_SIZE)
    throw new Error('The drone returned an invalid settings packet length.');
  var bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  if (view.getUint8(0) !== VERSION || view.getUint16(18, true) !== crc16(bytes, 18))
    throw new Error('The drone returned settings with an invalid version or CRC.');
  var config = {};
  CONFIG_FIELDS.forEach(function(field) {
    config[field[0]] = view['get' + field[2]](field[1], true);
  });
  validateConfig(config);
  return config;
}

global.FlightProtocol = Object.freeze({
  clamp: clamp,
  crc16: crc16,
  controlPacket: controlPacket,
  readTelemetry: readTelemetry,
  configPacket: configPacket,
  readConfig: readConfig
});
})(window);
