import { existsSync, readFileSync, rmSync, statSync, readdirSync, openSync, readSync, closeSync, realpathSync, mkdirSync, lstatSync, unlinkSync, mkdtempSync, chmodSync, writeFileSync, readlinkSync, constants as fsConstants } from "node:fs";
import { lstat, open, opendir, realpath, rm } from "node:fs/promises";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, hostname } from "node:os";
import { basename, dirname, extname, join, resolve as resolvePath, sep as pathSep } from "node:path";
import { activityMonitor } from "./activity.ts";
import type { ExtractedContent } from "./extract.ts";
import { checkGhAvailable, checkRepoSize, fetchViaApi, showGhHint } from "./github-api.ts";
import { parseConfigRoot } from "./utils.ts";

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

const BINARY_EXTENSIONS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg", ".tiff", ".tif",
	".mp3", ".mp4", ".avi", ".mov", ".mkv", ".flv", ".wmv", ".wav", ".ogg", ".webm", ".flac", ".aac",
	".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".zst",
	".exe", ".dll", ".so", ".dylib", ".bin", ".o", ".a", ".lib",
	".woff", ".woff2", ".ttf", ".otf", ".eot",
	".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
	".sqlite", ".db", ".sqlite3",
	".pyc", ".pyo", ".class", ".jar", ".war",
	".iso", ".img", ".dmg",
]);

const NOISE_DIRS = new Set([
	"node_modules", "vendor", ".next", "dist", "build", "__pycache__",
	".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
	"target", ".gradle", ".idea", ".vscode",
]);

const MAX_INLINE_FILE_CHARS = 100_000;
const MAX_TREE_ENTRIES = 200;

export interface GitHubUrlInfo {
	owner: string;
	repo: string;
	ref?: string;
	refIsFullSha: boolean;
	path?: string;
	type: "root" | "blob" | "tree";
}

interface CachedClone {
	destination: CloneDestination;
	clonePromise: Promise<string | null>;
}

interface CloneDestination {
	rootPath: string;
	localPath: string;
}

interface CloneRuntime {
	parentPath: string;
	rootPath: string;
	dev: number;
	ino: number;
}

export interface GitHubCloneSession {
	cache: Map<string, CachedClone>;
	controller: AbortController;
	runtime: CloneRuntime | null;
	sweep?: Promise<void>;
	disposal?: Promise<void>;
}

export function createGitHubCloneSession(): GitHubCloneSession {
	return { cache: new Map(), controller: new AbortController(), runtime: null };
}

interface GitHubCloneConfig {
	enabled: boolean;
	maxRepoSizeMB: number;
	cloneTimeoutSeconds: number;
	clonePath: string;
}

let defaultCloneSession = createGitHubCloneSession();

let cachedConfig: GitHubCloneConfig | null = null;

function normalizeEnabled(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return value > 0 ? value : fallback;
}

function normalizeClonePath(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : fallback;
}

function loadGitHubConfig(): GitHubCloneConfig {
	if (cachedConfig) return cachedConfig;

	const defaults: GitHubCloneConfig = {
		enabled: true,
		maxRepoSizeMB: 350,
		cloneTimeoutSeconds: 30,
		clonePath: "/tmp/pi-github-repos",
	};

	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = defaults;
		return cachedConfig;
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: { githubClone?: { enabled?: unknown; maxRepoSizeMB?: unknown; cloneTimeoutSeconds?: unknown; clonePath?: unknown } };
	try {
		raw = parseConfigRoot(rawText) as typeof raw;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	const gc = raw.githubClone ?? {};
	cachedConfig = {
		enabled: normalizeEnabled(gc.enabled, defaults.enabled),
		maxRepoSizeMB: normalizePositiveNumber(gc.maxRepoSizeMB, defaults.maxRepoSizeMB),
		cloneTimeoutSeconds: normalizePositiveNumber(gc.cloneTimeoutSeconds, defaults.cloneTimeoutSeconds),
		clonePath: normalizeClonePath(gc.clonePath, defaults.clonePath),
	};
	return cachedConfig;
}

const NON_CODE_SEGMENTS = new Set([
	"issues", "pull", "pulls", "discussions", "releases", "wiki",
	"actions", "settings", "security", "projects", "graphs",
	"compare", "commits", "tags", "branches", "stargazers",
	"watchers", "network", "forks", "milestone", "labels",
	"packages", "codespaces", "contribute", "community",
	"sponsors", "invitations", "notifications", "insights",
]);

export function parseGitHubUrl(url: string): GitHubUrlInfo | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}

	const host = parsed.hostname.toLowerCase();
	if (host !== "github.com" && host !== "www.github.com") return null;

	const segments: string[] = [];
	for (const segment of parsed.pathname.split("/").filter(Boolean)) {
		try {
			segments.push(decodeURIComponent(segment));
		} catch {
			return null;
		}
	}
	if (segments.length < 2) return null;

	const owner = segments[0];
	const repo = segments[1].replace(/\.git$/, "");
	if (!owner || /[^A-Za-z0-9-]|^-|-$|--/.test(owner)) return null;
	if (!repo || /[^A-Za-z0-9._-]/.test(repo) || repo === "." || repo === "..") return null;

	if (NON_CODE_SEGMENTS.has(segments[2]?.toLowerCase())) return null;

	if (segments.length === 2) {
		return { owner, repo, refIsFullSha: false, type: "root" };
	}

	const action = segments[2];
	if (action !== "blob" && action !== "tree") return null;
	if (segments.length < 4) return null;

	const ref = segments[3];
	if (/[\0-\x1f\x7f]/.test(ref)) return null;
	const refIsFullSha = /^[0-9a-f]{40}$/.test(ref);
	const pathParts = segments.slice(4);
	const path = pathParts.length > 0 ? pathParts.join("/") : "";

	return {
		owner,
		repo,
		ref,
		refIsFullSha,
		path,
		type: action as "blob" | "tree",
	};
}

function cacheKey(owner: string, repo: string, ref?: string): string {
	return ref ? `${owner}/${repo}@${ref}` : `${owner}/${repo}`;
}

interface CloneRuntimeOwner {
	version: 1;
	pid: number;
	platform: NodeJS.Platform;
	hostname: string;
	bootId?: string;
	pidNamespace?: string;
}

function currentRuntimeOwner(): CloneRuntimeOwner {
	const owner: CloneRuntimeOwner = { version: 1, pid: process.pid, platform: process.platform, hostname: hostname() };
	if (process.platform === "linux") {
		try {
			owner.bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			owner.pidNamespace = readlinkSync("/proc/self/ns/pid");
		} catch (err) {
			if (!expectedCleanupError(err)) throw err;
			// Without the local boot/namespace identity, Linux ownership stays unknown.
		}
	} else if (process.platform === "darwin") {
		try {
			owner.bootId = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		} catch (err) {
			if (!expectedCleanupError(err) && (err as { status?: number }).status === undefined) throw err;
			console.error("[pi-web-access] Local boot identity unavailable; stale clone runtimes will be preserved.");
		}
	}
	return owner;
}

function expectedCleanupError(err: unknown): boolean {
	return ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes((err as NodeJS.ErrnoException)?.code ?? "");
}

function cloneRuntimeIsOwned(runtime: CloneRuntime): boolean {
	const { parentPath, rootPath, dev, ino } = runtime;
	if (dirname(rootPath) !== parentPath || !basename(rootPath).startsWith("runtime-")) throw new Error("Invalid clone runtime");
	if (realpathSync(parentPath) !== parentPath || realpathSync(rootPath) !== rootPath) return false;
	const entry = lstatSync(rootPath);
	return entry.isDirectory() && !entry.isSymbolicLink() && entry.dev === dev && entry.ino === ino;
}

function removeCloneRuntime(runtime: CloneRuntime): void {
	try {
		if (cloneRuntimeIsOwned(runtime)) rmSync(runtime.rootPath, { recursive: true, force: true });
	} catch (err) {
		if (!expectedCleanupError(err)) throw err;
	}
}

async function sweepStaleCloneRuntimes(parentPath: string, local: CloneRuntimeOwner): Promise<void> {
	if (!local.bootId || (process.platform === "linux" && !local.pidNamespace)) return;
	// The read budget is the emitted v1 local envelope with the largest Node/OS PID,
	// not an age/count policy. A different host, namespace or schema is not ours to prune.
	const maxBytes = Buffer.byteLength(JSON.stringify({ ...local, pid: 0x7fffffff }));
	const oversized = (observed: number) => console.error(`[pi-web-access] Clone owner metadata read budget exceeded (configured: ${maxBytes} bytes; observed: ${observed} bytes). Preserving unknown runtime; inspect it manually. Recompute the v1 envelope budget if its schema changes.`);
	let directory: Awaited<ReturnType<typeof opendir>>;
	try { directory = await opendir(parentPath); }
	catch (err) { if (expectedCleanupError(err)) return; throw err; }
	for await (const candidate of directory) {
		if (!candidate.name.startsWith("runtime-") || !candidate.isDirectory() || candidate.isSymbolicLink()) continue;
		const rootPath = join(parentPath, candidate.name);
		try {
			if (await realpath(parentPath) !== parentPath || await realpath(rootPath) !== rootPath) continue;
			const entry = await lstat(rootPath);
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			const ownerPath = join(rootPath, ".owner.json");
			const metadata = await lstat(ownerPath);
			if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
			if (metadata.size > maxBytes) { oversized(metadata.size); continue; }
			const file = await open(ownerPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
			let owner: unknown;
			try {
				const opened = await file.stat();
				if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) continue;
				if (opened.size > maxBytes) { oversized(opened.size); continue; }
				const buffer = Buffer.alloc(maxBytes + 1);
				let bytes = 0;
				while (bytes < buffer.length) {
					const { bytesRead } = await file.read(buffer, bytes, buffer.length - bytes, bytes);
					if (!bytesRead) break;
					bytes += bytesRead;
				}
				if (bytes > maxBytes) { oversized(bytes); continue; }
				try { owner = JSON.parse(buffer.toString("utf8", 0, bytes)); }
				catch (err) { if (err instanceof SyntaxError) continue; throw err; }
			} finally {
				await file.close();
			}
			if (!owner || typeof owner !== "object" || Array.isArray(owner)) continue;
			const record = owner as Record<string, unknown>;
			if (record.version !== local.version || record.platform !== local.platform || record.hostname !== local.hostname
				|| !Number.isInteger(record.pid) || (record.pid as number) <= 0 || (record.pid as number) > 0x7fffffff
				|| record.bootId !== local.bootId || record.pidNamespace !== local.pidNamespace
				|| Object.keys(record).some((key) => !Object.hasOwn(local, key))) continue;
			let dead = false;
			try { process.kill(record.pid as number, 0); }
			catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ESRCH") dead = true;
				else if (!expectedCleanupError(err)) throw err;
			}
			// A reused PID is conservatively live; no age or name can prove death.
			const runtime = { parentPath, rootPath, dev: entry.dev, ino: entry.ino };
			if (dead && cloneRuntimeIsOwned(runtime)) await rm(rootPath, { recursive: true, force: true });
		} catch (err) {
			if (!expectedCleanupError(err)) throw err;
		}
	}
}

function cloneDestination(config: GitHubCloneConfig, session: GitHubCloneSession, owner: string, repo: string, ref?: string): CloneDestination | null {
	if (!session.runtime) {
		let runtime: CloneRuntime | undefined;
		try {
			const configuredRoot = resolvePath(config.clonePath);
			mkdirSync(configuredRoot, { recursive: true });
			const parentPath = realpathSync(configuredRoot);
			const rootPath = mkdtempSync(join(parentPath, "runtime-"));
			const entry = lstatSync(rootPath);
			runtime = { parentPath, rootPath, dev: entry.dev, ino: entry.ino };
			chmodSync(rootPath, 0o700);
			const owner = currentRuntimeOwner();
			writeFileSync(join(rootPath, ".owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
			session.runtime = runtime;
			session.sweep ??= sweepStaleCloneRuntimes(parentPath, owner);
			session.sweep.catch((err) => {
				console.error(`[pi-web-access] Stale clone cleanup failed (${(err as NodeJS.ErrnoException)?.code ?? "unexpected error"}); unknown runtimes were preserved.`);
			});
		} catch (err) {
			if (runtime) removeCloneRuntime(runtime);
			if (!err || typeof err !== "object" || !("code" in err)) throw err;
			return null;
		}
	}
	const { rootPath } = session.runtime;
	const digest = createHash("sha256").update(JSON.stringify([owner, repo, ref ?? null])).digest("hex");
	return { rootPath, localPath: join(rootPath, digest) };
}

function releaseEmptyRuntime(session: GitHubCloneSession): void {
	if (session.cache.size || !session.runtime) return;
	removeCloneRuntime(session.runtime);
	session.runtime = null;
}

function removeCloneDestination(destination: CloneDestination): boolean {
	const rootPath = resolvePath(destination.rootPath);
	const localPath = resolvePath(destination.localPath);
	if (dirname(localPath) !== rootPath || !/^[0-9a-f]{64}$/.test(basename(localPath))) {
		throw new Error("Invalid clone-cache destination");
	}
	try {
		// A cache root replaced after cloning must not redirect destructive cleanup.
		if (realpathSync(rootPath) !== rootPath) return false;
		const entry = lstatSync(localPath);
		if (entry.isSymbolicLink()) unlinkSync(localPath);
		else rmSync(localPath, { recursive: true, force: true });
		return true;
	} catch (err) {
		return !!err && typeof err === "object" && "code" in err && err.code === "ENOENT";
	}
}

// Cooperative fixture trees exited within 19 ms; allow headroom before forcing resistant helpers.
const PROCESS_KILL_GRACE_MS = 250;

async function terminateProcessTree(child: ChildProcess): Promise<void> {
	const pid = child.pid;
	if (!pid) return;
	if (process.platform === "win32") {
		await new Promise<void>((resolve, reject) => {
			execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, (err) => {
				if (err) {
					child.kill("SIGKILL");
					reject(err);
				} else resolve();
			});
		});
		return;
	}

	const killGroup = (signal: NodeJS.Signals) => {
		try {
			process.kill(-pid, signal);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
		}
	};
	killGroup("SIGTERM");
	// Keep the grace timer referenced and awaited even if the root exits before its helpers.
	await new Promise<void>((resolve) => setTimeout(resolve, PROCESS_KILL_GRACE_MS));
	killGroup("SIGKILL");
}

async function execClone(args: string[], destination: CloneDestination, timeoutMs: number, signal?: AbortSignal): Promise<string | null> {
	if (signal?.aborted) return null;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		const success = await new Promise<boolean>((resolve, reject) => {
			let settled = false;
			let termination: Promise<void> | undefined;
			const finish = (success: boolean) => {
				if (settled) return;
				settled = true;
				if (termination) termination.then(() => resolve(false), reject);
				else resolve(success);
			};
			const child = spawn(args[0], args.slice(1), {
				detached: process.platform !== "win32",
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GCM_INTERACTIVE: "Never", GH_PROMPT_DISABLED: "1" },
				stdio: "ignore",
				windowsHide: true,
			});
			child.once("error", () => finish(false));
			child.once("close", (code) => finish(code === 0));
			onAbort = () => {
				if (settled || termination) return;
				termination = terminateProcessTree(child);
				termination.catch(reject);
			};
			timeout = setTimeout(onAbort, timeoutMs);
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
		if (!success) {
			removeCloneDestination(destination);
			return null;
		}
		return destination.localPath;
	} finally {
		if (timeout) clearTimeout(timeout);
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
	}
}

async function cloneRepo(
	owner: string,
	repo: string,
	ref: string | undefined,
	config: GitHubCloneConfig,
	destination: CloneDestination,
	signal?: AbortSignal,
): Promise<string | null> {
	const { localPath } = destination;
	if (!removeCloneDestination(destination)) return null;

	const timeoutMs = config.cloneTimeoutSeconds * 1000;
	const hasGh = await checkGhAvailable();

	if (hasGh) {
		const args = ["gh", "repo", "clone", `${owner}/${repo}`, localPath, "--", "--depth", "1", "--single-branch"];
		if (ref) args.push("--branch", ref);
		return execClone(args, destination, timeoutMs, signal);
	}

	showGhHint();

	const gitUrl = `https://github.com/${owner}/${repo}.git`;
	const args = ["git", "clone", "--depth", "1", "--single-branch"];
	if (ref) args.push("--branch", ref);
	args.push(gitUrl, localPath);
	return execClone(args, destination, timeoutMs, signal);
}

function isBinaryFile(filePath: string): boolean {
	const ext = extname(filePath).toLowerCase();
	if (BINARY_EXTENSIONS.has(ext)) return true;

	let fd: number;
	try {
		fd = openSync(filePath, "r");
	} catch {
		return false;
	}
	try {
		const buf = Buffer.alloc(512);
		const bytesRead = readSync(fd, buf, 0, 512, 0);
		for (let i = 0; i < bytesRead; i++) {
			if (buf[i] === 0) return true;
		}
	} catch {
		return false;
	} finally {
		closeSync(fd);
	}

	return false;
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function resolveWithinRepo(rootPath: string, relativePath: string): string | null {
	const normalizedRoot = resolvePath(rootPath);
	const candidate = resolvePath(normalizedRoot, relativePath);
	if (candidate !== normalizedRoot) {
		const rootPrefix = normalizedRoot.endsWith(pathSep) ? normalizedRoot : normalizedRoot + pathSep;
		if (!candidate.startsWith(rootPrefix)) return null;
	}

	if (!existsSync(candidate)) return candidate;

	try {
		const realRoot = realpathSync(normalizedRoot);
		const realCandidate = realpathSync(candidate);
		if (realCandidate === realRoot) return candidate;
		const realRootPrefix = realRoot.endsWith(pathSep) ? realRoot : realRoot + pathSep;
		return realCandidate.startsWith(realRootPrefix) ? candidate : null;
	} catch {
		return null;
	}
}

function readTextFile(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

function buildTree(rootPath: string): string {
	const entries: string[] = [];

	function walk(dir: string, relPath: string): void {
		if (entries.length >= MAX_TREE_ENTRIES) return;

		let items: string[];
		try {
			items = readdirSync(dir).sort();
		} catch {
			return;
		}

		for (const item of items) {
			if (entries.length >= MAX_TREE_ENTRIES) return;
			if (item === ".git") continue;

			const rel = relPath ? `${relPath}/${item}` : item;
			const safePath = resolveWithinRepo(rootPath, rel);
			if (!safePath) {
				entries.push(`${rel}  [outside repo skipped]`);
				continue;
			}

			let stat;
			try {
				stat = statSync(safePath);
			} catch {
				continue;
			}

			if (stat.isDirectory()) {
				if (NOISE_DIRS.has(item)) {
					entries.push(`${rel}/  [skipped]`);
					continue;
				}
				entries.push(`${rel}/`);
				walk(safePath, rel);
			} else {
				entries.push(rel);
			}
		}
	}

	walk(rootPath, "");

	if (entries.length >= MAX_TREE_ENTRIES) {
		entries.push(`... (truncated at ${MAX_TREE_ENTRIES} entries)`);
	}

	return entries.join("\n");
}

function buildDirListing(rootPath: string, subPath: string): string {
	const targetPath = resolveWithinRepo(rootPath, subPath);
	if (!targetPath) return "(path escapes repository root)";
	const lines: string[] = [];

	let items: string[];
	try {
		items = readdirSync(targetPath).sort();
	} catch {
		return "(directory not readable)";
	}

	for (const item of items) {
		if (item === ".git") continue;
		const rel = subPath ? `${subPath}/${item}` : item;
		const safePath = resolveWithinRepo(rootPath, rel);
		if (!safePath) {
			lines.push(`  ${item}  (outside repo)`);
			continue;
		}
		try {
			const stat = statSync(safePath);
			if (stat.isDirectory()) {
				lines.push(`  ${item}/`);
			} else {
				lines.push(`  ${item}  (${formatFileSize(stat.size)})`);
			}
		} catch {
			lines.push(`  ${item}  (unreadable)`);
		}
	}

	return lines.join("\n");
}

function readReadme(localPath: string): string | null {
	const candidates = ["README.md", "readme.md", "README", "README.txt", "README.rst"];
	for (const name of candidates) {
		const readmePath = join(localPath, name);
		if (existsSync(readmePath)) {
			try {
				const content = readFileSync(readmePath, "utf-8");
				return content.length > 8192 ? content.slice(0, 8192) + "\n\n[README truncated at 8K chars]" : content;
			} catch {
				continue;
			}
		}
	}
	return null;
}

function generateContent(localPath: string, info: GitHubUrlInfo): string {
	const lines: string[] = [];
	lines.push(`Repository cloned to: ${localPath}`);
	lines.push("");

	if (info.type === "root") {
		lines.push("## Structure");
		lines.push(buildTree(localPath));
		lines.push("");

		const readme = readReadme(localPath);
		if (readme) {
			lines.push("## README.md");
			lines.push(readme);
			lines.push("");
		}

		lines.push("Use `read` and `bash` tools at the path above to explore further.");
		return lines.join("\n");
	}

	if (info.type === "tree") {
		const dirPath = info.path || "";
		const fullDirPath = resolveWithinRepo(localPath, dirPath);

		if (!fullDirPath || !existsSync(fullDirPath)) {
			lines.push(`Path \`${dirPath}\` not found in clone. Showing repository root instead.`);
			lines.push("");
			lines.push("## Structure");
			lines.push(buildTree(localPath));
		} else {
			lines.push(`## ${dirPath || "/"}`);
			lines.push(buildDirListing(localPath, dirPath));
		}

		lines.push("");
		lines.push("Use `read` and `bash` tools at the path above to explore further.");
		return lines.join("\n");
	}

	if (info.type === "blob") {
		const filePath = info.path || "";
		const fullFilePath = resolveWithinRepo(localPath, filePath);

		if (!fullFilePath || !existsSync(fullFilePath)) {
			lines.push(`Path \`${filePath}\` not found in clone. Showing repository root instead.`);
			lines.push("");
			lines.push("## Structure");
			lines.push(buildTree(localPath));
			lines.push("");
			lines.push("Use `read` and `bash` tools at the path above to explore further.");
			return lines.join("\n");
		}

		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(fullFilePath);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			lines.push(`Could not inspect \`${filePath}\`: ${message}`);
			lines.push("");
			lines.push("Use `read` and `bash` tools at the path above to explore further.");
			return lines.join("\n");
		}

		if (stat.isDirectory()) {
			lines.push(`## ${filePath || "/"}`);
			lines.push(buildDirListing(localPath, filePath));
			lines.push("");
			lines.push("Use `read` and `bash` tools at the path above to explore further.");
			return lines.join("\n");
		}

		if (isBinaryFile(fullFilePath)) {
			const ext = extname(filePath).replace(".", "");
			lines.push(`## ${filePath}`);
			lines.push(`Binary file (${ext}, ${formatFileSize(stat.size)}). Use \`read\` or \`bash\` tools at the path above to inspect.`);
			return lines.join("\n");
		}

		const content = readTextFile(fullFilePath);
		if (content === null) {
			lines.push(`Could not read \`${filePath}\` as UTF-8 text.`);
			lines.push("");
			lines.push("Use `read` and `bash` tools at the path above to explore further.");
			return lines.join("\n");
		}
		lines.push(`## ${filePath}`);

		if (content.length > MAX_INLINE_FILE_CHARS) {
			lines.push(content.slice(0, MAX_INLINE_FILE_CHARS));
			lines.push("");
			lines.push(`[File truncated at 100K chars. Full file: ${fullFilePath}]`);
		} else {
			lines.push(content);
		}

		lines.push("");
		lines.push("Use `read` and `bash` tools at the path above to explore further.");
		return lines.join("\n");
	}

	return lines.join("\n");
}

async function awaitCachedClone(
	cached: CachedClone,
	url: string,
	owner: string,
	repo: string,
	info: GitHubUrlInfo,
	signal?: AbortSignal,
): Promise<ExtractedContent | null> {
	if (signal?.aborted) return null;
	const result = await cached.clonePromise;
	if (signal?.aborted) return null;
	if (result) {
		const content = generateContent(result, info);
		const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
		return { url, title, content, error: null };
	}
	return fetchViaApi(url, owner, repo, info);
}

export async function extractGitHub(
	url: string,
	signal?: AbortSignal,
	forceClone?: boolean,
	session = defaultCloneSession,
): Promise<ExtractedContent | null> {
	signal = signal ? AbortSignal.any([signal, session.controller.signal]) : session.controller.signal;
	const cloneCache = session.cache;
	const info = parseGitHubUrl(url);
	if (!info) return null;

	if (signal?.aborted) return null;

	const config = loadGitHubConfig();
	if (!config.enabled) return null;

	const { owner, repo } = info;
	const key = cacheKey(owner, repo, info.ref);

	const cached = cloneCache.get(key);
	if (cached) return awaitCachedClone(cached, url, owner, repo, info, signal);

	if (info.refIsFullSha) {
		if (signal?.aborted) return null;
		const sizeNote = `Note: Commit SHA URLs use the GitHub API instead of cloning.`;
		return fetchViaApi(url, owner, repo, info, sizeNote);
	}

	const activityId = activityMonitor.logStart({ type: "fetch", url: `github.com/${owner}/${repo}` });

	if (!forceClone) {
		const sizeKB = await checkRepoSize(owner, repo);
		if (signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			return null;
		}
		if (sizeKB !== null) {
			const sizeMB = sizeKB / 1024;
			if (sizeMB > config.maxRepoSizeMB) {
				if (signal?.aborted) {
					activityMonitor.logComplete(activityId, 0);
					return null;
				}
				const sizeNote =
					`Note: Repository is ${Math.round(sizeMB)}MB (threshold: ${config.maxRepoSizeMB}MB). ` +
					`Showing API-fetched content instead of full clone. Ask the user if they'd like to clone the full repo -- ` +
					`if yes, call fetch_content again with the same URL and add forceClone: true to the params.`;
				const apiView = await fetchViaApi(url, owner, repo, info, sizeNote);
				if (apiView) {
					activityMonitor.logComplete(activityId, 200);
					return apiView;
				}
				activityMonitor.logError(activityId, "api fallback unavailable for oversized repository");
				return null;
			}
		}
	}

	if (signal?.aborted) {
		activityMonitor.logComplete(activityId, 0);
		return null;
	}

	// Re-check: another concurrent caller may have started a clone while we awaited the size check
	const cachedAfterSizeCheck = cloneCache.get(key);
	if (cachedAfterSizeCheck) {
		const cachedResult = await awaitCachedClone(cachedAfterSizeCheck, url, owner, repo, info, signal);
		if (signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
		} else if (cachedResult) {
			activityMonitor.logComplete(activityId, 200);
		} else {
			activityMonitor.logError(activityId, "clone failed");
		}
		return cachedResult;
	}

	const destination = cloneDestination(config, session, owner, repo, info.ref);
	if (!destination) {
		const apiFallback = await fetchViaApi(url, owner, repo, info);
		if (signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			return null;
		}
		if (apiFallback) activityMonitor.logComplete(activityId, 200);
		else activityMonitor.logError(activityId, "invalid clone destination");
		return apiFallback;
	}
	const clonePromise = cloneRepo(owner, repo, info.ref, config, destination, signal);
	cloneCache.set(key, { destination, clonePromise });

	const result = await clonePromise.catch((err) => {
		cloneCache.delete(key);
		releaseEmptyRuntime(session);
		activityMonitor.logError(activityId, "clone process failed");
		throw err;
	});
	if (signal?.aborted) {
		if (!result) {
			cloneCache.delete(key);
			releaseEmptyRuntime(session);
		}
		activityMonitor.logComplete(activityId, 0);
		return null;
	}

	if (!result) {
		cloneCache.delete(key);
		releaseEmptyRuntime(session);
		if (signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			return null;
		}

		const apiFallback = await fetchViaApi(url, owner, repo, info);
		if (apiFallback) {
			activityMonitor.logComplete(activityId, 200);
			return apiFallback;
		}

		activityMonitor.logError(activityId, "clone and API fallback failed");
		return null;
	}

	activityMonitor.logComplete(activityId, 200);
	const content = generateContent(result, info);
	const title = info.path ? `${owner}/${repo} - ${info.path}` : `${owner}/${repo}`;
	return { url, title, content, error: null };
}

export function disposeGitHubCloneSession(session: GitHubCloneSession): Promise<void> {
	if (session.disposal) return session.disposal;
	session.controller.abort();
	session.disposal = (async () => {
		const results = await Promise.allSettled([...session.cache.values()].map((entry) => entry.clonePromise));
		const failure = results.find((result) => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
		session.cache.clear();
		releaseEmptyRuntime(session);
		await session.sweep;
	})();
	return session.disposal;
}

export function clearCloneCache(): Promise<void> {
	const previous = defaultCloneSession;
	defaultCloneSession = createGitHubCloneSession();
	cachedConfig = null;
	return disposeGitHubCloneSession(previous);
}
