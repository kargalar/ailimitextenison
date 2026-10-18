const fs = require('fs');
const opentype = require('opentype.js');
const ttf2woff = require('ttf2woff');

// Read the original woff
const origBuffer = fs.readFileSync('media/fonts/ai-limit-brand.woff');
const origFont = opentype.parse(origBuffer.buffer.slice(origBuffer.byteOffset, origBuffer.byteOffset + origBuffer.byteLength));

console.log('Original glyphs:');
const newGlyphs = [];

// Keep original brand glyphs (0: .notdef, 1: claude, 2: codex, 3: gemini), skipping any existing ring glyphs
for (let i = 0; i < origFont.glyphs.length; i++) {
  const g = origFont.glyphs.get(i);
  if (g.name && g.name.startsWith('ring-')) continue;
  console.log(i, g.name, g.unicode ? '0x' + g.unicode.toString(16) : 'none');
  newGlyphs.push(g);
}

// Coordinate system:
// unitsPerEm = 1000, ascender = 1000, descender = 0
// Center is (500, 500)
const cx = 500;
const cy = 500;
const R_thick = 400; // outer radius of thick progress arc
const r_thick = 280; // inner radius of thick progress arc
const R_thin = 360;  // outer radius of thin background track
const r_thin = 320;  // inner radius of thin background track

// Helper: polar coords in font space (y is UP, 0 deg is 12 o'clock / top)
function polar(r, degClockwise) {
  const rad = (90 - degClockwise) * Math.PI / 180;
  return {
    x: Math.round(cx + r * Math.cos(rad)),
    y: Math.round(cy + r * Math.sin(rad))
  };
}

// Helper: add arc of line segments to path
function addArc(path, r, startDeg, endDeg, stepDeg = 5) {
  if (startDeg < endDeg) {
    // Clockwise
    for (let d = startDeg + stepDeg; d < endDeg; d += stepDeg) {
      const p = polar(r, d);
      path.lineTo(p.x, p.y);
    }
  } else {
    // Counter-clockwise
    for (let d = startDeg - stepDeg; d > endDeg; d -= stepDeg) {
      const p = polar(r, d);
      path.lineTo(p.x, p.y);
    }
  }
  const endP = polar(r, endDeg);
  path.lineTo(endP.x, endP.y);
}

// Helper: create full circular ring (outer clockwise, inner counter-clockwise)
function addFullRing(path, rOuter, rInner) {
  // Outer circle (clockwise from top: 0 -> 360)
  const pStartOut = polar(rOuter, 0);
  path.moveTo(pStartOut.x, pStartOut.y);
  addArc(path, rOuter, 0, 360, 10);
  path.close();

  // Inner circle (counter-clockwise: 360 -> 0)
  const pStartIn = polar(rInner, 360);
  path.moveTo(pStartIn.x, pStartIn.y);
  addArc(path, rInner, 360, 0, 10);
  path.close();
}

function createRingPath(percent) {
  const path = new opentype.Path();

  if (percent <= 0) {
    // 0%: Only the thin track ring
    addFullRing(path, R_thin, r_thin);
    return path;
  }

  if (percent >= 100) {
    // 100%: Full thick ring
    addFullRing(path, R_thick, r_thick);
    return path;
  }

  // 1%..99%:
  // 1) Thin complete track ring
  addFullRing(path, R_thin, r_thin);

  // 2) Thick progress arc from 0 to alpha deg
  const alpha = Math.max(5, Math.min(355, (percent / 100) * 360));
  const p0_out = polar(R_thick, 0);
  const pAlpha_out = polar(R_thick, alpha);
  const pAlpha_in = polar(r_thick, alpha);
  const p0_in = polar(r_thick, 0);

  // Start at top outer
  path.moveTo(p0_out.x, p0_out.y);
  // Outer arc clockwise to alpha
  addArc(path, R_thick, 0, alpha, 5);
  // Line to inner arc at alpha
  path.lineTo(pAlpha_in.x, pAlpha_in.y);
  // Inner arc counter-clockwise back to 0
  addArc(path, r_thick, alpha, 0, 5);
  // Close back to p0_out
  path.close();

  return path;
}

// Generate glyphs for 0..100 in steps of 5 (21 glyphs)
// Unicodes: \ueb00 to \ueb14
const steps = [];
for (let p = 0; p <= 100; p += 5) {
  steps.push(p);
}

for (let i = 0; i < steps.length; i++) {
  const percent = steps[i];
  const unicode = 0xeb00 + i;
  const name = `ring-${percent}`;
  const path = createRingPath(percent);

  const glyph = new opentype.Glyph({
    name,
    unicode,
    advanceWidth: 1000,
    path
  });
  newGlyphs.push(glyph);
}

console.log(`Total glyphs now: ${newGlyphs.length}`);

// Create new font
const font = new opentype.Font({
  familyName: 'ai-limit-brand',
  styleName: 'Medium',
  unitsPerEm: 1000,
  ascender: 1000,
  descender: 0,
  glyphs: newGlyphs
});

const ttfBuffer = Buffer.from(font.toArrayBuffer());
console.log(`TTF buffer size: ${ttfBuffer.length} bytes`);

// Convert TTF to WOFF
const woffBuffer = Buffer.from(ttf2woff(ttfBuffer).buffer);
console.log(`WOFF buffer size: ${woffBuffer.length} bytes`);

fs.writeFileSync('media/fonts/ai-limit-brand.woff', woffBuffer);
console.log('Successfully updated media/fonts/ai-limit-brand.woff!');
