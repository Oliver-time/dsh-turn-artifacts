window.__ModuleLoader__.load({
	id: "dsh-turn-artifacts",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");

		/**
		 * Client half: clickable links for script-produced files, plus a session
		 * history fill.
		 *
		 * ## Why the link vocabulary needs widening
		 *
		 * The shipped deliverables plugin derives its mention vocabulary from the
		 * arguments of successful `write`, `edit`, and mutating
		 * `str_replace_editor` calls. A file that only a terminal command ever
		 * touched (a `.pptx` written by python-pptx, a `.png` chart, an `.mp4`
		 * render) is in nobody's mutation record, so writing its name as inline
		 * code gets the reader dead text: the shipped resolver declines and the
		 * chat view has nothing else to ask.
		 *
		 * This half supplies the missing vocabulary instead of editing that one. It
		 * indexes the paths that scrolled past in the current turn's tool calls and
		 * tool results, and appends a second resolver to the `chatFileMentions`
		 * service the chat view consults for a closing message. The shipped
		 * vocabulary stays authoritative because it is asked first: a mention it
		 * already resolves keeps its exact behavior, and this resolver answers only
		 * the tokens it left inert.
		 *
		 * The rest of this module is the evidence rules that keep those extra links
		 * honest — see the `artifact extraction`, `mention resolution`, and
		 * `artifact chips` regions.
		 *
		 * ## History autofill
		 *
		 * A second, unrelated job lives in the `history autofill` region: the
		 * session controller opens a conversation with one 50-message page and the
		 * view's paging button is the only way to grow it, so a long conversation
		 * shows just its newest page on a fresh load — most visibly right after a
		 * `dsh web` restart — until the reader pages back by hand.
		 *
		 * That fill is not a deliverable and has nothing to do with file links; it
		 * is here because this is the client plugin already mounted in this profile.
		 * A reader taking this package apart should feel free to delete the region
		 * and its subscription in {@link apply}: nothing else depends on it, and the
		 * plugin's own purpose is complete without it.
		 *
		 * @module dsh-turn-artifacts/client
		 */

		//#region artifact extraction

		/** File extensions worth treating as a produced artifact. */
		const ARTIFACT_EXTENSIONS = new Set([
			"7z", "avi", "bmp", "csv", "doc", "docx", "epub", "flac", "gif", "gz",
			"html", "jpeg", "jpg", "js", "json", "jsonl", "log", "m4a", "md", "mkv",
			"mov", "mp3", "mp4", "m4v", "odp", "ods", "odt", "ogg", "pdf", "png",
			"ppt", "pptx", "ps1", "py", "rar", "srt", "svg", "tar", "tex", "tgz",
			"ts", "tsv", "txt", "wav", "webm", "webp", "wmv", "xls", "xlsx", "xml",
			"yaml", "yml", "zip", "zst",
		]);

		/**
		 * One path segment, as it appears between separators.
		 *
		 * A segment starts with a letter, a digit, an underscore, a dot, or an
		 * ideograph, and continues with the same plus interior punctuation. That
		 * first-character rule is what rejects prose glued to a filename, while
		 * admitting every spelling this Host actually uses: a drive letter (`C:`),
		 * a relative start (`..`), a dotted name (`polish_v13.py`), and a Chinese
		 * directory (`_文档`, `暑期汇报`) all pass. A backslash is interior-legal
		 * because tool output reaches the browser in its escaped spelling, so a
		 * single separator can still be a `\\` pair by the time a chunk is split.
		 * Ideographs are admitted on purpose — truncating at them would index the
		 * wrong path, and a link that opens the wrong file is worse than a link
		 * that does not appear.
		 */
		const SEGMENT_RE = /^[A-Za-z0-9_.\u3400-\u9fff\uf900-\ufaff][A-Za-z0-9_.,:\\\-\u3400-\u9fff\uf900-\ufaff]*$/;

		/** Trailing extension of a final segment, without the dot. */
		const SEGMENT_EXTENSION_RE = /\.([A-Za-z0-9]{1,8})$/;

		/**
		 * A URL scheme at the start of a candidate.
		 *
		 * `https://host/file.png` collapses to `https:/host/file.png` once folded,
		 * and its final segment is indistinguishable from an artifact, so the
		 * scheme is what has to disqualify it.
		 */
		const URL_PREFIX_RE = /^[A-Za-z][A-Za-z0-9+.\-]*:\//;

		/** Longest tool-result prefix scanned for paths; keeps a huge log dump cheap. */
		const SCAN_LIMIT = 120000;

		/** Artifacts retained per turn. */
		const TURN_LIMIT = 128;

		/**
		 * Normalize one captured path without deciding what it points at.
		 *
		 * Separators are folded to `/`, which is both what the matcher expects and
		 * a spelling the Host opener accepts, and trailing punctuation that merely
		 * followed the path in prose is dropped.
		 *
		 * @param raw - the path text as it appeared in a tool call or result.
		 * @returns the normalized path, or null when it is not worth keeping.
		 */
		function normalizeArtifactPath(raw) {
			if (typeof raw !== "string") return null;
			if (raw.includes("\u0000")) return null;
			let value = raw
				.replace(/\\{2,}/g, "/")
				.replace(/\\/g, "/")
				.replace(/\/{2,}/g, "/")
				.replace(/^\.\//, "");
			while (value.length > 0 && /[.,;:'"`)\]}]+$/.test(value)) value = value.slice(0, -1);
			if (value.length < 4 || value.length > 400) return null;
			if (/[\u0000-\u001f]/.test(value)) return null;
			const at = value.lastIndexOf("/");
			const base = at === -1 ? value : value.slice(at + 1);
			const dot = base.lastIndexOf(".");
			if (dot <= 0) return null;
			if (!ARTIFACT_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())) return null;
			return value;
		}

		/**
		 * Whether a segment is a real path segment rather than prose.
		 *
		 * @param segment - one separator-delimited token.
		 * @returns true when the segment can only be a path segment.
		 */
		function isSegment(segment) {
			return SEGMENT_RE.test(segment)
		}

		/**
		 * Drop the punctuation that merely surrounded a path in prose.
		 *
		 * A token like `"C:\out\报告.pdf",` carries a quote, a comma, a backslash
		 * separator, or a closing bracket that belongs to the sentence rather than
		 * to the file name. A colon is deliberately absent from both sets: it is
		 * what makes `C:` a drive letter, and a trailing colon is never sentence
		 * punctuation in tool output.
		 *
		 * @param token - one separator-delimited token.
		 * @returns the token with its surrounding punctuation removed.
		 */
		function stripSurroundingPunctuation(token) {
			let value = token;
			while (value.length > 0 && /^[.,;:'"`([{]/.test(value)) value = value.slice(1);
			while (value.length > 0 && /[.,;'"`)\]}\\]$/.test(value)) value = value.slice(0, -1);
			return value;
		}

		/**
		 * Whether a segment ends in a recognized artifact extension.
		 *
		 * @param segment - final segment candidate.
		 * @returns true when the extension is on the artifact list.
		 */
		function hasArtifactExtension(segment) {
			const found = SEGMENT_EXTENSION_RE.exec(stripSurroundingPunctuation(segment));
			return found !== null && ARTIFACT_EXTENSIONS.has(found[1].toLowerCase());
		}

		/** Path key used for de-duplication and matching: case- and separator-insensitive. */
		function pathKey(value) {
			return value.toLowerCase().replace(/\\/g, "/");
		}

		/** Trailing path segment, in either separator spelling. */
		function basename(value) {
			const at = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
			return at === -1 ? value : value.slice(at + 1);
		}

		/** Native separator spelling for display; this Host is Windows. */
		function displayPath(value) {
			return value.replace(/\//g, "\\");
		}

		/**
		 * Resolve one path spelling against the session working directory.
		 *
		 * @param base - session workspace root, when known.
		 * @param value - relative or absolute path text.
		 * @returns the path to hand the Host opener.
		 */
		function resolveAgainst(base, value) {
			if (typeof value !== "string") return value;
			if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\")) return value;
			if (base === undefined || base === null || base === "") return value;
			return `${String(base).replace(/[\\/]+$/, "")}/${value.replace(/^[\\/]+/, "")}`;
		}

		/**
		 * Whether a path spelling can be acted on without guessing where it lives.
		 *
		 * An absolute path names its own location. A relative path with a directory
		 * component names its own location *within* the workspace. A bare file name
		 * names nothing: joining it to the session workspace root is a guess, and a
		 * guess that produces a link to a file which does not exist — or worse, to
		 * a different file with the same name. So a bare name is only indexed when
		 * a tool call named it as its own file argument.
		 *
		 * @param value - normalized path candidate.
		 * @returns true when the candidate may be indexed.
		 */
		function isLocatedPath(value) {
			return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\") || value.includes("/");
		}

		/**
		 * Boundaries between one value and the next inside tool text.
		 *
		 * Tool results are JSON, so two paths are separated by a quote, a colon
		 * after a key, or a comma rather than by the spaces prose would use, and
		 * the walk splits on all of them. A separator, a colon, and a backslash are
		 * deliberately absent from this set: they are path content, and a drive
		 * letter must survive the split intact.
		 */
		const CHUNK_SEPARATOR_RE = /[\s"'`()\[\]{}<>=|,;]+/;

		/**
		 * Every artifact-shaped path in one text blob, in first-seen order.
		 *
		 * Each candidate is a run of characters with no whitespace, no quote, and
		 * no bracket, so one run holds exactly one path however the tool printed
		 * it: a Windows spelling (`C:\\dir\\file.png`), a forward-slash spelling,
		 * or a workspace-relative path. Runs are length-bounded so a pathological
		 * result cannot turn the walk into an expensive scan.
		 *
		 * @param text - tool-call arguments or tool-result text.
		 * @returns normalized paths, empty when the text carries none.
		 */
		function collectPaths(text) {
			if (typeof text !== "string" || text.length === 0) return [];
			const haystack = text.length > SCAN_LIMIT ? text.slice(0, SCAN_LIMIT) : text;
			const out = [];
			const seen = new Set();
			for (const chunk of haystack.split(CHUNK_SEPARATOR_RE)) {
				if (chunk.length < 4 || chunk.length > 400) continue;
				if (URL_PREFIX_RE.test(chunk)) continue;
				const folded = chunk
					.replace(/\\{2,}/g, "/")
					.replace(/\\/g, "/")
					.replace(/\/{2,}/g, "/");
				const parts = folded.split("/").filter((part) => part.length > 0);
				if (parts.length === 0) continue;
				if (!hasArtifactExtension(parts[parts.length - 1])) continue;
				let start = parts.length - 1;
				while (start > 0 && isSegment(parts[start - 1])) start -= 1;
				const path = normalizeArtifactPath(parts.slice(start).join("/"));
				if (path === null || !isLocatedPath(path)) continue;
				const key = pathKey(path);
				if (seen.has(key)) continue;
				seen.add(key);
				out.push(path);
			}
			return out;
		}

		/**
		 * Concatenated text of a tool result's content blocks.
		 *
		 * @param content - the result message's content array.
		 * @returns readable text, empty when the result carries none.
		 */
		function resultText(content) {
			if (!Array.isArray(content)) return "";
			let text = "";
			for (const block of content) {
				if (block === null || typeof block !== "object") continue;
				// Real wire shape, verified against session logs:
				//   { type: 'tool-result', toolCallId, isError, content: [{ type: 'text', text }] }
				// The payload sits one level deeper than the block itself, so
				// reading `block.text` alone yields "" for every real result.
				const parts = Array.isArray(block.content) ? block.content : [];
				for (const part of parts) {
					if (part === null || typeof part !== "object") continue;
					if (typeof part.text === "string") text += "\n" + part.text;
				}
				// Tolerate a flattened spelling as well.
				if (typeof block.text === "string") text += "\n" + block.text;
			}
			return text;
		}

		/**
		 * Path arguments of one tool call.
		 *
		 * Only argument keys that name a file the call will touch count, plus a
		 * command string. Keys like `workdir`, `cwd`, `output`, or `dest` are
		 * deliberately excluded: a tool result reports the artifact a command
		 * produced, and taking the arguments as evidence too would index whatever a
		 * command merely read from or wrote into — the workspace root included.
		 *
		 * A path argument is indexed even when it is a bare file name: the call
		 * named that file itself, so the plugin is not guessing where it lives.
		 *
		 * @param name - wire tool name, when known.
		 * @param argsRaw - model-produced JSON arguments.
		 * @returns normalized paths, empty when the call names none.
		 */
		function collectCallPaths(name, argsRaw) {
			if (typeof argsRaw !== "string" || argsRaw.length === 0) return [];
			let args;
			try {
				args = JSON.parse(argsRaw);
			} catch {
				return [];
			}
			if (args === null || typeof args !== "object" || Array.isArray(args)) return [];
			const out = [];
			for (const key of ["file_path", "path", "file"]) {
				if (!(key in args)) continue;
				const path = normalizeArtifactPath(args[key]);
				if (path !== null) out.push(path);
			}
			if (name === "pwsh" || name === "bash") out.push(...collectPaths(typeof args.command === "string" ? args.command : ""));
			return out;
		}

		/**
		 * Paths a mutation call is authoritative for.
		 *
		 * Mirrors the shipped deliverables vocabulary so this plugin's own copy of
		 * it agrees with the row rendered above the chips: a produced file is
		 * listed whether or not the model remembered to name it, a failed call
		 * contributes nothing, and a file written then edited stays one entry.
		 *
		 * @param name - wire tool name.
		 * @param argsRaw - model-produced JSON arguments.
		 * @returns the mutation's own path, or null.
		 */
		function mutationPath(name, argsRaw) {
			if (name !== "write" && name !== "edit" && name !== "str_replace_editor") return null;
			let args;
			try {
				args = JSON.parse(argsRaw);
			} catch {
				return null;
			}
			if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
			const path = typeof args.file_path === "string" && args.file_path.trim().length > 0 ? args.file_path
				: typeof args.path === "string" && args.path.trim().length > 0 ? args.path
					: null;
			if (path === null) return null;
			switch (name) {
				case "write":
					return typeof args.content === "string" ? path : null;
				case "edit":
					return typeof args.old_string === "string" && args.old_string.length > 0
						&& typeof args.new_string === "string" && args.old_string !== args.new_string
						&& (args.replace_all === void 0 || typeof args.replace_all === "boolean") ? path : null;
				default:
					return args.command === "create" && typeof args.file_text === "string" ? path
						: args.command === "str_replace" && typeof args.old_str === "string" && args.old_str.length > 0 ? path
							: args.command === "insert" && Number.isInteger(args.insert_line) && args.insert_line >= 0 ? path
								: null;
			}
		}

		/**
		 * One turn's artifact evidence, accumulated as the turn streams.
		 *
		 * The maps are module-owned rather than plugin-owned so they survive a hot
		 * reload of this plugin: the event engine replays a session's history into
		 * a freshly mounted Definition, and a reload that also cleared the index
		 * would keep links dead until the page was reloaded.
		 */
		const artifactByTurn = new Map();
		const authoredByTurn = new Map();
		const turnByCallId = new Map();
		/** Mutation path awaiting a settled result, keyed by call id. */
		const pendingMutations = new Map();

		/** Identity-stable accumulation bucket for one turn. */
		function bucketOf(store, turn) {
			let bucket = store.get(turn);
			if (bucket === void 0) {
				bucket = { keys: new Set(), paths: [], ref: 0 };
				store.set(turn, bucket);
			}
			return bucket;
		}

		/**
		 * Record one path in a turn's bucket.
		 *
		 * The bucket is replaced rather than mutated in place so its `paths` array
		 * keeps a new identity exactly when its content changed, which is what
		 * lets a mounted component know there is something new to render.
		 *
		 * @param store - bucket map to update.
		 * @param turn - owning turn number.
		 * @param path - normalized path about to be recorded.
		 */
		function addPath(store, turn, path) {
			if (typeof path !== "string" || path.length === 0) return;
			const bucket = bucketOf(store, turn);
			const key = pathKey(path);
			if (bucket.keys.has(key) || bucket.paths.length >= TURN_LIMIT) return;
			const keys = new Set(bucket.keys);
			keys.add(key);
			store.set(turn, { keys, paths: [...bucket.paths, path], ref: bucket.ref + 1 });
		}

		/** Paths of one bucket, or an empty list when the turn recorded nothing. */
		function pathsOf(store, turn) {
			const bucket = store.get(turn);
			return bucket === void 0 ? [] : bucket.paths;
		}

		/**
		 * Turn-scoped artifact accumulator.
		 *
		 * Publishes two values under `turn-artifacts`: the paths this turn's tool
		 * traffic mentions, and the subset the mutation tools authored. Both are
		 * reference-stable, so a re-materialization that changed nothing keeps the
		 * values a mounted component already reads.
		 */
		const artifactDefinition = {
			kind: "turn-artifacts",
			match: (event) => {
				if (event.type === "turn/start") return { id: String(event.data.turn), role: "start" };
				if (event.type === "tool/call") return { id: String(event.data.turn), role: "update" };
				if (event.type === "tool/result" && event.surfaceOp === "append") {
					const turn = turnByCallId.get(String(event.data.message.source.callId));
					if (turn === void 0) return null;
					return { id: String(turn), role: "update" };
				}
				return null;
			},
			start: (_context, match) => {
				if (match.event.type !== "turn/start") throw new Error("turn-artifacts start requires turn/start");
				return { turn: match.event.data.turn };
			},
			update: (context, match) => {
				const phase = context.state;
				/**
				 * A history window can begin mid-turn: the `turn/start` that would have
				 * seeded this state sits outside the loaded page, so an update-role match
				 * can arrive before any phase exists. Nothing can be attributed to a turn
				 * this definition never saw, and returning early keeps the assembler
				 * alive — reading `phase.turn` here (or in buildLocationData below) threw
				 * "Cannot read properties of undefined (reading 'turn')", which killed the
				 * session event feed and left the whole transcript empty.
				 */
				if (phase === void 0 || phase === null) return phase;
				if (match.event.type === "tool/call") {
					const callId = String(match.event.data.callId);
					turnByCallId.set(callId, phase.turn);
					for (const path of collectCallPaths(match.event.data.name, match.event.data.arguments)) {
						addPath(artifactByTurn, phase.turn, path);
					}
					const authored = mutationPath(match.event.data.name, match.event.data.arguments);
					if (authored !== null) pendingMutations.set(callId, { turn: phase.turn, path: authored });
					return phase;
				}
				if (match.event.type !== "tool/result") return phase;
				const callId = String(match.event.data.message.source.callId);
				/**
				 * A failed result reports what the call tried, not what it produced,
				 * so it contributes neither a mutation nor an artifact.
				 */
				if (match.event.data.message.content[0].isError === true) {
					pendingMutations.delete(callId);
					return phase;
				}
				const pending = pendingMutations.get(callId);
				if (pending !== void 0) {
					pendingMutations.delete(callId);
					addPath(authoredByTurn, pending.turn, pending.path);
					addPath(artifactByTurn, pending.turn, pending.path);
				}
				const turn = turnByCallId.get(callId);
				if (turn === void 0) return phase;
				for (const path of collectPaths(resultText(match.event.data.message.content))) {
					addPath(artifactByTurn, turn, path);
				}
				return phase;
			},
			buildLocationData: (context, scope, previous) => {
				if (scope !== "turn") return null;
				/**
				 * Never read `context.state` unguarded: `replaceLocationData()` runs over
				 * every context, including one whose only matches are updates from a
				 * mid-turn window start, where state is still undefined. The shipped chat
				 * definitions guard the same way and fall back to the context location, so
				 * do the same: `start.location` carries the turn even without state.
				 */
				const state = context.state;
				const location = context.start?.location ?? context.matches.at(-1)?.location;
				/**
				 * A location's `turn` is the Turn *object* (the shipped definitions read
				 * `turn.turn` for the number), while this state's `turn` is already the
				 * number. Normalize both to the number the assembler validates, and
				 * publish nothing when neither is available.
				 */
				const locationTurn = location?.kind === "turn" || location?.kind === "step" ? location.turn : void 0;
				const turn = state !== void 0 && state !== null
					? state.turn
					: typeof locationTurn === "number" ? locationTurn : locationTurn?.turn;
				if (!Number.isSafeInteger(turn) || turn < 0) return null;
				const artifacts = pathsOf(artifactByTurn, turn);
				const authored = pathsOf(authoredByTurn, turn);
				const prior = previous !== null && previous !== void 0 && previous.kind === "turn"
					&& previous.key === "turn-artifacts" ? previous.value : void 0;
				if (prior !== void 0 && prior.artifacts === artifacts && prior.authored === authored) return previous;
				return { kind: "turn", turn, key: "turn-artifacts", value: { artifacts, authored } };
			},
		};

		//#endregion

		//#region mention resolution

		/**
		 * Resolve one inline-code token against a turn's evidence.
		 *
		 * Delegates to the first resolver that answers, which is what keeps the
		 * shipped vocabulary authoritative: a token the shipped resolver already
		 * links is answered before this plugin's wider rule is consulted.
		 *
		 * @param resolvers - ordered resolvers, most authoritative first.
		 * @returns a file-mention resolver for the chat view.
		 */
		function chainedMentions(resolvers) {
			const cache = new Map();
			return {
				resolve(value) {
					if (typeof value !== "string") return void 0;
					if (cache.has(value)) return cache.get(value);
					let answer;
					for (const resolver of resolvers) {
						answer = resolver(value);
						if (answer !== void 0) break;
					}
					cache.set(value, answer);
					return answer;
				},
			};
		}

		/**
		 * Whether an indexed path can be the file an inline-code token names.
		 *
		 * @param candidate - indexed path.
		 * @param token - inline-code token from the closing prose.
		 * @returns true for an identical path or an identical trailing segment.
		 */
		function suffixMatch(candidate, token) {
			const candidateKey = pathKey(candidate);
			const tokenKey = pathKey(token);
			if (candidateKey === tokenKey) return true;
			return candidateKey.endsWith("/" + tokenKey) || basename(candidateKey) === basename(tokenKey);
		}

		/**
		 * Rank one candidate against another: an absolute path beats a relative
		 * one, and among equals the shorter spelling wins.
		 *
		 * A recorded absolute path is where the file actually is, so it must never
		 * lose to a relative spelling that would then be resolved against the
		 * session workspace root — that resolution is how a link ends up pointing
		 * at a same-named file in the wrong directory.
		 *
		 * @param candidate - candidate being considered.
		 * @param incumbent - current best.
		 * @returns true when the candidate should replace the incumbent.
		 */
		function beats(candidate, incumbent) {
			const candidateAbsolute = isLocatedPath(candidate) && (/^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith("/") || candidate.startsWith("\\\\"));
			const incumbentAbsolute = isLocatedPath(incumbent) && (/^[A-Za-z]:[\\/]/.test(incumbent) || incumbent.startsWith("/") || incumbent.startsWith("\\\\"));
			if (candidateAbsolute !== incumbentAbsolute) return candidateAbsolute;
			return candidate.length < incumbent.length;
		}

		/**
		 * The indexed path an inline-code token names.
		 *
		 * A token that names nothing stays inert. When several indexed paths carry
		 * the name, the most trustworthy spelling wins by {@link beats}, and only
		 * that one is offered: a link is never chosen by elimination between files
		 * that merely share a name.
		 *
		 * @param paths - indexed paths for the closing turn.
		 * @param token - inline-code token from the closing prose.
		 * @returns the resolved path, or undefined.
		 */
		function resolveToken(paths, token) {
			for (const path of paths) {
				if (pathKey(path) === pathKey(token)) return path;
			}
			const matches = paths.filter((path) => suffixMatch(path, token));
			if (matches.length === 0) return undefined;
			return matches.reduce((best, path) => (beats(path, best) ? path : best));
		}

		/**
		 * File-mention resolver over a closing turn's indexed artifacts.
		 *
		 * Every link it returns opens in the right Sidebar when this composition has
		 * one, which is what the reader asked for: a mention should show the file
		 * beside the conversation, not launch an application. The sidebar is reached
		 * through the same `dsh-resource://file/` address its own file tree uses, so
		 * the tab it produces is an ordinary file tab — right-clickable, with the
		 * actions this plugin adds. A composition without the right Sidebar falls back
		 * to the chat view's own opener, which is what older DSH versions provide.
		 *
		 * @param paths - artifacts indexed for the closing turn.
		 * @param owner - the closing-turn owner currency, carrying the chat opener.
		 * @param ctx - client root context, for the sidebar controller and session cwd.
		 * @param sessionId - viewed Session, forwarded from the chat view.
		 * @returns the resolver offered ahead of the shipped one.
		 */
		function artifactMentions(paths, owner, ctx, sessionId) {
			const openFile = owner.openFile;
			const cwd = sessionCwd(ctx);
			return (value) => {
				const path = resolveToken(paths, value);
				if (path === void 0) return void 0;
				const target = resolveAgainst(cwd, path);
				const relative = pathKey(target) === pathKey(path);
				return {
					open: () => {
						const sidebar = sidebarOpener(ctx, sessionId);
						if (sidebar !== undefined && sidebar(sessionFileAddress(sessionId, target)) === true) return;
						// The Sidebar would not take the address — most often because no
						// column is mounted to receive it. Fall back to the chat view's own
						// opener, and last to the Host's native one, so a click always ends
						// somewhere the reader can see. Silence here is what made 0.5.0's
						// dead links indistinguishable from a click that never arrived.
						if (typeof openFile === "function") {
							try {
								const opened = openFile(target);
								if (opened !== null && opened !== undefined && typeof opened.then === "function") {
									opened.then(undefined, (error) => {
										reportOnce("openFile", error);
										void openPathNatively(ctx, sessionId, target);
									});
								}
								return;
							} catch (error) {
								reportOnce("openFile", error);
							}
						}
						void openPathNatively(ctx, sessionId, target);
					},
					label: `打开 ${path}`,
					title: relative
						? `${displayPath(target)} — 本轮脚本产物（相对工作区定位）`
						: `${displayPath(path)} — 本轮脚本产物`,
				};
			};
		}

		//#endregion

		//#region sidebar integration

		/**
		 * The scheme every file tab in the right Sidebar is addressed by.
		 *
		 * A file tab's `contentId` is one of these, which is what makes the menu
		 * able to recover the path it shows without any registry of its own.
		 */
		const FILE_ADDRESS_PREFIX = "dsh-resource://file/";

		/** Component-encode one address segment, keeping `:` literal for drive letters. */
		function encodeAddressSegment(segment) {
			return encodeURIComponent(segment).replace(/%3A/gi, ":");
		}

		/**
		 * Build the address of one file read through one Session.
		 *
		 * Mirrors the sidebar's own encoder byte for byte: the path is normalized to
		 * forward slashes, then encoded segment by segment so that separators stay
		 * separators.
		 *
		 * @param sessionId - the Session whose Host workspace resolves the path.
		 * @param path - absolute or workspace-relative path.
		 * @returns the `dsh-resource://file/session/<sessionId>/<path>` address.
		 */
		function sessionFileAddress(sessionId, path) {
			const normalized = String(path).replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
			const segments = normalized.split("/").map(encodeAddressSegment).join("/");
			return `${FILE_ADDRESS_PREFIX}session/${encodeAddressSegment(String(sessionId))}/${segments}`;
		}

		/**
		 * Read a file address back into its scope, session, and path.
		 *
		 * A malformed or non-file address returns undefined, which is how a menu item
		 * decides not to offer file actions for a tab that is not a file (the guide,
		 * a page type, anything else).
		 *
		 * @param address - a candidate `dsh-resource://` address.
		 * @returns the decoded parts, or undefined when the address is not a file.
		 */
		function parseFileAddress(address) {
			if (typeof address !== "string" || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined;
			try {
				const cut = address.search(/[?#]/);
				const rest = address.slice(FILE_ADDRESS_PREFIX.length, cut === -1 ? undefined : cut);
				const [scope, ...segments] = rest.split("/");
				if (scope === "session") {
					const [sessionId, ...pathSegments] = segments;
					if (sessionId === undefined || sessionId === "" || pathSegments.length === 0) return undefined;
					return { scope, sessionId: decodeURIComponent(sessionId), path: pathSegments.map(decodeURIComponent).join("/") };
				}
				if (scope === "absolute") {
					const unc = segments[0] === "" && segments.length > 1;
					const decoded = (unc ? segments.slice(1) : segments).map(decodeURIComponent);
					if (decoded.length === 0 || decoded[0] === "") return undefined;
					if (unc) return { scope, path: `//${decoded.join("/")}` };
					return { scope, path: /^[A-Za-z]:$/.test(decoded[0]) ? decoded.join("/") : `/${decoded.join("/")}` };
				}
			} catch {
				return undefined;
			}
			return undefined;
		}

		/** Where one native file action landed, for the item's transient status line. */
		const NATIVE_ACTION_LABELS = { open: "已交给默认软件", reveal: "已在资源管理器中定位" };

		/**
		 * Hand one path to the Host desktop: the default application, or the file
		 * manager when `reveal` is asked for.
		 *
		 * The RPC is the only supported way to reach the native opener from a plugin
		 * (`/api/present.open` is keyed to delivered files and cannot open an
		 * arbitrary tab), and it resolves the path against the addressed Session's
		 * workspace, so a workspace-relative path from the address is passed through
		 * unchanged.
		 *
		 * @param ctx - client root context carrying the session remote.
		 * @param sessionId - session whose workspace resolves the path.
		 * @param path - the tab's path.
		 * @param action - `reveal` for the file manager, omission for the default app.
		 * @returns a status message for the user, never a rejection.
		 */
		async function openPathNatively(ctx, sessionId, path, action) {
			const session = optionalService(ctx, "remote")?.session;
			if (session === undefined || typeof session.openWorkspacePath !== "function") {
				return "此部署没有可用的原生打开器";
			}
			try {
				const result = await session.openWorkspacePath(action === "reveal" ? { path, action } : { path });
				if (result === null || typeof result !== "object") return "原生打开器没有响应";
				return result.ok === true ? NATIVE_ACTION_LABELS[action === "reveal" ? "reveal" : "open"] : `打开失败：${String(result.error?.message ?? "未知原因")}`;
			} catch (error) {
				return `打开失败：${error instanceof Error ? error.message : String(error)}`;
			}
		}

		/**
		 * Two items appended to a file tab's actions menu: open with the default
		 * application, and reveal it in the file manager.
		 *
		 * The menu itself belongs to the sidebar kit, which renders its own layout
		 * actions and calls this registration with the tab and a `dismiss`. Both items
		 * act through {@link openPathNatively} and always dismiss, as the slot contract
		 * requires: a menu left open would float over whatever the action replaced.
		 *
		 * @param props - the tab whose menu is open, and the menu's dismiss.
		 * @returns the two menu entries, or null for a tab that is not a file.
		 */
		function FileTabMenuItems(props) {
			const [status, setStatus] = react.useState("");
			const owner = props.matched ?? props;
			const tab = owner.tab;
			const parts = parseFileAddress(tab?.contentId ?? tab?.address);
			if (parts === undefined) return null;
			const ctx = owner.ctx;
			const run = (action) => {
				owner.dismiss?.();
				const done = openPathNatively(ctx, parts.sessionId, parts.path, action);
				if (typeof done?.then === "function") done.then((message) => setStatus(message)).catch(() => {});
			};
			return react.createElement(react.Fragment, null, [
				react.createElement("button", {
					key: "native-open",
					type: "button",
					role: "menuitem",
					"data-file-tab-action": "open",
					onClick: () => run("open"),
				}, "用默认软件打开"),
				react.createElement("button", {
					key: "reveal",
					type: "button",
					role: "menuitem",
					"data-file-tab-action": "reveal",
					onClick: () => run("reveal"),
				}, "打开文件所在路径"),
				status === "" ? null : react.createElement("span", {
					key: "status",
					"data-file-tab-status": true,
				}, status),
			]);
		}

		/**
		 * Register the file actions menu and return nothing; registration is
		 * effect-owned with the calling fiber.
		 *
		 * Mounting is best-effort by design: a deployment without the right Sidebar
		 * (an older DSH, a headless profile) has no such slot, and the plugin's own
		 * job — script-produced files becoming links — must not depend on it. The
		 * context is threaded through `inject` because a menu item needs the remote,
		 * which is not part of the slot's owner props.
		 *
		 * @param ctx - client root context.
		 */
		function registerFileTabMenu(ctx) {
			if (ctx.slots === undefined || typeof ctx.slots.inject !== "function") return;
			try {
				ctx.slots.inject("sidebar.right.tab.menu.item", () => ctx.slots.register({
					name: "sidebar.right.tab.menu.item",
					id: "turn-artifacts-file-actions",
					order: 10,
					inject: () => ({ ctx }),
				}, FileTabMenuItems));
			} catch {
				// The slot does not exist in this composition; the rest of the plugin
				// still works and simply has no file actions to offer.
			}
		}

		//#endregion

		//#region artifact chips

		/** Pushes the chip stylesheet into the page once. */
		function ensureStyle() {
			const id = "dsh-turn-artifacts/chips.css";
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(id) + "]") !== null) return;
			const style = document.createElement("style");
			style.dataset.plugin = "dsh-turn-artifacts";
			style.dataset.pluginCss = id;
			style.textContent = [
				".dta-root{display:grid;grid-template-columns:max-content minmax(0,1fr);align-items:start;column-gap:8px;margin-top:10px;font-size:13px;line-height:22px}",
				".dta-label{color:var(--dsw-alias-label-tertiary)}",
				".dta-lane{display:flex;flex-wrap:wrap;gap:8px;min-width:0}",
				".dta-file{box-sizing:border-box;min-width:0;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:inherit;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border:none;border-radius:6px;margin:0;padding:0 8px;cursor:pointer}",
				".dta-file:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}",
				".dta-file:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--dsw-alias-border-l3)}",
				".dta-more{color:var(--dsw-alias-label-tertiary)}",
			].join("");
			document.head.appendChild(style);
		}

		/** How many artifact chips render before the remainder counter. */
		const SHOWN_LIMIT = 6;

		/**
		 * Render one closing turn's script-produced files as openable chips.
		 *
		 * The row is the visible half of the same index the prose links use: it
		 * lists what a terminal command produced and the mutation tools did not, so
		 * a delivered binary is reachable even when the closing prose never names
		 * it.
		 *
		 * @param props - matched artifact paths, the openers, and the workspace root.
		 * @returns the artifact row, or null when the turn produced nothing extra.
		 */
		function TurnArtifacts({ matched, ensureWorkspacePathOpen }) {
			react.useEffect(() => {
				if (typeof ensureWorkspacePathOpen === "function") ensureWorkspacePathOpen();
			}, [ensureWorkspacePathOpen]);
			ensureStyle();
			const artifacts = Array.isArray(matched.artifacts) ? matched.artifacts : [];
			const authoredKeys = new Set((Array.isArray(matched.authored) ? matched.authored : []).map(pathKey));
			const produced = artifacts.filter((path) => !authoredKeys.has(pathKey(path)));
			if (produced.length === 0) return null;
			const shown = produced.slice(0, SHOWN_LIMIT);
			const remainder = produced.length - shown.length;
			const chips = shown.map((path) => react.createElement("button", {
				key: path,
				type: "button",
				className: "dta-file",
				title: displayPath(path),
				"aria-label": `打开 ${path}`,
				onClick: () => {
					const target = resolveAgainst(matched.cwd, path);
					if (typeof matched.openInSidebar === "function") {
						matched.openInSidebar(target);
						return;
					}
					Promise.resolve(matched.openFile(target)).catch(() => {});
				},
			}, basename(path)));
			if (remainder > 0) {
				chips.push(react.createElement("span", { key: "+", className: "dta-more" }, `+ ${String(remainder)} 个文件`));
			}
			return react.createElement("div", {
				className: "dta-root",
				"data-turn-artifacts-row": true,
			}, [
				react.createElement("span", { key: "label", className: "dta-label" }, "脚本产物"),
				react.createElement("div", { key: "lane", className: "dta-lane" }, chips),
			]);
		}

		//#endregion

		//#region plugin body

		/** Business key this plugin publishes on every Turn. */
		const TURN_DATA_KEY = "turn-artifacts";

		/** Services this plugin needs before it can mount. */
		const inject = ["slots", "uiConversation", "remote.session", "sessions"];

		/** Names already reported to the console, so one broken service logs once. */
		const reported = new Set();

		/**
		 * Report a failure once per name.
		 *
		 * The plugin runs inside a live GUI, so a warn on every render would bury
		 * the console it is meant to inform; `console.warn` rather than `error`
		 * because every caller treats the failure as a degraded path, not a crash.
		 *
		 * @param key - deduplication key, usually the service or action name.
		 * @param error - what went wrong.
		 */
		function reportOnce(key, error) {
			if (reported.has(key)) return;
			reported.add(key);
			const message = error instanceof Error ? error.message : String(error);
			try {
				console.warn(`[turn-artifacts] ${key}: ${message}`);
			} catch {
				// A console that refuses the write must not break the caller.
			}
		}

		/**
		 * Read a service the plugin did not declare in {@link inject}.
		 *
		 * **This is not defensive style, it is the only safe spelling.** A client
		 * context is a Proxy whose `get` throws `cannot get property "<name>"
		 * without inject` for any service the calling fiber did not declare — the
		 * throw happens on the property *read*, before `?.`, `??`, or a surrounding
		 * `try` in the caller can treat it as "absent". Version 0.5.0 read
		 * `ctx.sidebarRight` directly and every mention click died on that throw.
		 *
		 * `ctx.get(name)` is the documented way to ask for a service that may or may
		 * not exist, and it is how this plugin already reaches `chatFileMentions`.
		 * The direct read stays as a fallback for a build where `get` is narrowed.
		 *
		 * @param ctx - client root context.
		 * @param name - service name.
		 * @returns the service, or undefined when this deployment has none.
		 */
		function optionalService(ctx, name) {
			if (ctx === null || ctx === undefined) return undefined;
			try {
				const viaGet = typeof ctx.get === "function" ? ctx.get(name) : undefined;
				if (viaGet !== undefined && viaGet !== null) return viaGet;
			} catch (error) {
				reportOnce(`ctx.get(${name})`, error);
			}
			try {
				const direct = ctx[name];
				return direct === undefined ? undefined : direct;
			} catch (error) {
				reportOnce(`ctx.${name}`, error);
				return undefined;
			}
		}

		/**
		 * Whether this browser can ask the Host to open a file at all.
		 *
		 * A browser reached through a non-loopback authority has no native opener
		 * behind it, so a row of chips would be a row of buttons that cannot do
		 * anything — and a prose link is worse, because it looks like every other
		 * link. Links still resolve in that case (the resolver is the chat view's
		 * own extension point and cannot be made conditional per render), but the
		 * row is simply not offered.
		 *
		 * @param ctx - client root context.
		 * @returns true when the Host reports a loopback authority.
		 */
		function hostIsLoopback(ctx) {
			try {
				return optionalService(ctx, "remote")?.$host?.isLoopback === true;
			} catch {
				return false;
			}
		}

		/**
		 * Session working directory behind one closing-turn owner.
		 *
		 * The owner hands out the turn but not the session, so the root context's
		 * own session selection is the only source; an unknown session simply
		 * leaves paths workspace-relative, which the Host opener already accepts.
		 *
		 * @param ctx - client root context.
		 * @returns the workspace root, or undefined when it cannot be read.
		 */
		function sessionCwd(ctx) {
			try {
				const current = ctx.sessions?.current;
				if (typeof current === "function") {
					const sessionId = current.call(ctx.sessions);
					const entry = sessionId === void 0 ? void 0 : ctx.sessions?.list?.getSnapshot?.()?.byId?.[sessionId];
					if (entry !== void 0 && typeof entry.cwd === "string") return entry.cwd;
				}
				const list = ctx.sessions?.list?.getSnapshot?.();
				const ids = list === void 0 || list.byId === void 0 ? [] : Object.keys(list.byId);
				if (ids.length === 1) {
					const only = list.byId[ids[0]];
					if (only !== void 0 && typeof only.cwd === "string") return only.cwd;
				}
			} catch {
				return undefined;
			}
			return undefined;
		}

		/**
		 * A function that opens one `dsh-resource://` address in the right Sidebar,
		 * or undefined when this composition has no right Sidebar.
		 *
		 * The controller is a root-scoped service provided by the sidebar package, so
		 * its presence is exactly the question "does this deployment have one" — but
		 * it must be asked through {@link optionalService}, because this plugin does
		 * not (and must not) declare `sidebarRight` in its `inject`: declaring it
		 * would make the whole plugin wait for a sidebar that a headless or older
		 * deployment never provides.
		 *
		 * The returned function answers whether the resource was actually placed.
		 * `openResource` throws in two reachable cases — no session surface is
		 * mounted (the column is not rendered at all), or no tab type claims the
		 * address — and a click that silently does nothing is exactly the bug this
		 * reports instead of hiding.
		 *
		 * @param ctx - client root context.
		 * @param sessionId - Session the address belongs to.
		 * @returns the opener, or undefined.
		 */
		function sidebarOpener(ctx, sessionId) {
			if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
			const sidebar = optionalService(ctx, "sidebarRight");
			if (sidebar === undefined || sidebar === null || typeof sidebar.openResource !== "function") return undefined;
			return (address) => {
				try {
					sidebar.openResource(address);
					return true;
				} catch (error) {
					reportOnce("sidebarRight.openResource", error);
					return false;
				}
			};
		}

		/**
		 * Wrap the shipped `chatFileMentions` provider so this plugin's resolver
		 * answers first for the paths it indexed.
		 *
		 * The shipped provider owns that service by registration, so it cannot be
		 * re-registered or `set` from another fiber; the provider object itself is
		 * the extension point the chat view calls through, and wrapping one method
		 * leaves every other behavior exactly as shipped.
		 *
		 * **Precedence, not fallback.** The plugin used to be asked only after the
		 * shipped resolver declined, which was right while the two vocabularies were
		 * disjoint. They are not anymore: a file the model declared through the
		 * `present` tool is in the shipped vocabulary, and that vocabulary opens it
		 * with the Host's native opener — straight into PowerPoint, not into the
		 * Sidebar the reader asked for. So for a path this plugin has evidence for,
		 * this resolver answers first and routes through the Sidebar; for everything
		 * else the shipped resolver still decides, unchanged.
		 *
		 * The wrapper forwards **every** argument rather than a named one. The
		 * shipped signature grew a second parameter — `forClosing(owner, sessionId)`
		 * — and that sessionId is what `dsh-resource://` addresses are keyed by. A
		 * wrapper that named only `owner` silently handed the shipped resolver an
		 * `undefined` session, so the official vocabulary answered nothing and the
		 * plugin broke the very feature it was extending. Rest arguments make the
		 * wrapper signature-independent.
		 *
		 * @param ctx - client root context.
		 * @returns a disposer restoring the original method.
		 */
		function augmentFileMentions(ctx) {
			let disposer = installWrapper(ctx);
			/**
			 * The shipped provider may not exist yet.
			 *
			 * Client plugins load on demand, in an order this plugin does not control,
			 * and the deliverables package is what provides `chatFileMentions`. When
			 * this plugin applied first, `ctx.get` answered nothing, no wrapper was
			 * installed, and nothing retried until a connection reset — so the
			 * plugin's entire vocabulary was silently absent for the life of the page:
			 * no error, plugin "mounted", links missing. Watching for the service is
			 * what makes the wrapper independent of load order.
			 */
			const onService = (name) => {
				if (name !== "chatFileMentions" || disposer !== undefined) return;
				disposer = installWrapper(ctx);
			};
			// The disposer `ctx.on` returns is the only safe way to unlisten. There is
			// no `ctx.off` on a client context, and reading it throws for the same
			// reason `ctx.sidebarRight` did — which made every connection reset throw
			// out of this rollback, leaving the re-install behind it unrun.
			const stopListening = ctx.on("internal/service", onService);
			return () => {
				if (typeof stopListening === "function") stopListening();
				if (disposer !== undefined) {
					disposer();
					disposer = undefined;
				}
			};
		}

		/**
		 * Wrap the shipped provider when it is available right now.
		 *
		 * @param ctx - client root context.
		 * @returns the restore function, or undefined when there is nothing to wrap.
		 */
		function installWrapper(ctx) {
			const service = ctx.get("chatFileMentions");
			if (service === void 0 || typeof service.forClosing !== "function") return undefined;
			const original = service.forClosing;
			const wrapped = function forClosing(...args) {
				const coreMentions = original.apply(this, args);
				const owner = args[0];
				const turn = owner === null || owner === void 0 ? void 0 : owner.turn?.turn;
				if (typeof turn !== "number") return coreMentions;
				const artifacts = pathsOf(artifactByTurn, turn);
				if (artifacts.length === 0) return coreMentions;
				const mine = artifactMentions(artifacts, owner, ctx, args[1]);
				if (coreMentions === void 0) return chainedMentions([mine]);
				return chainedMentions([mine, (value) => coreMentions.resolve(value)]);
			};
			service.forClosing = wrapped;
			return () => {
				if (service.forClosing === wrapped) service.forClosing = original;
			};
		}

		//#region history autofill

		/**
		 * Whether the history fill runs at all. It runs, and that is load-bearing.
		 *
		 * ## Why this cannot be off
		 *
		 * The client opens a conversation with its newest page only — fifty
		 * messages. The evidence this plugin indexes is tool calls and tool results,
		 * so in any long conversation the turn that produced a file sits far outside
		 * that window, the plugin never sees it, and every historical mention of that
		 * file stays plain text. That failure is silent: no error, the plugin appears
		 * mounted, and the links simply do not exist. A real case measured 8938
		 * events across 50 turns with the producing turns among the first twenty.
		 *
		 * So the fill is what makes historical mentions work at all. Turning it off
		 * costs every conversation longer than one page.
		 *
		 * ## Why it was off for a while
		 *
		 * It was the prime suspect for a different bug: conversations that used to
		 * open fine began rendering an empty transcript, and the affected logs were
		 * 1.6-5.4 MB against 20 KB for the healthy ones, which pointed straight at
		 * paging. The real cause was a crash in `artifactDefinition` — a window that
		 * begins mid-turn leaves `state` undefined, and reading `state.turn` killed
		 * the session event feed, which empties the whole chat area. Big logs only
		 * correlated because a large window is more likely to start mid-turn, and
		 * paging is what produces such a window. With the guards in `update` and
		 * `buildLocationData` in place, filling no longer breaks the transcript; that
		 * was verified in a real browser on a 50-turn session (743 inline blocks
		 * rendered, 33 mentions linked, zero exceptions).
		 *
		 * ## Cost
		 *
		 * Opening one session can pull up to {@link FILL_PAGE_LIMIT} pages of fifty
		 * messages — and every page re-projects and re-renders the whole
		 * conversation, so the cost is quadratic in the log's length while the page's
		 * DOM grows with it. Measured on a real session of 36 turns and 1006 steps,
		 * an unpaced fill took the page from 2.3k to 34.6k DOM nodes in seven
		 * seconds, with ~2.2 seconds of long tasks per 2.5-second window: eleven of
		 * every twelve milliseconds went to the fill, and the page stayed heavy
		 * afterwards.
		 *
		 * That is what version 0.5.1 fixes, with three brakes rather than the one
		 * on/off switch 0.4.x had:
		 *
		 *   * {@link FILL_PAGE_PAUSE_MS} and friends pace the pages, so the browser
		 *     gets a frame between them and a click during a fill still lands.
		 *   * {@link FILL_NODE_BUDGET} stops the fill once the transcript is already
		 *     heavy enough to slow the page down, which is the point at which more
		 *     scrollback costs more than it is worth.
		 *   * `startHistoryAutofill` fills one session at a time and abandons a fill
		 *     the moment the reader moves to another conversation.
		 *
		 * The honest fix — page lazily as the reader scrolls, or index the log
		 * without growing the render window at all — is still not done.
		 */
		const HISTORY_AUTOFILL_ENABLED = true;

		/**
		 * Pages pulled per opened session before giving up.
		 *
		 * The session controller opens a conversation with a single 50-message page
		 * and offers exactly one way to grow it: the view's paging button, 50 more per
		 * click. Nothing refills the rest, so a fresh page load — most visibly right
		 * after a `dsh web` restart — shows only the newest page of a long
		 * conversation. This cap keeps a very large log from turning that into
		 * unbounded work; {@link FILL_NODE_BUDGET} normally stops the fill long
		 * before it.
		 */
		const FILL_PAGE_LIMIT = 60;

		/** Milliseconds to wait before pulling the next page, at minimum. */
		const FILL_PAGE_PAUSE_MS = 250;

		/**
		 * Extra milliseconds of pause per millisecond the previous page took.
		 *
		 * A fixed pause cannot hold: page cost grows with the window, so a constant
		 * 250 ms between an early cheap page and a late expensive one is the
		 * difference between "background work" and "the app is frozen". Scaling the
		 * wait by the measured cost makes the fill give back more time exactly when
		 * it took more, and backs off on its own in a big log.
		 */
		const FILL_BACKOFF = 3;

		/** Ceiling for the back-off, so an expensive log still makes progress. */
		const FILL_MAX_PAUSE_MS = 4000;

		/**
		 * DOM nodes the transcript may reach before the fill stops.
		 *
		 * The fill's product is a page that stays open all day, so the measure that
		 * matters is not how fast the pages arrive but how heavy the page is
		 * afterwards. A conversation with no fill sits at ~2.3k nodes on the measured
		 * machine and the unpaced 0.5.0 fill reached 34.6k; this stops the automatic
		 * fill at roughly five times the empty weight.
		 *
		 * Stopping early costs nothing permanent: history loads as the reader pages
		 * back through it, and every page that arrives indexes its own artifacts, so
		 * a mention becomes a link as soon as the turn around it is on screen. What
		 * the budget gives up is only *pre*-linking turns the reader has not reached.
		 */
		const FILL_NODE_BUDGET = 12000;

		/** How heavy the page is right now, or 0 where there is no DOM to measure. */
		function pageWeight() {
			try {
				return typeof document === "undefined" ? 0 : document.getElementsByTagName("*").length;
			} catch {
				return 0;
			}
		}

		/**
		 * Wait one painted frame.
		 *
		 * A page prepend commits and paints after `loadOlder()` resolves, so a
		 * decision made in the same microtask would measure the window before the
		 * page it just added — and would not yield to the browser either.
		 *
		 * @returns a promise resolved after two animation frames.
		 */
		function nextFrame() {
			return new Promise((resolve) => {
				const schedule = typeof requestAnimationFrame === "function"
					? requestAnimationFrame
					: (callback) => setTimeout(callback, 16);
				schedule(() => schedule(() => resolve()));
			});
		}

		/**
		 * The pause owed after one page, given how long that page took.
		 *
		 * @param elapsedMs - wall time the page's `loadOlder()` plus paint cost.
		 * @returns milliseconds to wait before the next page.
		 */
		function fillPause(elapsedMs) {
			const measured = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
			return Math.min(FILL_MAX_PAUSE_MS, FILL_PAGE_PAUSE_MS + measured * FILL_BACKOFF);
		}

		/**
		 * Resolve the live Session object behind one session id.
		 *
		 * Two lookups, because the documented one is the narrower one. The public
		 * `ISessions` face offers `binding(id)`, whose `SessionBinding.session` is
		 * the same `SessionFace` a feature is allowed to call; the concrete service
		 * additionally exposes `resolve(id)`, which reaches the same object behind
		 * "already listed or already scoped" semantics. Asking for the documented
		 * one first keeps this working if the other is ever made private, and the
		 * fallback keeps it working on a build where `binding` is absent.
		 *
		 * @param sessions - the client `sessions` service.
		 * @param id - session id to resolve.
		 * @returns the session face, or undefined when neither lookup answers.
		 */
		function sessionFaceOf(sessions, id) {
			if (sessions === null || sessions === undefined) return undefined;
			if (typeof sessions.binding === "function") {
				try {
					const binding = sessions.binding(id);
					if (binding !== null && binding !== void 0 && binding.session !== void 0) return binding.session;
				} catch {
					// Fall through to the concrete-service lookup.
				}
			}
			if (typeof sessions.resolve === "function") {
				try {
					const record = sessions.resolve(id);
					if (record !== null && record !== void 0 && record.session !== void 0) return record.session;
				} catch {
					// Neither lookup answered; the caller treats this as "not fillable".
				}
			}
			return undefined;
		}

		/**
		 * Pull one session's window back until it covers the whole log.
		 *
		 * The page size and the open sequence belong to core, and no plugin slot
		 * receives `loadOlder`; what this reaches instead is the Session object the
		 * `sessions` service hands out, and pages it exactly the way the reader's
		 * paging button would.
		 *
		 * Two of the fields it reads are not on the public `ISession` face:
		 *
		 *   * `open()` — public by behavior, absent from the interface: it fetches
		 *     the first page and is a no-op once the session is already open.
		 *   * `hasMore` / `baseSeq` — plain fields on the concrete `Session` class
		 *     that backing the window; `loadOlder()` itself is the public verb.
		 *
		 * They are read defensively, and a build that renames either one degrades
		 * to "no fill" rather than to an error: `hasMore !== true` ends the loop on
		 * the first check, so the worst case is the behavior this plugin found.
		 *
		 * Stops on the first of: the window already reaches the start, the page cap,
		 * or a page that makes no progress — which is how a refused, concurrent, or
		 * stalled prepend ends the loop instead of spinning. Every failure is
		 * swallowed: a session that cannot be filled still renders its first page
		 * exactly as before.
		 *
		 * @param sessions - the client `sessions` service.
		 * @param id - session id to fill.
		 * @param maxPages - page cap for this fill.
		 * @param options - pacing and cancellation; both default to "keep going".
		 * @param options.afterPage - awaited between pages, given the page number
		 * (1-based) and the milliseconds that page cost including its paint.
		 * @param options.shouldContinue - polled between pages; `false` ends the fill.
		 * @returns the number of pages actually prepended.
		 */
		async function fillHistory(sessions, id, maxPages = FILL_PAGE_LIMIT, options = {}) {
			const session = sessionFaceOf(sessions, id);
			if (session === null || session === undefined) return 0;
			if (typeof session.loadOlder !== "function") return 0;
			if (typeof session.open === "function") {
				try {
					await session.open();
				} catch {
					return 0;
				}
			}
			const afterPage = typeof options.afterPage === "function" ? options.afterPage : undefined;
			const shouldContinue = typeof options.shouldContinue === "function" ? options.shouldContinue : undefined;
			let pages = 0;
			while (pages < maxPages) {
				if (shouldContinue !== undefined && !shouldContinue()) break;
				if (session.hasMore !== true) break;
				const before = session.baseSeq;
				const started = Date.now();
				try {
					await session.loadOlder();
				} catch {
					break;
				}
				pages += 1;
				if (session.baseSeq >= before) break;
				await nextFrame();
				if (afterPage !== undefined) await afterPage(pages, Date.now() - started);
			}
			return pages;
		}

		/**
		 * Fill the session the reader opens, one page at a time, once per page load.
		 *
		 * The list store notifies on every membership and selection change, so the
		 * subscription is also what gives a session switched to later the same
		 * treatment. Three rules keep that from turning into a stampede:
		 *
		 *   * **Claimed before the await.** A session enters `handled` the moment a
		 *     fill starts, not when it finishes. The previous version claimed on
		 *     success, so every notification arriving during a fill — and the store
		 *     notifies on selection and membership alike — started another full fill
		 *     of the same session on top of the running one.
		 *   * **Abandoned on a session switch.** The page the reader is looking at is
		 *     the page the fill is allowed to slow down; paging a conversation they
		 *     have left is pure cost. The claim is released on abort so coming back
		 *     resumes where it stopped.
		 *   * **Stopped at {@link FILL_NODE_BUDGET}.** More scrollback is not worth a
		 *     page that stays sluggish for the rest of the day.
		 *
		 * A claim is released when nothing was pulled, deliberately: a session whose
		 * fill cannot start — the transport is mid-reconnect, the open failed, the id
		 * is not resolvable yet — is left unclaimed so the next selection change
		 * retries it. Remembering the attempt instead would strand that session with
		 * its first page for the rest of the page load.
		 *
		 * @param ctx - client root context carrying the `sessions` service.
		 * @returns nothing; the subscription is effect-owned.
		 */
		function startHistoryAutofill(ctx) {
			// On by default, and it has to be: without the fill the plugin never sees
			// tool output from outside the newest page, so historical mentions stop
			// being links. See HISTORY_AUTOFILL_ENABLED above for the full history of
			// why this was briefly off.
			if (!HISTORY_AUTOFILL_ENABLED) return;
			const sessions = ctx.sessions;
			if (sessions === null || sessions === undefined) return;
			const list = sessions.list;
			if (list === null || list === undefined) return;
			if (typeof list.subscribe !== "function" || typeof list.getSnapshot !== "function") return;
			const handled = new Set();
			const filling = new Set();
			let disposed = false;
			/** The session the reader is on, or undefined when the store will not say. */
			const currentId = () => {
				try {
					const current = list.getSnapshot()?.current;
					return typeof current === "string" && current.length > 0 ? current : undefined;
				} catch {
					return undefined;
				}
			};
			const sync = () => {
				if (disposed) return;
				const current = currentId();
				if (current === undefined) return;
				if (handled.has(current) || filling.has(current)) return;
				filling.add(current);
				handled.add(current);
				let abandoned = false;
				void fillHistory(sessions, current, FILL_PAGE_LIMIT, {
					shouldContinue: () => {
						if (disposed || currentId() !== current || pageWeight() >= FILL_NODE_BUDGET) {
							abandoned = true;
							return false;
						}
						return true;
					},
					afterPage: (_page, elapsed) => new Promise((resolve) => {
						setTimeout(resolve, fillPause(elapsed));
					}),
				}).then((pages) => {
					if (disposed) return;
					// Nothing pulled, or the fill stopped short of a finished history:
					// release the claim so a later visit can continue it.
					if (pages === 0 || abandoned) handled.delete(current);
				}).catch((error) => {
					if (!disposed) handled.delete(current);
					reportOnce("fillHistory", error);
				}).finally(() => {
					filling.delete(current);
				});
			};
			const unsubscribe = list.subscribe(sync);
			sync();
			ctx.effect(() => () => {
				disposed = true;
				unsubscribe();
			}, "turn-artifacts: history autofill subscription");
		}

		//#endregion

		/**
		 * Client plugin body: index turn artifacts, offer them to the chat view's
		 * prose links and its turn tail, and add the file-tab menu actions.
		 *
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ensureStyle();
			ctx.uiConversation.events.register(artifactDefinition);
			startHistoryAutofill(ctx);
			registerFileTabMenu(ctx);
			let rollback = augmentFileMentions(ctx);
			ctx.on("connection/reset", () => {
				rollback();
				rollback = augmentFileMentions(ctx);
			});
			ctx.effect(() => () => {
				rollback();
			}, "turn-artifacts: chatFileMentions wrapper");
			ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
				name: "conversation.chat.turnTail",
				select(owner) {
					if (!hostIsLoopback(ctx)) return null;
					const data = owner.turn.data.get(TURN_DATA_KEY);
					if (data === void 0) return null;
					const artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
					const authored = Array.isArray(data.authored) ? data.authored : [];
					if (artifacts.length === 0) return null;
					const authoredKeys = new Set(authored.map(pathKey));
					if (!artifacts.some((path) => !authoredKeys.has(pathKey(path)))) return null;
					const sidebar = sidebarOpener(ctx, owner.sessionId);
					return {
						artifacts,
						authored,
						openFile: owner.openFile,
						cwd: sessionCwd(ctx),
						openInSidebar: sidebar === void 0
							? undefined
							: (target) => sidebar(sessionFileAddress(owner.sessionId, target)),
					};
				},
				inject: () => ({ ensureWorkspacePathOpen: () => {} }),
			}, TurnArtifacts));
		}

		//#endregion

		//#region module exports

		/**
		 * The two names the module system reads.
		 *
		 * A client bundle is a factory, not an ES module: the loader calls
		 * `factory(require)` and uses the returned object, so `apply` and `inject`
		 * are the entire public surface the plugin tree touches.
		 */
		exports.apply = apply;
		exports.inject = inject;

		/**
		 * Everything below is a test seam, not API.
		 *
		 * The bundle is not an importable module, so the only way `test/harness.mjs`
		 * and `test/probe.mjs` can reach a pure function is through these exports.
		 * They are deliberately small and pure, and they are what let the evidence
		 * rules be asserted without a browser: `test/probe.mjs` prints their output
		 * for a human, the harness asserts it. Nothing in the running GUI reads
		 * them, so renaming one breaks tests rather than users.
		 *
		 * `resultText` earns its place the hard way: it is the function that read
		 * the wrong nesting level for months while every fixture-backed check
		 * passed. Exporting it is what makes the real wire shape assertable.
		 */
		exports.TurnArtifacts = TurnArtifacts;
		exports.collectPaths = collectPaths;
		exports.collectCallPaths = collectCallPaths;
		exports.mutationPath = mutationPath;
		exports.resolveToken = resolveToken;
		exports.resultText = resultText;
		exports.fillHistory = fillHistory;
		exports.FILL_PAGE_LIMIT = FILL_PAGE_LIMIT;
		exports.FILL_NODE_BUDGET = FILL_NODE_BUDGET;
		exports.fillPause = fillPause;
		exports.optionalService = optionalService;
		exports.sessionFileAddress = sessionFileAddress;
		exports.parseFileAddress = parseFileAddress;
		exports.FileTabMenuItems = FileTabMenuItems;

		//#endregion

		return module.exports;
	},
});


