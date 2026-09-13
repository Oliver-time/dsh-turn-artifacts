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
		 * Reached only after the shipped resolver declined, so every link it
		 * returns names a file the shipped vocabulary could not: one a terminal
		 * command produced during this turn.
		 *
		 * @param paths - artifacts indexed for the closing turn.
		 * @param openFile - the chat view's file opener.
		 * @param cwd - session workspace root, when known.
		 * @returns the resolver appended after the shipped one.
		 */
		function artifactMentions(paths, openFile, cwd) {
			return (value) => {
				const path = resolveToken(paths, value);
				if (path === void 0) return void 0;
				const target = resolveAgainst(cwd, path);
				const relative = pathKey(target) === pathKey(path);
				return {
					open: () => {
						Promise.resolve(openFile(target)).catch(() => {});
					},
					label: `打开 ${path}`,
					title: relative
						? `${displayPath(target)} — 本轮脚本产物（相对工作区定位）`
						: `${displayPath(path)} — 本轮脚本产物`,
				};
			};
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
		 * @param props - matched artifact paths and the chat file opener.
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
					Promise.resolve(matched.openFile(resolveAgainst(matched.cwd, path))).catch(() => {});
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
				return ctx.remote?.$host?.isLoopback === true;
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
		 * Wrap the shipped `chatFileMentions` provider so this plugin's resolver
		 * runs after it.
		 *
		 * The shipped provider owns that service by registration, so it cannot be
		 * re-registered or `set` from another fiber; the provider object itself is
		 * the extension point the chat view calls through, and wrapping one method
		 * leaves every other behavior exactly as shipped.
		 *
		 * @param ctx - client root context.
		 * @returns a disposer restoring the original method.
		 */
		function augmentFileMentions(ctx) {
			const service = ctx.get("chatFileMentions");
			if (service === void 0 || typeof service.forClosing !== "function") return () => {};
			const original = service.forClosing;
			const wrapped = function forClosing(owner) {
				const coreMentions = original.call(this, owner);
				const artifacts = pathsOf(artifactByTurn, owner.turn.turn);
				if (artifacts.length === 0) return coreMentions;
				const mine = artifactMentions(artifacts, owner.openFile, sessionCwd(ctx));
				if (coreMentions === void 0) return chainedMentions([mine]);
				return chainedMentions([(value) => coreMentions.resolve(value), mine]);
			};
			service.forClosing = wrapped;
			return () => {
				if (service.forClosing === wrapped) service.forClosing = original;
			};
		}

		//#region history autofill

		/**
		 * Whether the history fill runs at all.
		 *
		 * OFF, but no longer because it was guilty of anything. It was the prime
		 * suspect for a while — conversations that used to open fine started
		 * rendering an empty transcript, and the affected logs were 1.6-5.4 MB
		 * against 20 KB for the healthy ones, which pointed straight at paging. The
		 * actual cause was a crash in `artifactDefinition` (see the guards in its
		 * `update` and `buildLocationData`): a window that begins mid-turn leaves
		 * `state` undefined, and reading `state.turn` killed the session event feed,
		 * which empties the whole chat area. Big logs only correlated because their
		 * window is more likely to start mid-turn.
		 *
		 * With that fixed, the fill has no known defect: it calls the same
		 * `loadOlder()` the reader's paging button calls. It stays off on cost
		 * grounds — opening one session can pull up to {@link FILL_PAGE_LIMIT} pages
		 * of 50 messages, thousands of events, against a benefit most readers never
		 * asked for.
		 *
		 * Nothing in the plugin's actual purpose — clickable script artifacts —
		 * depends on this region, so leaving it off costs only the larger initial
		 * window. Turn it on if you want it and have looked at your own log sizes; a
		 * better version would page lazily as the reader scrolls up instead of
		 * racing to the start of the log on open.
		 */
		const HISTORY_AUTOFILL_ENABLED = false;

		/**
		 * Pages pulled per opened session before giving up.
		 *
		 * The session controller opens a conversation with a single 50-message page
		 * and offers exactly one way to grow it: the view's paging button, 50 more per
		 * click. Nothing refills the rest, so a fresh page load — most visibly right
		 * after a `dsh web` restart — shows only the newest page of a long
		 * conversation. This cap keeps a very large log from turning that into
		 * unbounded work.
		 */
		const FILL_PAGE_LIMIT = 60;

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
		 * @returns the number of pages actually prepended.
		 */
		async function fillHistory(sessions, id, maxPages = FILL_PAGE_LIMIT) {
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
			let pages = 0;
			while (pages < maxPages) {
				if (session.hasMore !== true) break;
				const before = session.baseSeq;
				try {
					await session.loadOlder();
				} catch {
					break;
				}
				pages += 1;
				if (session.baseSeq >= before) break;
			}
			return pages;
		}

		/**
		 * Fill each session the reader opens, once per page load.
		 *
		 * The list store notifies on every membership and selection change, so the
		 * subscription is also what gives a session switched to later the same
		 * treatment; a session that actually filled is remembered so returning to it
		 * does not page it twice.
		 *
		 * Remembering only on progress is deliberate. A session whose fill cannot
		 * start — the transport is mid-reconnect, the open failed, the id is not
		 * resolvable yet — is left unremembered so the next selection change retries
		 * it. Remembering the attempt instead would strand that session with its
		 * first page for the rest of the page load.
		 *
		 * @param ctx - client root context carrying the `sessions` service.
		 * @returns nothing; the subscription is effect-owned.
		 */
		function startHistoryAutofill(ctx) {
			// Off by default on cost grounds, not because the fill was ever proven
			// wrong: the empty transcripts that made it a suspect came from the crash
			// guarded in `artifactDefinition`. See HISTORY_AUTOFILL_ENABLED above and
			// the README section "修过的两个问题（v0.4.0）".
			if (!HISTORY_AUTOFILL_ENABLED) return;
			const sessions = ctx.sessions;
			if (sessions === null || sessions === undefined) return;
			const list = sessions.list;
			if (list === null || list === undefined) return;
			if (typeof list.subscribe !== "function" || typeof list.getSnapshot !== "function") return;
			const handled = new Set();
			let disposed = false;
			const sync = () => {
				if (disposed) return;
				let current;
				try {
					current = list.getSnapshot()?.current;
				} catch {
					return;
				}
				if (typeof current !== "string" || current.length === 0) return;
				if (handled.has(current)) return;
				void fillHistory(sessions, current).then((pages) => {
					if (disposed) return;
					if (pages > 0) handled.add(current);
				}).catch(() => {});
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
		 * Client plugin body: index turn artifacts, then offer them to the chat view's
		 * prose links and its turn tail, and fill each opened session's history window.
		 *
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			ensureStyle();
			ctx.uiConversation.events.register(artifactDefinition);
			startHistoryAutofill(ctx);
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
					return { artifacts, authored, openFile: owner.openFile, cwd: sessionCwd(ctx) };
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

		//#endregion

		return module.exports;
	},
});


