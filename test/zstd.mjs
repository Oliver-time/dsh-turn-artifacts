/**
 * Minimal zstd session-log reader.
 *
 * A DSH session log is a concatenation of independent zstd frames, and
 * `zlib.zstdDecompressSync` decodes only the frames its input fully covers. The
 * reader therefore decodes one frame at a time: it finds the largest prefix that
 * still yields output, then scans forward for the next frame magic. The scan is
 * bounded to a few bytes, because a zstd frame is followed immediately by the
 * next frame's header in this format.
 *
 * @module test/zstd
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

/** Largest single frame this reader will attempt, in bytes. */
const MAX_FRAME = 1 << 24

/** zstd frame magic, little endian. */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Find the largest prefix of `buffer` starting at `offset` that decodes.
 *
 * @param buffer - the whole log.
 * @param offset - start of the frame.
 * @returns the decoded bytes and the offset of the prefix end, or null.
 */
function decodeFrame(buffer, offset) {
  let decoded = null
  let window = 0
  let size = 1 << 10
  while (offset + size <= buffer.length && size <= MAX_FRAME) {
    try {
      decoded = zstdDecompressSync(buffer.subarray(offset, offset + size))
      window = size
    } catch {
      break
    }
    size <<= 1
  }
  if (decoded === null) {
    try {
      return { decoded: zstdDecompressSync(buffer.subarray(offset)), window: buffer.length - offset }
    } catch {
      return null
    }
  }
  return { decoded, window }
}

/**
 * First frame magic at or after `from`.
 *
 * The scan starts at the largest prefix that failed, not at the frame's exact
 * end: a zstd magic cannot appear inside a valid frame payload, so scanning
 * forward from anywhere inside the previous prefix (including inside the next
 * frame's own header) lands on the next real frame.
 *
 * @param buffer - the whole log.
 * @param from - first candidate offset.
 * @returns the offset, or the buffer end.
 */
function nextFrame(buffer, from) {
  for (let index = from; index < buffer.length - 3; index += 1) {
    if (buffer[index] === MAGIC[0] && buffer[index + 1] === MAGIC[1] && buffer[index + 2] === MAGIC[2] && buffer[index + 3] === MAGIC[3]) {
      return index
    }
  }
  return buffer.length
}

/**
 * Decode a whole multi-frame session log.
 *
 * @param file - path to a `.jsonl.zstd` log.
 * @returns the concatenated plain text.
 */
export function decompressSession(file) {
  const buffer = readFileSync(file)
  const chunks = []
  let offset = 0
  for (let frame = 0; frame < 100000 && offset < buffer.length - 3; frame += 1) {
    const decoded = decodeFrame(buffer, offset)
    if (decoded === null) break
    chunks.push(decoded.decoded)
    const next = nextFrame(buffer, offset + decoded.window)
    if (next <= offset) break
    offset = next
  }
  return Buffer.concat(chunks)
}
