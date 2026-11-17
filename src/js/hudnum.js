// Changing numbers in the HUD without creating garbage.
//
// A NumField is a fixed row of character cells, one DOM text node each. Formatting writes character codes
// into a preallocated buffer; only the cells whose character changed are touched, and each is set from a
// table of interned one-character strings. No string is ever built in the frame path.
// A cell holding the decimal point or the thousands gap gets the class "n" (narrow), so "43 705.5" does not
// read as three numbers; digits and the padding on the left keep the full width, so the digits never shift.
//
// formatInto() is pure (no DOM) and is what the unit tests exercise.

const SPACE = 32, MINUS = 45, DOT = 46, ZERO = 48, SEP = 0x2009;      // thin space groups the thousands

/** Interned one-character strings for every code a field can show. */
const CH = [];
for (const code of [SPACE, MINUS, DOT, SEP, 0x2013, 0x221E]) CH[code] = String.fromCharCode(code);
for (let d = 0; d < 10; d++) CH[ZERO + d] = String.fromCharCode(ZERO + d);

/**
 * Write `value` right-aligned into buf (character codes), with `decimals` fraction digits and, when
 * `group` is true, a thin space between thousands. Unused cells on the left become spaces.
 * A value that does not fit, or is not finite, fills the field with en dashes.
 * @param {Uint16Array} buf  @returns {Uint16Array} buf
 */
export function formatInto(buf, value, decimals, group) {
  const n = buf.length;
  if (!(Math.abs(value) < 1e15)) { buf.fill(0x2013); return buf; }      // NaN, infinity or absurdly large
  const neg = value < 0;
  const scale = decimals === 0 ? 1 : decimals === 1 ? 10 : decimals === 2 ? 100 : decimals === 3 ? 1000 : Math.pow(10, decimals);
  let scaled = Math.round(Math.abs(value) * scale);                     // an integer below 2^53
  let pos = n - 1;
  for (let k = 0; k < decimals; k++) {
    if (pos < 0) { buf.fill(0x2013); return buf; }
    const q = Math.floor(scaled / 10);
    buf[pos--] = ZERO + (scaled - q * 10); scaled = q;
  }
  if (decimals > 0) { if (pos < 0) { buf.fill(0x2013); return buf; } buf[pos--] = DOT; }
  let digits = 0;
  do {
    if (group && digits > 0 && digits % 3 === 0) { if (pos < 0) { buf.fill(0x2013); return buf; } buf[pos--] = SEP; }
    if (pos < 0) { buf.fill(0x2013); return buf; }
    const q = Math.floor(scaled / 10);
    buf[pos--] = ZERO + (scaled - q * 10); scaled = q; digits++;
  } while (scaled > 0);
  if (neg) { if (pos < 0) { buf.fill(0x2013); return buf; } buf[pos--] = MINUS; }
  while (pos >= 0) buf[pos--] = SPACE;
  return buf;
}

/** Decode a buffer to a string. For tests and start-up code only (it allocates). */
export function bufToString(buf) { return String.fromCharCode(...buf); }

export class NumField {
  /**
   * @param {{appendChild: Function}} parent element that receives one <span> per cell
   * @param {number} cells  width of the field in characters
   * @param {Document} doc
   */
  constructor(parent, cells, doc) {
    this.buf = new Uint16Array(cells).fill(SPACE);
    this.shown = new Uint16Array(cells).fill(SPACE);
    this.nodes = []; this.spans = [];
    for (let i = 0; i < cells; i++) {
      const span = doc.createElement('span');
      span.className = 'c';
      const node = doc.createTextNode(CH[SPACE]);
      span.appendChild(node);
      parent.appendChild(span);
      this.nodes.push(node); this.spans.push(span);
    }
  }

  /** Show a number. Frame path: allocates nothing. */
  set(value, decimals, group) {
    const buf = formatInto(this.buf, value, decimals, group), shown = this.shown, nodes = this.nodes;
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if (c === shown[i]) continue;
      const narrow = c === DOT || c === SEP, was = shown[i] === DOT || shown[i] === SEP;
      if (narrow !== was) this.spans[i].classList.toggle('n', narrow);
      shown[i] = c; nodes[i].data = CH[c];
    }
  }
}

// ---- units: pick a scale and a label for a length or a speed; the labels are interned constants ----
const AU = 149597870.7, LY = 9460730472580.8, C = 299792.458;
export const unit = { value: 0, decimals: 0, label: '' };

/** Scale a length in km for display. Result in the shared `unit` object (no allocation). */
export function lengthUnit(km) {
  const a = Math.abs(km);
  if (a < 9999.5) { unit.value = km; unit.decimals = 1; unit.label = 'km'; }
  else if (a < 1e7) { unit.value = km; unit.decimals = 0; unit.label = 'km'; }
  else if (a < 0.2 * LY) { unit.value = km / AU; unit.decimals = a < 100 * AU ? 3 : 1; unit.label = 'AU'; }
  else { unit.value = km / LY; unit.decimals = 3; unit.label = 'ly'; }
  return unit;
}
/** Scale a speed in km/s for display. Above light speed it is shown as a multiple of c, then in light-years per second. */
export function speedUnit(kms) {
  const a = Math.abs(kms);
  if (a < 999.95) { unit.value = kms; unit.decimals = 1; unit.label = 'km/s'; }
  else if (a < C) { unit.value = kms; unit.decimals = 0; unit.label = 'km/s'; }
  else if (a < 0.05 * LY) { unit.value = kms / C; unit.decimals = a < 1000 * C ? 1 : 0; unit.label = 'c'; }
  else { unit.value = kms / LY; unit.decimals = 2; unit.label = 'ly/s'; }
  return unit;
}
