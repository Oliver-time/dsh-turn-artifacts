/**
 * The wire shape of one settled tool result, in one place.
 *
 * Verified against real session logs (the DSH sessions directory, files named
 * session.jsonl.zstd):
 *
 *   message.content[0] = {
 *     type: 'tool-result',
 *     toolCallId,
 *     isError,
 *     content: [{ type: 'text', text }],
 *   }
 *
 * The readable payload sits one level BELOW the block, not on it. Reading
 * `block.text` therefore yields nothing on real events, which is how the result
 * half of this plugin once indexed nothing at all in production while every
 * fixture-backed check passed.
 *
 * Both spellings are accepted here so a flattened fixture keeps working, but
 * anything asserting real behaviour must build the nested shape.
 */

/**
 * Text blocks of a result message's `content` array.
 *
 * @param content - the result message's `content` array.
 * @returns every non-empty text block, in wire order.
 */
export function resultTexts(content) {
  if (!Array.isArray(content)) return []
  const out = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const parts = Array.isArray(block.content) ? block.content : []
    for (const part of parts) {
      if (part === null || typeof part !== 'object') continue
      if (typeof part.text === 'string' && part.text.length > 0) out.push(part.text)
    }
    if (typeof block.text === 'string' && block.text.length > 0) out.push(block.text)
  }
  return out
}

/**
 * Whether one content block reports a failed tool call.
 *
 * The error flag stays on the outer block, not on the nested text parts.
 *
 * @param content - the result message's `content` array.
 * @returns true when the first block is marked as an error.
 */
export function resultIsError(content) {
  if (!Array.isArray(content)) return false
  return content[0]?.isError === true
}
