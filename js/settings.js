(function(global) {
'use strict';

function create(actions) {
  var dialog = document.getElementById('settingsDialog');
  // Each entry maps a firmware key to an input and its display-to-wire multiplier.
  var fields = [
    ['center_left', 'configCenterLeft', 1], ['center_right', 'configCenterRight', 1],
    ['min_us', 'configMinPulse', 1], ['max_us', 'configMaxPulse', 1],
    ['amplitude_us', 'configAmplitude', 1], ['turn_comp', 'configTurnComp', 1],
    ['freq_min_dhz', 'configMinFrequency', 10], ['freq_max_dhz', 'configMaxFrequency', 10],
    ['pitch_gain', 'configPitchGain', 0.2], ['roll_gain', 'configRollGain', 0.2],
    ['yaw_gain', 'configYawGain', 0.2]
  ];
  var ui = {};
  ['settingsForm', 'settingsFields', 'settingsStatus', 'settingsRead', 'settingsSave',
   'settingsClose', 'settingsDisconnect', 'configReverseLeft', 'configReverseRight']
      .forEach(function(id) {
        ui[id] = document.getElementById(id);
      });
  fields.forEach(function(field) {
    field[3] = document.getElementById(field[1]);
  });
  var busy = false, loaded = false;

  function update() {
    ui.settingsFields.disabled = busy || !loaded;
    ui.settingsRead.disabled = busy;
    ui.settingsSave.disabled = busy || !loaded;
    ui.settingsClose.disabled = busy;
  }

  function status(text, error) {
    ui.settingsStatus.textContent = text;
    ui.settingsStatus.classList.toggle('error', Boolean(error));
  }

  function show() {
    busy = false;
    loaded = false;
    fields.forEach(function(field) {
      field[3].value = '';
    });
    ui.configReverseLeft.checked = ui.configReverseRight.checked = false;
    update();
    if (typeof dialog.showModal === 'function')
      dialog.showModal();
    else {
      dialog.classList.toggle('settings-fallback', true);
      dialog.setAttribute('open', '');
    }
  }

  function hide() {
    busy = false;
    loaded = false;
    update();
    if (typeof dialog.close === 'function')
      dialog.close();
    else
      dialog.removeAttribute('open');
  }

  function fill(config) {
    fields.forEach(function(field) {
      field[3].value = String(config[field[0]] / field[2]);
    });
    ui.configReverseLeft.checked = Boolean(config.reverse & 1);
    ui.configReverseRight.checked = Boolean(config.reverse & 2);
    loaded = true;
    update();
  }

  function values() {
    var config = {
      reverse: (ui.configReverseLeft.checked ? 1 : 0) | (ui.configReverseRight.checked ? 2 : 0)
    };
    fields.forEach(function(field) {
      var text = String(field[3].value).trim();
      var value = text === '' ? NaN : Number(text) * field[2];
      var rounded = Math.round(value);
      config[field[0]] = Math.abs(value - rounded) < 1e-8 ? rounded : NaN;
    });
    return config;
  }

  ui.settingsRead.addEventListener('click', actions.read);
  ui.settingsClose.addEventListener('click', actions.close);
  ui.settingsDisconnect.addEventListener('click', actions.disconnect);
  ui.settingsForm.addEventListener('submit', function(event) {
    event.preventDefault();
    if (!busy && loaded)
      actions.save();
  });
  dialog.addEventListener('cancel', function(event) {
    event.preventDefault();
    if (!busy)
      actions.close();
  });

  return {
    show: show,
    hide: hide,
    fill: fill,
    values: values,
    status: status,
    ready: function() {
      return loaded;
    },
    invalidate: function() {
      loaded = false;
      update();
    },
    setBusy: function(value) {
      busy = value;
      update();
    }
  };
}

global.FlightSettings = Object.freeze({create: create});
})(window);
