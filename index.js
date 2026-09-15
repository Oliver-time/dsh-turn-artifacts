/**
 * dsh-turn-artifacts, Node half.
 *
 * This half does two things, and only the second is model-facing.
 *
 * ## 1. Row identity and observability
 *
 * A Loader row needs a module with a `main`/`exports` entry so the composition
 * can resolve the owning package, and `dsh.client` in package.json is what turns
 * that same package into a browser bundle served under `/plugins`. The service
 * this half provides lets tooling report whether the plugin is mounted.
 *
 * ## 2. Mention guidance
 *
 * The browser half can only make a file clickable if the closing response *names*
 * it, in Markdown inline code. The shipped deliverables package already ships
 * that instruction, but it is written for files the file tools wrote; a file a
 * terminal command produced is the case it does not cover, and it is exactly the
 * case this plugin exists for. So this half adds one paragraph covering it.
 *
 * That paragraph is a sibling of the shipped one, not a replacement. The prompt
 * registry merges scoped layers by name -- a deeper scope shadows a global
 * section that shares its name --but a Loader row registers in the *global*
 * layer, where a duplicate name is a hard error:
 *
 *     prompt section "ui:deliverable-file-references" is already registered
 *     (for a per-agent override, register through that agent's `agent.ctx`)
 *
 * That error aborts the whole profile boot, so the section below takes its own
 * name and sits one step after the shipped guidance instead. Same prompt, same
 * position, no boot failure.
 *
 * ## What lives elsewhere
 *
 * The artifact index, the mention resolver, the artifact chips, and the session
 * history fill all live in the browser half (`lib/client.js`), because the
 * evidence they need -- the current turn's tool calls and results, and the
 * `sessions` service --is already client-visible. This file registers no tool and
 * touches no model history.
 *
 * @module dsh-turn-artifacts
 */

/** Stable identity published by the Host half. */
export const PLUGIN_NAME = 'turn-artifacts'

/** Plugin version, kept in step with package.json. */
export const PLUGIN_VERSION = '0.5.0'

/**
 * Prompt section this half owns.
 *
 * It sits one step after the shipped guidance rather than replacing it: the
 * system-prompt registry merges scoped layers by name, but a Loader row
 * registers in the *global* layer, where a duplicate name is a hard error
 * ("for a per-agent override, register through that agent's `agent.ctx`"). A
 * distinct name placed immediately after is the same prompt in the same order,
 * without a boot failure.
 */
export const FILE_REFERENCE_SECTION = 'ui:turn-artifact-file-references'

/** One step after the shipped guidance, so both paragraphs read in order. */
const FILE_REFERENCE_ORDER_OFFSET = 1

/**
 * Prompt text for artifacts the shipped guidance does not cover.
 *
 * The shipped text asks for the primary outputs of file-tool calls as inline
 * code. What it leaves out is exactly the case this plugin exists for: a binary
 * only a script produced is in nobody's mutation record, so the two things that
 * make it linkable are (a) naming it in the closing response, and (b) having
 * printed its path in a tool output at all -- a path that never appeared anywhere
 * cannot be linked by any plugin.
 */
export const FILE_REFERENCE_TEXT = [
  'Files produced by a terminal command rather than by a file tool -- a document, chart, archive, or clip written by a script -- are deliverables too:',
  'name them in the final response the same way, as Markdown inline code, using the spelling the command reported.',
  'A reference can only become a link if the path appeared somewhere in this turn\'s tool output,',
  'so when a command produces something you intend to hand over, have it print that path (or at least the location and size) rather than finishing silently.',
  'The full path is not required in prose: a unique file name resolves on its own.',
].join(' ')

/** Host services required by this half. */
export const inject = ['systemPrompt']

/**
 * Register the mention guidance and the status service.
 *
 * @param ctx - Host plugin context carrying the system-prompt registry.
 * @returns nothing; both registrations are effect-owned with the calling fiber.
 */
export function apply(ctx) {
  ctx.systemPrompt.section({
    name: FILE_REFERENCE_SECTION,
    order: ctx.systemPrompt.getSectionOrder('DELIVERABLE_FILE_REFERENCES') + FILE_REFERENCE_ORDER_OFFSET,
    text: FILE_REFERENCE_TEXT,
  })
  ctx.provide(PLUGIN_NAME, {
    /**
     * Report the composed plugin identity.
     *
     * @returns the package name and version of the mounted Host half.
     */
    status() {
      return { name: 'dsh-turn-artifacts', version: PLUGIN_VERSION }
    },
  })
}
