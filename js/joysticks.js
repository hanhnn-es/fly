(function(global) {
'use strict';
function create(ui, state, onChange) {
  var clamp = global.FlightProtocol.clamp;
  function moveData(event, legacy) {
    if (legacy && legacy.vector)
      return legacy;
    if (event && event.data && event.data.vector)
      return event.data;
    if (event && event.vector)
      return event;
    return null
  }
  function stickDimensions(zone) {
    var padSize = Math.min(zone.clientWidth, zone.clientHeight) || 260;
    var ratio = window.matchMedia('(orientation: portrait)').matches ? .24 : .28;
    var thumbSize = Math.min(padSize - 1, Math.max(28, Math.round(padSize * ratio)));
    return {
      thumb: thumbSize, track: Math.max(1, padSize - thumbSize)
    }
  }
  function fitPad(zone) {
    var pad = zone.parentElement, wrap = pad.parentElement;
    var size = Math.max(1, Math.min(wrap.clientWidth, wrap.clientHeight, 330));
    if (pad.style.width !== size + 'px')
      pad.style.width = size + 'px'
  }
  fitPad(ui.leftStick);
  fitPad(ui.rightStick);
  var common = {
    mode: 'static',
    position: {left: '50%', top: '50%'},
    size: stickDimensions(ui.leftStick).track,
    threshold: .03,
    fadeTime: 80,
    restOpacity: 1,
    color: {front: 'linear-gradient(145deg,#7dd3fc,#0284c7)', back: 'rgba(56,189,248,.14)'}
  };
  var left = nipplejs.create(
      Object.assign({}, common, {zone: ui.leftStick, restJoystick: {x: true, y: false}}));
  var right = nipplejs.create(Object.assign({}, common, {zone: ui.rightStick, restJoystick: true}));
  var leftGeometry, rightGeometry;
  function applyStickGeometry(manager, zone) {
    fitPad(zone);
    var dimensions = stickDimensions(zone), trackSize = dimensions.track,
        thumbSize = dimensions.thumb;
    var joystick = manager.getJoystickByUid();
    manager.options.size = trackSize;
    if (!joystick)
      return {joystick: null, radius: trackSize / 2};
    joystick.options.size = trackSize;
    Object.assign(joystick.ui.back.style, {
      width: trackSize + 'px',
      height: trackSize + 'px',
      marginLeft: -(trackSize / 2) + 'px',
      marginTop: -(trackSize / 2) + 'px'
    });
    Object.assign(joystick.ui.front.style, {
      width: thumbSize + 'px',
      height: thumbSize + 'px',
      marginLeft: -(thumbSize / 2) + 'px',
      marginTop: -(thumbSize / 2) + 'px'
    });
    return {
      joystick: joystick, radius: trackSize / 2
    }
  }
  function positionFromState(geometry, x, y) {
    if (!geometry.joystick)
      return;
    var length = Math.hypot(x, y), scale = length > 1 ? 1 / length : 1;
    geometry.joystick.setPosition(
        undefined, {x: x * scale * geometry.radius, y: -y * scale * geometry.radius})
  }
  function resetSticks() {
    positionFromState(leftGeometry, state.yaw, state.throttle * 2 - 1);
    positionFromState(rightGeometry, state.roll, state.pitch)
  }
  function layoutSticks() {
    var landscape = window.matchMedia('(orientation: landscape)').matches;
    ui.commandPanel.classList.toggle('tight', landscape && ui.commandPanel.clientHeight < 205);
    leftGeometry = applyStickGeometry(left, ui.leftStick);
    rightGeometry = applyStickGeometry(right, ui.rightStick);
    resetSticks()
  }
  layoutSticks();
  var stickLayoutFrame = 0;
  function scheduleStickLayout() {
    cancelAnimationFrame(stickLayoutFrame);
    stickLayoutFrame = requestAnimationFrame(layoutSticks)
  }
  window.addEventListener('resize', scheduleStickLayout);
  window.addEventListener('orientationchange', scheduleStickLayout);
  if (window.visualViewport)
    window.visualViewport.addEventListener('resize', scheduleStickLayout);
  if (window.ResizeObserver) {
    var stickObserver = new ResizeObserver(scheduleStickLayout);
    stickObserver.observe(ui.leftStick.parentElement.parentElement);
    stickObserver.observe(ui.rightStick.parentElement.parentElement);
    stickObserver.observe(ui.commandPanel)
  }
  left.on('move', function(event, legacy) {
    var data = moveData(event, legacy);
    if (!data)
      return;
    state.yaw = clamp(data.vector.x, -1, 1);
    state.throttle = clamp((data.vector.y + 1) / 2, 0, 1);
    onChange()
  });
  left.on('end', function() {
    state.yaw = 0;
    onChange()
  });
  right.on('move', function(event, legacy) {
    var data = moveData(event, legacy);
    if (!data)
      return;
    state.roll = clamp(data.vector.x, -1, 1);
    state.pitch = clamp(data.vector.y, -1, 1);
    onChange()
  });
  right.on('end', function() {
    state.roll = 0;
    state.pitch = 0;
    onChange()
  });

  return {reset: resetSticks, scheduleLayout: scheduleStickLayout};
}
global.FlightJoysticks = Object.freeze({create: create});
})(window);
