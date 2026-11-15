// Renders the Clavium icon (key on a blue tile) to PNG and ICO, and the menu bar icon, without any
// image library: signed-distance shapes, 4x4 supersampling, hand-written PNG/ICO encoder.
import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

function crc32(buf) {
  let c
  const table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// geometry in a 64x64 design space (same as src/renderer/src/components/Logo.tsx)
const sdRoundRect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r
  const qy = Math.abs(y - cy) - hh + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const sdSegment = (x, y, ax, ay, bx, by) => {
  const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)))
  return Math.hypot(pax - bax * h, pay - bay * h)
}

const sdKey = (x, y, w) => {
  const ring = Math.abs(Math.hypot(x - 22, y - 32) - 9) - w
  const shaft = sdSegment(x, y, 31, 32, 51, 32) - w
  const tooth1 = sdSegment(x, y, 45, 32, 45, 40) - w
  const tooth2 = sdSegment(x, y, 51, 32, 51, 38) - w
  return Math.min(ring, shaft, tooth1, tooth2)
}

function sampleIcon(x, y) {
  // returns [r,g,b,a] in 0..1
  const tile = sdRoundRect(x, y, 32, 32, 29, 29, 14)
  if (tile > 0) return [0, 0, 0, 0]
  // vertical single-hue gradient: #3f97ff (top) -> #0b5fd8 (bottom)
  const t = Math.max(0, Math.min(1, (y - 3) / 58))
  let r = (0x3f + (0x0b - 0x3f) * t) / 255
  let g = (0x97 + (0x5f - 0x97) * t) / 255
  let b = (0xff + (0xd8 - 0xff) * t) / 255
  if (sdKey(x, y, 2.75) <= 0) [r, g, b] = [1, 1, 1]
  return [r, g, b, 1]
}

// The key alone in black, for the menu bar of macOS (a "template image": the system colours it).
// It fills the picture: the 46 design units around the key are stretched over the whole canvas.
function sampleTemplate(x, y) {
  const scale = 46 / 64
  return [0, 0, 0, sdKey(10 + x * scale, 10 + y * scale, 3.4) <= 0 ? 1 : 0]
}

function render(size, sample = sampleIcon) {
  const out = Buffer.alloc(size * size * 4)
  const ss = 4
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let ar = 0, ag = 0, ab = 0, aa = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = ((px + (sx + 0.5) / ss) / size) * 64
          const y = ((py + (sy + 0.5) / ss) / size) * 64
          const [r, g, b, a] = sample(x, y)
          ar += r * a; ag += g * a; ab += b * a; aa += a
        }
      }
      const n = ss * ss
      const i = (py * size + px) * 4
      out[i + 3] = Math.round((aa / n) * 255)
      if (aa > 0) {
        out[i] = Math.round((ar / aa) * 255)
        out[i + 1] = Math.round((ag / aa) * 255)
        out[i + 2] = Math.round((ab / aa) * 255)
      }
    }
  }
  return encodePng(size, out)
}

function encodeIco(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const dir = Buffer.alloc(16 * pngs.length)
  let offset = 6 + dir.length
  pngs.forEach(([size, png], i) => {
    const o = i * 16
    dir[o] = size >= 256 ? 0 : size
    dir[o + 1] = size >= 256 ? 0 : size
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += png.length
  })
  return Buffer.concat([header, dir, ...pngs.map(([, p]) => p)])
}

mkdirSync('build', { recursive: true })
mkdirSync('resources', { recursive: true })
writeFileSync('build/icon.png', render(1024))
writeFileSync('resources/icon.png', render(256))
writeFileSync('build/icon.ico', encodeIco([16, 24, 32, 48, 64, 128, 256].map((s) => [s, render(s)])))
writeFileSync('resources/trayTemplate.png', render(18, sampleTemplate))
writeFileSync('resources/trayTemplate@2x.png', render(36, sampleTemplate))
console.log('icons written: build/icon.png, build/icon.ico, resources/icon.png, resources/trayTemplate.png')
