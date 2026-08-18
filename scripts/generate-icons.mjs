import { deflateSync } from 'node:zlib'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = join(root, 'build')
const sizes = [16, 24, 32, 48, 64, 128, 256]
const samples = 4

const palette = {
  tile: [248, 250, 252, 255],
  back: [185, 219, 255, 255],
  blue: [59, 130, 246, 255],
  chrome: [220, 236, 255, 255],
  white: [255, 255, 255, 255],
  green: [22, 181, 125, 255]
}

function roundedRect(x, y, left, top, width, height, radius) {
  const right = left + width
  const bottom = top + height
  const nearestX = Math.max(left + radius, Math.min(x, right - radius))
  const nearestY = Math.max(top + radius, Math.min(y, bottom - radius))
  return x >= left && x <= right && y >= top && y <= bottom && Math.hypot(x - nearestX, y - nearestY) <= radius
}

function cubic(start, c1, c2, end, steps = 18) {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const t = index / steps
    const u = 1 - t
    return [
      u ** 3 * start[0] + 3 * u ** 2 * t * c1[0] + 3 * u * t ** 2 * c2[0] + t ** 3 * end[0],
      u ** 3 * start[1] + 3 * u ** 2 * t * c1[1] + 3 * u * t ** 2 * c2[1] + t ** 3 * end[1]
    ]
  })
}

function curve(segments) {
  return segments.flatMap((segment, index) => cubic(...segment).slice(index === 0 ? 0 : 1))
}

const fingerprint = [
  curve([
    [[92, 163], [90, 156], [89, 150], [89, 143]],
    [[89, 143], [89, 121], [106, 103], [128, 103]],
    [[128, 103], [150, 103], [167, 121], [167, 143]],
    [[167, 143], [167, 151], [166, 158], [163, 165]]
  ]),
  curve([
    [[108, 165], [105, 158], [104, 151], [104, 143]],
    [[104, 143], [104, 130], [115, 119], [128, 119]],
    [[128, 119], [141, 119], [152, 130], [152, 143]],
    [[152, 143], [152, 154], [149, 163], [145, 171]]
  ]),
  curve([
    [[125, 165], [122, 158], [120, 151], [120, 143]],
    [[120, 143], [120, 138], [124, 135], [128, 135]],
    [[128, 135], [132, 135], [136, 138], [136, 143]],
    [[136, 143], [136, 155], [132, 167], [126, 176]]
  ])
]

function distanceToSegment(x, y, start, end) {
  const dx = end[0] - start[0]
  const dy = end[1] - start[1]
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - start[0]) * dx + (y - start[1]) * dy) / lengthSquared))
  return Math.hypot(x - (start[0] + t * dx), y - (start[1] + t * dy))
}

function onStroke(x, y, points, width) {
  for (let index = 1; index < points.length; index += 1) {
    if (distanceToSegment(x, y, points[index - 1], points[index]) <= width / 2) return true
  }
  return false
}

function colorAt(x, y) {
  let color = [0, 0, 0, 0]
  if (roundedRect(x, y, 8, 8, 240, 240, 58)) color = palette.tile
  if (roundedRect(x, y, 65, 48, 145, 112, 23)) color = palette.back
  if (roundedRect(x, y, 42, 72, 172, 132, 26)) color = palette.blue
  if (Math.hypot(x - 64, y - 93) <= 5 || Math.hypot(x - 80, y - 93) <= 5) color = palette.chrome
  if (roundedRect(x, y, 59, 107, 138, 78, 18)) color = palette.white
  if (fingerprint.some((points) => onStroke(x, y, points, 9))) color = palette.green
  return color
}

function rasterize(size) {
  const pixels = Buffer.alloc(size * size * 4)
  const scale = 256 / size
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const rgb = [0, 0, 0]
      let alpha = 0
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const color = colorAt((px + (sx + 0.5) / samples) * scale, (py + (sy + 0.5) / samples) * scale)
          const opacity = color[3] / 255
          alpha += opacity
          for (let channel = 0; channel < 3; channel += 1) rgb[channel] += color[channel] * opacity
        }
      }
      const offset = (py * size + px) * 4
      for (let channel = 0; channel < 3; channel += 1) pixels[offset + channel] = alpha ? Math.round(rgb[channel] / alpha) : 0
      pixels[offset + 3] = Math.round((alpha / samples ** 2) * 255)
    }
  }
  return pixels
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  return crc >>> 0
})

function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const name = Buffer.from(type)
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  name.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length)
  return chunk
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const rows = Buffer.alloc(size * (size * 4 + 1))
  for (let row = 0; row < size; row += 1) rgba.copy(rows, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function encodeIco(images) {
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16
    header[entry] = size === 256 ? 0 : size
    header[entry + 1] = size === 256 ? 0 : size
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map(({ png }) => png)])
}

await mkdir(outputDir, { recursive: true })
const images = sizes.map((size) => ({ size, png: encodePng(size, rasterize(size)) }))
await Promise.all([
  writeFile(join(outputDir, 'icon.png'), images.at(-1).png),
  writeFile(join(outputDir, 'icon.ico'), encodeIco(images))
])
console.log(`Generated FingerBrowser icons: ${sizes.join(', ')}px`)
