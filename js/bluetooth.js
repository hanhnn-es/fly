(function(global) {
'use strict';
function errorMessage(error) {
  var fallback = 'Unknown Bluetooth error (no details returned)';
  if (error === null || error === undefined || error === '')
    return fallback;
  if (typeof error === 'string')
    return error;
  var fields = ['message', 'description', 'error', 'reason'];
  for (var i = 0; i < fields.length; i++) {
    if (typeof error[fields[i]] === 'string' && error[fields[i]])
      return error[fields[i]]
  }
  try {
    var details = JSON.stringify(error);
    if (details && details !== '{}')
      return details
  } catch (ignored) {
  }
  return typeof error.name === 'string' && error.name ? error.name : fallback
}
async function writeControl(control, packet, withResponse) {
  if (!withResponse && typeof control.writeValueWithoutResponse === 'function' &&
      (control.properties || {}).writeWithoutResponse) {
    await control.writeValueWithoutResponse(packet)
  } else if (typeof control.writeValue === 'function') {
    // Bluefy bridges may only implement the legacy write API.
    await control.writeValue(packet)
  } else if (
      typeof control.writeValueWithResponse === 'function' &&
      (control.properties || {}).write !== false) {
    await control.writeValueWithResponse(packet)
  } else if (
      typeof control.writeValueWithoutResponse === 'function' &&
      (control.properties || {}).writeWithoutResponse) {
    await control.writeValueWithoutResponse(packet)
  } else {
    throw new Error('The control characteristic is not writable.')
  }
}
async function writeConfig(characteristic, packet) {
  if (typeof characteristic.writeValue === 'function') {
    await characteristic.writeValue(packet);
  } else if (typeof characteristic.writeValueWithResponse === 'function') {
    await characteristic.writeValueWithResponse(packet);
  } else {
    throw new Error('The settings characteristic needs writes with response.');
  }
}
// Control writes and settings operations share one GATT transport per session.
function serializeGatt(ble, session, operation) {
  function start() {
    if (session !== ble.session || !ble.connected)
      throw new Error('The Bluetooth connection has changed.');
    return operation();
  }
  var result;
  if (ble.gattOperation) {
    result = ble.gattOperation.then(start, start);
  } else {
    try {
      result = Promise.resolve(start());
    } catch (error) {
      result = Promise.reject(error);
    }
  }
  ble.gattOperation = result;
  function clear() {
    if (session === ble.session && ble.gattOperation === result)
      ble.gattOperation = null;
  }
  result.then(clear, clear);
  return result;
}

global.FlightBluetooth = Object.freeze({
  errorMessage: errorMessage,
  writeControl: writeControl,
  writeConfig: writeConfig,
  serializeGatt: serializeGatt
});
})(window);
