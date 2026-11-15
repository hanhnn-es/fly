'use strict';
// Defaults for the ESP32 Betaflight firmware.  Keep overrides available so the
// same UI can still be used with a target that exposes the optional settings
// characteristic.
window.FlightController.create(Object.assign({
  requireArm: true,
  configUuid: null
}, window.FLIGHT_CONTROL_CONFIG || {}));
