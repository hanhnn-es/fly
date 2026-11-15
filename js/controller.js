(function(global) {
'use strict';
function create(overrides) {
  var protocol = window.FlightProtocol;
  var crc16 = protocol.crc16;
  var errorMessage = window.FlightBluetooth.errorMessage;
  var CONFIG = Object.freeze(Object.assign(
      {
        appName: 'FLIGHT CONTROL',
        targetLabel: 'ESP32-DRONE',
        fallbackDeviceName: 'ESP32-DRONE',
        serviceUuid: 'd4f20001-8f69-4b7f-9f5a-6c253728d1a0',
        controlUuid: 'd4f20002-8f69-4b7f-9f5a-6c253728d1a0',
        telemetryUuid: 'd4f20003-8f69-4b7f-9f5a-6c253728d1a0',
        configUuid: 'd4f20004-8f69-4b7f-9f5a-6c253728d1a0',
        txIntervalMs: 20,
        requireArm: false
      },
      overrides || {}));
  var SERVICE_UUID = CONFIG.serviceUuid;
  var CONTROL_UUID = CONFIG.controlUuid;
  var TELEMETRY_UUID = CONFIG.telemetryUuid;
  var SUPPORTS_SETTINGS = typeof CONFIG.configUuid === 'string' && CONFIG.configUuid.length > 0;
  var configuredInterval = Number(CONFIG.txIntervalMs);
  var TX_INTERVAL_MS = Number.isFinite(configuredInterval) && configuredInterval > 0 ?
      Math.max(10, configuredInterval) :
      20;
  var TELEMETRY_TIMEOUT_MS = 2000;
  var METRICS_INTERVAL_MS = 1200;
  var state = {throttle: 0, yaw: 0, pitch: 0, roll: 0, armed: false, seq: 0};
  var ble = {
    session: 0,
    device: null,
    control: null,
    telemetry: null,
    service: null,
    config: null,
    gattOperation: null,
    connected: false,
    connecting: false,
    busy: false,
    pending: null,
    active: null,
    lastError: '',
    disconnectHandler: null,
    telemetryHandler: null
  };
  var sent = 0, lastTelemetryAt = null, reportedFlags = null, pendingTimes = new Map();
  var metricsStartedAt = performance.now(), rttSum = 0, rttSamples = 0;
  var nextControlTimer = null, lastControlQueuedAt = 0;
  var renderFrame = null;
  var settingsOpen = false, settingsBusy = false;
  var calibrating = false, calibrationAcknowledged = false;
  var ui = {};
  ['brandName', 'message', 'leftValue', 'rightValue', 'flightState', 'armButton', 'connectButton',
   'stopButton', 'calibrationButton', 'linkState', 'linkText', 'fullscreenButton', 'leftStick', 'rightStick',
   'commandPanel', 'txRate', 'rtt', 'settingsButton']
      .forEach(function(id) {
        ui[id] = document.getElementById(id)
      });
  var targetName = String(CONFIG.targetLabel || 'controller');
  document.title = String(CONFIG.appName || 'FLIGHT CONTROL');
  ui.brandName.textContent = document.title;
  ui.message.textContent = 'Press CONNECT BLE to select a ' + targetName;
  function signed(value) {
    var n = Math.round(value * 100);
    return (n >= 0 ? '+' : '−') + String(Math.abs(n)).padStart(3, '0')
  }
  function setText(node, text) {
    if (node.textContent !== text)
      node.textContent = text
  }
  function message(text) {
    setText(ui.message, text);
    ui.message.title = text
  }
  function renderControls() {
    ui.armButton.hidden = !CONFIG.requireArm;
    ui.armButton.disabled = !CONFIG.requireArm || !ble.connected || ble.connecting || settingsOpen;
    ui.calibrationButton.disabled = !ble.connected || ble.connecting || settingsOpen || calibrating;
    setText(ui.calibrationButton, calibrating ? 'CALIBRATING' : 'CALIB');
    ui.settingsButton.hidden = !SUPPORTS_SETTINGS;
    ui.settingsButton.disabled = !SUPPORTS_SETTINGS || !ble.connected || ble.connecting || settingsOpen;
    ui.connectButton.disabled = ble.connecting;
    setText(
        ui.connectButton,
        ble.connecting    ? 'CONNECTING' :
            ble.connected ? 'DISCONNECT' :
                            'CONNECT BLE');
    setText(ui.armButton, state.armed ? 'ARM ON' : 'ARM OFF');
    ui.armButton.title = state.armed ? 'Click to send ARM OFF' : 'Click to send ARM ON'
  }
  function renderValues() {
    setText(
        ui.leftValue,
        'T ' + String(Math.round(state.throttle * 100)).padStart(3, '0') + ' · Y ' +
            signed(state.yaw));
    setText(ui.rightValue, 'R ' + signed(state.roll) + ' · P ' + signed(state.pitch))
  }
  function flightStatus() {
    if (reportedFlags === null)
      return ble.connected ? 'UNKNOWN' : 'SAFE';
    if (reportedFlags & 8)
      return 'CALIBRATING';
    if (reportedFlags & 2)
      return 'FAILSAFE';
    if (reportedFlags & 4)
      return 'REJECTED';
    if (reportedFlags & 1)
      return CONFIG.requireArm ? 'ARMED' : 'READY';
    return 'SAFE';
  }
  function render() {
    renderValues();
    var flightText = flightStatus();
    setText(ui.flightState, flightText);
    document.body.classList.toggle('armed', Boolean(reportedFlags & 1));
    document.body.classList.toggle('arm-on', Boolean(CONFIG.requireArm && state.armed));
    document.body.classList.toggle('require-arm', Boolean(CONFIG.requireArm));
    renderControls()
  }
  function scheduleRender() {
    if (renderFrame !== null)
      return;
    renderFrame = requestAnimationFrame(function() {
      renderFrame = null;
      renderValues()
    })
  }
  function setConnection(online, text) {
    ble.connected = online;
    ui.linkState.classList.toggle('online', online);
    setText(ui.linkText, text);
    ui.linkText.title = text;
    renderControls()
  }
  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement
  }
  function renderFullscreen() {
    var active = Boolean(fullscreenElement()), button = ui.fullscreenButton;
    setText(button, active ? 'EXIT' : 'FULL');
    button.title = active ? 'Exit fullscreen' : 'Enter fullscreen'
  }
  async function toggleFullscreen() {
    var target = document.documentElement, active = fullscreenElement();
    try {
      if (!active) {
        var enter = target.requestFullscreen || target.webkitRequestFullscreen;
        if (!enter) {
          message('Fullscreen is not supported by this browser.');
          return
        }
        await enter.call(target)
      } else {
        var exitFullscreen = document.exitFullscreen || document.webkitExitFullscreen;
        if (exitFullscreen)
          await exitFullscreen.call(document)
      }
    } catch (error) {
      message('Unable to change fullscreen mode: ' + errorMessage(error))
    }
  }
  if (!window.nipplejs || typeof window.nipplejs.create !== 'function') {
    setConnection(false, 'UI ERROR');
    message('NippleJS could not be loaded. Reload the page.');
    return
  }
  var joysticks = window.FlightJoysticks.create(ui, state, function() {
    scheduleRender();
    requestControlUpdate()
  });
  var settings = window.FlightSettings.create(
      {read: readSettings, save: saveSettings, close: closeSettings, disconnect: disconnect});

  function makePacket(emergency, values, calibrate) {
    state.seq = (state.seq + 1) & 0xffff;
    return protocol.controlPacket(state.seq, CONFIG.requireArm, emergency, values || state, calibrate)
  }

  function sendControl(emergency, withResponse, calibrate) {
    if (!ble.connected || !ble.control)
      return Promise.resolve(false);
    if (settingsOpen && !emergency)
      return Promise.resolve(false);
    // Keep the latest input while a write is in flight. A queued STOP wins.
    if (ble.pending && (ble.pending.emergency || ble.pending.calibrate) && !emergency && !calibrate)
      return Promise.resolve(false);
    settleJob(ble.pending, false);
    return new Promise(function(resolve) {
      ble.pending = {
        session: ble.session,
        values: Object.assign({}, state),
        emergency: Boolean(emergency),
        calibrate: Boolean(calibrate),
        withResponse: Boolean(withResponse),
        resolve: resolve
      };
      flushControlQueue()
    })
  }

  function settleJob(job, success) {
    if (job && job.resolve) {
      job.resolve(success);
      job.resolve = null
    }
  }

  function currentSession(session) {
    return session === ble.session
  }

  function requestControlUpdate() {
    if (!ble.connected || !ble.control || ble.connecting || document.hidden || settingsOpen || calibrating)
      return;
    var now = performance.now(), delay = Math.max(0, TX_INTERVAL_MS - (now - lastControlQueuedAt));
    if (delay === 0) {
      lastControlQueuedAt = now;
      sendControl(false, false);
      return
    }
    if (nextControlTimer === null)
      nextControlTimer = setTimeout(function() {
        nextControlTimer = null;
        requestControlUpdate()
      }, delay)
  }

  async function flushControlQueue() {
    if (ble.busy || !ble.pending || !ble.connected || !ble.control)
      return;
    var job = ble.pending, session = job.session, control = ble.control;
    ble.pending = null;
    ble.active = job;
    ble.busy = true;
    var packet = makePacket(job.emergency, job.values, job.calibrate), seq = state.seq, success = false;
    pendingTimes.set(seq, performance.now());
    try {
      await window.FlightBluetooth.serializeGatt(ble, session, function() {
        return window.FlightBluetooth.writeControl(control, packet, job.withResponse);
      });
      if (currentSession(session) && ble.active === job) {
        sent++;
        success = true
      }
    } catch (error) {
      if (currentSession(session) && ble.active === job) {
        pendingTimes.delete(seq);
        ble.lastError = errorMessage(error);
        message('BLE send failed: ' + ble.lastError)
      }
    } finally {
      settleJob(job, success);
      // A completion from an old connection must never unlock a new one.
      if (currentSession(session) && ble.active === job) {
        ble.active = null;
        ble.busy = false;
        if (ble.pending)
          flushControlQueue()
      }
    }
  }

  function resetTelemetry() {
    sent = 0;
    metricsStartedAt = performance.now();
    rttSum = 0;
    rttSamples = 0;
    lastTelemetryAt = null;
    reportedFlags = null;
    pendingTimes.clear();
    setText(ui.txRate, '0 Hz');
    setText(ui.rtt, '-- ms')
  }

  function updateMetrics() {
    var now = performance.now(), elapsed = now - metricsStartedAt;
    pendingTimes.forEach(function(started, seq) {
      if (now - started >= TELEMETRY_TIMEOUT_MS)
        pendingTimes.delete(seq)
    });
    if (lastTelemetryAt !== null && now - lastTelemetryAt >= TELEMETRY_TIMEOUT_MS) {
      lastTelemetryAt = null;
      reportedFlags = null;
      render()
    }
    if (elapsed < METRICS_INTERVAL_MS)
      return;
    // Use real elapsed time: a delayed timer must not inflate the TX rate.
    setText(ui.txRate, Math.round(sent * 1000 / elapsed) + ' Hz');
    setText(
        ui.rtt,
        rttSamples && lastTelemetryAt !== null ? Math.round(rttSum / rttSamples) + ' ms' : '-- ms');
    sent = 0;
    rttSum = 0;
    rttSamples = 0;
    metricsStartedAt = now
  }

  function onTelemetry(event) {
    var telemetry = protocol.readTelemetry(event.target.value);
    if (!telemetry)
      return;
    var flags = telemetry.flags, seq = telemetry.sequence, started = pendingTimes.get(seq);
    var now = performance.now();
    lastTelemetryAt = now;
    reportedFlags = flags;
    if (flags & 8) {
      calibrating = true;
      calibrationAcknowledged = true;
      message('Calibrating IMU — keep the drone level and completely still.');
    } else if (calibrating && calibrationAcknowledged) {
      calibrating = false;
      calibrationAcknowledged = false;
      message('IMU calibration complete. Controls remain disarmed.');
      requestControlUpdate()
    }
    if (started !== undefined) {
      var rtt = Math.max(0, now - started);
      if (rtt < TELEMETRY_TIMEOUT_MS) {
        rttSum += rtt;
        rttSamples++
      }
      pendingTimes.delete(seq)
    }
    render()
  }

  function resetControls() {
    state.throttle = 0;
    state.yaw = 0;
    state.pitch = 0;
    state.roll = 0;
    state.armed = false;
    joysticks.reset()
  }

  async function configCharacteristic(session) {
    if (!SUPPORTS_SETTINGS)
      throw new Error('Settings are not exposed by this flight controller.');
    if (ble.config)
      return ble.config;
    if (!ble.service)
      throw new Error('Connect to a drone before reading settings.');
    var characteristic = await ble.service.getCharacteristic(CONFIG.configUuid);
    if (!currentSession(session))
      throw new Error('The Bluetooth connection has changed.');
    if (!characteristic || typeof characteristic.readValue !== 'function')
      throw new Error('This drone does not expose readable settings.');
    ble.config = characteristic;
    return characteristic;
  }

  async function openSettings() {
    if (!SUPPORTS_SETTINGS) {
      message('This flight controller does not expose the optional settings service.');
      return false
    }
    if (!ble.connected || ble.connecting || settingsOpen)
      return false;
    settingsOpen = true;
    if (nextControlTimer !== null)
      clearTimeout(nextControlTimer);
    nextControlTimer = null;
    settings.show();
    render();
    return readSettings();
  }

  async function readSettings() {
    if (!settingsOpen || settingsBusy || !ble.connected)
      return false;
    var session = ble.session;
    settingsBusy = true;
    settings.invalidate();
    settings.setBusy(true);
    settings.status('Stopping control and reading settings…');
    resetControls();
    render();
    try {
      if (!await sendControl(true, true))
        throw new Error(ble.lastError || 'The STOP command could not be sent.');
      var config = await window.FlightBluetooth.serializeGatt(ble, session, async function() {
        var characteristic = await configCharacteristic(session);
        return protocol.readConfig(await characteristic.readValue());
      });
      if (!currentSession(session) || !settingsOpen)
        return false;
      settings.fill(config);
      settings.status('Settings loaded from the drone. Control is paused.');
      message('Settings open — joystick control paused.');
      return true;
    } catch (error) {
      if (currentSession(session) && settingsOpen)
        settings.status('Read failed: ' + errorMessage(error), true);
      return false;
    } finally {
      if (currentSession(session) && settingsOpen) {
        settingsBusy = false;
        settings.setBusy(false);
      }
    }
  }

  async function saveSettings() {
    if (!settingsOpen || settingsBusy || !ble.connected || !settings.ready())
      return false;
    var packet;
    try {
      packet = protocol.configPacket(settings.values());
    } catch (error) {
      settings.status(errorMessage(error), true);
      return false;
    }
    var session = ble.session;
    settingsBusy = true;
    settings.setBusy(true);
    settings.status('Saving to flash and reading back…');
    try {
      var config = await window.FlightBluetooth.serializeGatt(ble, session, async function() {
        var characteristic = await configCharacteristic(session);
        await window.FlightBluetooth.writeConfig(characteristic, packet);
        if (!currentSession(session) || !settingsOpen)
          throw new Error('The Bluetooth connection has changed.');
        var actual = protocol.readConfig(await characteristic.readValue());
        var expectedBytes = new Uint8Array(packet);
        var actualBytes = new Uint8Array(protocol.configPacket(actual));
        if (!expectedBytes.every(function(byte, i) {
              return byte === actualBytes[i];
            }))
          throw new Error('The drone returned different settings.');
        return actual;
      });
      if (!currentSession(session) || !settingsOpen)
        return false;
      settings.fill(config);
      settings.status('Saved to flash and verified by reading back from the drone.');
      return true;
    } catch (error) {
      if (currentSession(session) && settingsOpen) {
        settings.invalidate();
        settings.status(
            'Save could not be confirmed: ' + errorMessage(error) +
                ' Read from drone to check before saving again.',
            true);
      }
      return false;
    } finally {
      if (currentSession(session) && settingsOpen) {
        settingsBusy = false;
        settings.setBusy(false);
      }
    }
  }

  function closeSettings() {
    if (!settingsOpen || settingsBusy)
      return false;
    settingsOpen = false;
    settings.hide();
    resetControls();
    render();
    message('Settings closed — controls reset.');
    requestControlUpdate();
    return true;
  }

  function clearConnection(status, text) {
    ble.session++;
    if (ble.device && ble.disconnectHandler)
      ble.device.removeEventListener('gattserverdisconnected', ble.disconnectHandler);
    if (ble.telemetry && ble.telemetryHandler)
      ble.telemetry.removeEventListener('characteristicvaluechanged', ble.telemetryHandler);
    settleJob(ble.pending, false);
    settleJob(ble.active, false);
    if (nextControlTimer !== null)
      clearTimeout(nextControlTimer);
    nextControlTimer = null;
    lastControlQueuedAt = 0;
    ble.device = null;
    ble.control = null;
    ble.telemetry = null;
    ble.service = null;
    ble.config = null;
    ble.gattOperation = null;
    ble.connecting = false;
    ble.busy = false;
    ble.pending = null;
    ble.active = null;
    ble.disconnectHandler = null;
    ble.telemetryHandler = null;
    calibrating = calibrationAcknowledged = false;
    settingsOpen = settingsBusy = false;
    settings.hide();
    resetControls();
    resetTelemetry();
    setConnection(false, status);
    render();
    message(text)
  }

  function onDisconnected(event) {
    if (event && event.target !== ble.device)
      return;
    clearConnection('LINK LOST', 'Bluetooth disconnected — controls reset.')
  }

  async function connect() {
    if (ble.connecting)
      return false;
    if (window.isSecureContext === false) {
      message(
          'Web Bluetooth requires HTTPS or http://localhost:8000 on the computer serving fly. HTTP over a LAN IP is not supported.');
      return false
    }
    if (!navigator.bluetooth || typeof navigator.bluetooth.requestDevice !== 'function') {
      var platform = (navigator.userAgentData && navigator.userAgentData.platform) ||
          navigator.userAgent || navigator.platform || '';
      message(
          /Linux/i.test(platform) && !/Android/i.test(platform) ?
              'Chrome on Linux: enable chrome://flags/#enable-experimental-web-platform-features, click Relaunch, then reopen fly on localhost or HTTPS.' :
              'Web Bluetooth is unavailable. Use a browser with Web Bluetooth enabled, such as Chrome on Android or Bluefy on iOS.');
      return false
    }
    if (ble.connected) {
      disconnect();
      return true
    }
    var session = ++ble.session, device = null, stage = 'device selection';
    ble.connecting = true;
    ble.lastError = '';
    function checkSession() {
      if (!currentSession(session))
        throw new Error('The connection attempt has expired.')
    }
    try {
      // Open the native chooser in the click handler before changing its button.
      var selection = navigator.bluetooth.requestDevice({filters: [{services: [SERVICE_UUID]}]});
      resetControls();
      resetTelemetry();
      setConnection(false, 'SELECT DEVICE');
      message('Select a compatible ' + targetName + ' in the Bluetooth device picker…');
      device = await selection;
      checkSession();
      ble.device = device;
      ble.disconnectHandler = function(event) {
        if (currentSession(session))
          onDisconnected(event)
      };
      device.addEventListener('gattserverdisconnected', ble.disconnectHandler);
      setConnection(false, 'CONNECTING');
      stage = 'GATT connect';
      var server = await device.gatt.connect();
      checkSession();
      stage = 'service discovery';
      var service = await server.getPrimaryService(SERVICE_UUID);
      checkSession();
      ble.service = service;
      stage = 'control characteristic';
      var control = await service.getCharacteristic(CONTROL_UUID);
      checkSession();
      stage = 'telemetry characteristic';
      var telemetry = await service.getCharacteristic(TELEMETRY_UUID);
      checkSession();
      ble.control = control;
      ble.telemetry = telemetry;
      // Some BLE bridges require notifications to start before adding the listener.
      stage = 'notifications';
      await telemetry.startNotifications();
      checkSession();
      stage = 'telemetry listener';
      ble.telemetryHandler = function(event) {
        if (currentSession(session) && event.target === telemetry)
          onTelemetry(event)
      };
      telemetry.addEventListener('characteristicvaluechanged', ble.telemetryHandler);
      setConnection(true, 'BLE OK');
      stage = 'initial control write';
      var initialized = await sendControl(false, true);
      checkSession();
      if (!initialized)
        throw new Error(ble.lastError || 'The initial control command could not be sent.');
      ble.connecting = false;
      render();
      message(
          'Connected to ' + (device.name || CONFIG.fallbackDeviceName) + '.' +
          (CONFIG.requireArm ? ' Keep throttle at 0%, then press ARM ON.' :
                               ' Move the joysticks to control.'));
      return true
    } catch (error) {
      if (currentSession(session)) {
        var canceled = error && error.name === 'NotFoundError' && !device;
        clearConnection(
            'NOT CONNECTED',
            canceled ? 'Device selection was canceled' :
                       'BLE connection failed [' + stage + ']: ' + errorMessage(error))
      }
      if (device && device !== ble.device && device.gatt.connected)
        device.gatt.disconnect();
      return false
    }
  }

  function disconnect() {
    var device = ble.device;
    clearConnection('NOT CONNECTED', 'Disconnected.');
    if (device && device.gatt.connected)
      device.gatt.disconnect()
  }

  function stop() {
    resetControls();
    render();
    message(
        ble.connected ? 'STOP requested — controls reset.' :
                        'STOP — local controls reset; no Bluetooth connection.');
    return sendControl(true, true)
  }

  function toggleArm() {
    if (!CONFIG.requireArm || !ble.connected || settingsOpen || calibrating)
      return Promise.resolve(false);
    if (!state.armed && state.throttle > 0.05) {
      message('Lower throttle to 0% before ARM ON.');
      return Promise.resolve(false)
    }
    state.armed = !state.armed;
    render();
    return sendControl(false, true)
  }

  async function calibrateImu() {
    if (!ble.connected || ble.connecting || settingsOpen || calibrating)
      return false;
    resetControls();
    calibrating = true;
    calibrationAcknowledged = false;
    render();
    message('Starting IMU calibration — place the drone level and do not move it.');
    var success = await sendControl(false, true, true);
    if (!success && calibrating && !calibrationAcknowledged) {
      calibrating = false;
      render();
      message('IMU calibration command failed: ' + (ble.lastError || 'Bluetooth write failed.'))
    }
    return success
  }

  ui.connectButton.addEventListener('click', connect);
  ui.fullscreenButton.addEventListener('click', toggleFullscreen);
  ui.armButton.addEventListener('click', toggleArm);
  ui.stopButton.addEventListener('click', stop);
  ui.calibrationButton.addEventListener('click', calibrateImu);
  ui.settingsButton.addEventListener('click', openSettings);
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      // Do not resume an old armed command after the firmware watchdog has
      // disarmed during a hidden/background tab.
      stop()
    } else {
      resetControls();
      render();
      requestControlUpdate()
    }
  });
  function onFullscreenChange() {
    renderFullscreen();
    joysticks.scheduleLayout()
  }
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  setInterval(requestControlUpdate, TX_INTERVAL_MS);
  setInterval(updateMetrics, METRICS_INTERVAL_MS);
  window.addEventListener('error', function(event) {
    message('Interface error: ' + errorMessage(event.error || event.message))
  });
  window.addEventListener('pagehide', disconnect);
  render();
  renderFullscreen();
  setConnection(false, 'NOT CONNECTED');
  return {
    state: state,
    ble: ble,
    pendingTimes: pendingTimes,
    sendControl: sendControl,
    connect: connect,
    onDisconnected: onDisconnected,
    onTelemetry: onTelemetry,
    stop: stop,
    toggleArm: toggleArm,
    calibrateImu: calibrateImu,
    makePacket: makePacket,
    crc16: crc16,
    updateMetrics: updateMetrics,
    requestControlUpdate: requestControlUpdate,
    disconnect: disconnect,
    openSettings: openSettings,
    readSettings: readSettings,
    saveSettings: saveSettings,
    closeSettings: closeSettings,
    TX_INTERVAL_MS: TX_INTERVAL_MS
  };
}
global.FlightController = Object.freeze({create: create});
})(window);
