// Harness contract: the URL parameters of the page. Parsed once at start-up; read-only afterwards.
//
//   ?pose=1..6          fixed camera, time and HUD state for the critic's stills
//   ?tour=1             run the 60 s tour, record GPU and frame times, show and log the report
//   ?tt=<seconds>       freeze at that tour time, for deterministic frame capture
//   ?res=2560x1440      fix the render resolution whatever the window size
//   ?freeze=1           stop both clocks
//   ?frames=N           render N frames, then set window.__ready (default 6 when a capture parameter is present)
//   ?neb=<size>         nebula cubemap face size
//   ?hud=0              hide the HUD
// Development extras:
//   ?view=<body>,<distRadii>,<azimuthDeg>,<elevationDeg>[,<yawDeg>,<pitchDeg>,<rollDeg>]
//                       put the camera near a body, looking at its centre with north up. Azimuth is measured from
//                       the direction of the body's star (0 = full phase, 90 = terminator, 180 = night side);
//                       yaw (right), pitch (up) and roll (clockwise) then turn the view, in that order.
//   ?eq=1               with ?view: lay the view out in the body's equatorial frame (elevation above its equator and rings)
//   ?pos=<xAU>,<yAU>,<zAU>[,<yawDeg>,<pitchDeg>]   put the camera at that point of the host system, looking along +X
//                       then turned by yaw and pitch
//   ?day=<days>         simulation epoch in days        ?clock=<seconds>   animation clock
//   ?msaa=1|4           scene sample count              ?exp=<stops>       exposure offset
//   ?no=atmo,clouds,... leave out passes (solid, ring, clouds, atmo, corona): for debugging and cost attribution
//   ?only=<body>        draw that body alone
//   ?sel=<body>         select that body          ?panel=1   open its telemetry panels and cutaway
//   ?cursor=1           cursor-inspection mode    ?mouse=<x>,<y>   pointer position as fractions of the view (hover)
const q = new URLSearchParams(location.search);
const num = (k, d) => (q.has(k) && q.get(k) !== '' && isFinite(+q.get(k)) ? +q.get(k) : d);
const res = /^(\d+)x(\d+)$/.exec(q.get('res') || '');
const view = q.has('view') ? q.get('view').split(',') : null;
const pos = q.has('pos') ? q.get('pos').split(',').map(Number) : null;

export const P = {
  pose: num('pose', 0),
  tour: q.get('tour') === '1',
  tt: num('tt', -1),
  resW: res ? +res[1] : 0,
  resH: res ? +res[2] : 0,
  freeze: q.get('freeze') === '1',
  frames: num('frames', 0),
  neb: num('neb', 1024),
  hud: q.get('hud') !== '0',
  view: view ? { body: view[0], dist: +view[1] || 4, az: +view[2] || 0, el: +view[3] || 0, yaw: +view[4] || 0, pitch: +view[5] || 0, roll: +view[6] || 0 } : null,
  pos: pos ? { x: pos[0] || 0, y: pos[1] || 0, z: pos[2] || 0, yaw: pos[3] || 0, pitch: pos[4] || 0 } : null,
  day: num('day', NaN),
  clock: num('clock', NaN),
  msaa: num('msaa', 0),
  exp: num('exp', 0),
  no: new Set((q.get('no') || '').split(',').filter(Boolean)),
  only: q.get('only') || '',
  eq: q.get('eq') === '1',
  sel: q.get('sel') || '',
  panel: q.get('panel') === '1',
  cursor: q.get('cursor') === '1',
  mouse: q.has('mouse') ? q.get('mouse').split(',').map(Number) : null,
};
/** True when the page is being driven by the capture harness rather than a person. */
export const CAPTURE = P.pose > 0 || P.tt >= 0 || P.frames > 0 || P.freeze || P.view !== null || P.pos !== null;
/** True when the camera follows the scripted tour (played in real time, or frozen at ?tt). */
export const TOURING = P.tour || P.tt >= 0;
