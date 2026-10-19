import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import pLimit from "p-limit";
import { MIMEType } from "node:util";
import { activityMonitor } from "./activity.ts";
import { extractRSCContent } from "./rsc-extract.ts";
import { extractPDFToMarkdown, isPDF } from "./pdf-extract.ts";
import { extractGitHub, type GitHubCloneSession } from "./github-extract.ts";
export { createGitHubCloneSession, disposeGitHubCloneSession } from "./github-extract.ts";
import { fetchRemoteUrl } from "./ssrf-protection.ts";
import { sanitizeInlineDataUris } from "./data-uri-sanitize.ts";

const DEFAULT_TIMEOUT_MS = 30000;
const CONCURRENT_LIMIT = 3;

const NON_RECOVERABLE_ERRORS = ["Unsupported content type", "Response too large", "Blocked fetch target"];
const MIN_USEFUL_CONTENT = 500;

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isConfigParseError(err: unknown): boolean {
	return errorMessage(err).startsWith("Failed to parse ");
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

function abortedResult(url: string): ExtractedContent {
	return { url, title: "", content: "", error: "Aborted" };
}

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

const sanitizedTurndown = new TurndownService(turndown.options);
const escapeMarkdown = sanitizedTurndown.escape.bind(sanitizedTurndown);
// Turndown bypasses this hook for literal inline/fenced code.
sanitizedTurndown.escape = text => sanitizeInlineDataUris(escapeMarkdown(text), true);

const fetchLimit = pLimit(CONCURRENT_LIMIT);

export interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
}

export interface ExtractOptions {
	timeoutMs?: number;
	forceClone?: boolean;
}

export async function extractContent(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
	cloneSession?: GitHubCloneSession,
): Promise<ExtractedContent> {
	if (signal?.aborted) {
		return { url, title: "", content: "", error: "Aborted" };
	}

	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return { url, title: "", content: "", error: "Only HTTP and HTTPS URLs can be fetched" };
		}
	} catch {
		return { url, title: "", content: "", error: "Invalid URL" };
	}

	try {
		const ghResult = await extractGitHub(url, signal, options?.forceClone, cloneSession);
		if (ghResult) return ghResult;
		if (signal?.aborted) return abortedResult(url);
	} catch (err) {
		const message = errorMessage(err);
		if (signal?.aborted) return abortedResult(url);
		if (isConfigParseError(err)) {
			return { url, title: "", content: "", error: message };
		}
		if (isAbortError(err)) return abortedResult(url);
	}

	if (signal?.aborted) return abortedResult(url);

	const httpResult = await extractViaHttp(url, signal, options);

	if (signal?.aborted) return abortedResult(url);
	if (!httpResult.error) return httpResult;
	if (NON_RECOVERABLE_ERRORS.some(prefix => httpResult.error!.startsWith(prefix))) return httpResult;

	const guidance = [
		httpResult.error,
		"",
		"Fallback options:",
		"  \u2022 Use web_search to find content about this topic",
	].join("\n");
	return { ...httpResult, error: guidance };
}

function isLikelyJSRendered(html: string): boolean {
	// Extract body content
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (!bodyMatch) return false;

	const bodyHtml = bodyMatch[1];

	// Strip tags to get text content
	const textContent = bodyHtml
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();

	// Count scripts
	const scriptCount = (html.match(/<script/gi) || []).length;

	// Heuristic: little text content but many scripts suggests JS rendering
	return textContent.length < 500 && scriptCount > 3;
}

async function rejectOversizedBody(
	body: { cancel(): Promise<void> } | null,
	maxBytes: number,
	observedBytes: number,
	source: "Content-Length" | "received",
): Promise<never> {
	const message = `Response too large (configured body limit: ${maxBytes} bytes; ${source}: ${observedBytes} bytes). Fetch a smaller document or download it directly.`;
	try {
		await body?.cancel();
	} catch (cause) {
		throw new Error(`${message} Body cancellation failed.`, { cause });
	}
	throw new Error(message);
}

async function readResponseBufferWithLimit(response: Response, maxBytes: number): Promise<ArrayBuffer> {
	const reader = response.body?.getReader();
	if (!reader) return new ArrayBuffer(0);

	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) await rejectOversizedBody(reader, maxBytes, totalBytes, "received");
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined.buffer;
}

function decodeResponseText(buffer: ArrayBuffer, contentType: string): string {
	let charset: string | null = null;
	try {
		charset = new MIMEType(contentType).params.get("charset");
	} catch (err) {
		if (!(err instanceof TypeError)) throw err;
		// A missing or malformed media type has no usable charset declaration.
	}
	let decoder: TextDecoder;
	try {
		decoder = new TextDecoder(charset || "utf-8");
	} catch (err) {
		if (!(err instanceof RangeError)) throw err;
		decoder = new TextDecoder("utf-8");
	}
	return decoder.decode(buffer);
}

async function extractViaHttp(
	url: string,
	signal?: AbortSignal,
	options?: ExtractOptions,
): Promise<ExtractedContent> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const activityId = activityMonitor.logStart({ type: "fetch", url });

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort);

	try {
		const response = await fetchRemoteUrl(url, {
			signal: controller.signal,
			headers: {
				"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
				"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
				"Accept-Language": "en-US,en;q=0.9",
				"Cache-Control": "no-cache",
				"Sec-Fetch-Dest": "document",
				"Sec-Fetch-Mode": "navigate",
				"Sec-Fetch-Site": "none",
				"Sec-Fetch-User": "?1",
				"Upgrade-Insecure-Requests": "1",
			},
		});

		const challengeError = `HTTP ${response.status}: Blocked by Cloudflare challenge page`;
		if (response.headers.get("cf-mitigated") === "challenge") {
			try {
				await response.body?.cancel();
			} catch (cause) {
				throw new Error(`${challengeError} Body cancellation failed.`, { cause });
			} finally {
				// Stream cancellation can leave the connection alive; abort the owned request too.
				controller.abort();
			}
			throw new Error(challengeError);
		}

		if (!response.ok) {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `HTTP ${response.status}: ${response.statusText}`,
			};
		}

		const contentLengthHeader = response.headers.get("content-length");
		const contentType = response.headers.get("content-type") || "";
		const isPDFContent = isPDF(url, contentType);
		const maxResponseSize = isPDFContent ? 20 * 1024 * 1024 : 5 * 1024 * 1024;
		if (contentLengthHeader) {
			const contentLength = parseInt(contentLengthHeader, 10);
			if (contentLength > maxResponseSize) {
				await rejectOversizedBody(response.body, maxResponseSize, contentLength, "Content-Length");
			}
		}

		if (isPDFContent) {
			const buffer = await readResponseBufferWithLimit(response, maxResponseSize);
			try {
				const result = await extractPDFToMarkdown(buffer, url);
				activityMonitor.logComplete(activityId, response.status);
				return {
					url,
					title: result.title,
					content: `PDF extracted and saved to: ${result.outputPath}\n\nPages: ${result.pages}\nCharacters: ${result.chars}`,
					error: null,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				activityMonitor.logError(activityId, message);
				return { url, title: "", content: "", error: `PDF extraction failed: ${message}` };
			}
		}

		if (contentType.includes("application/octet-stream") ||
			contentType.includes("image/") ||
			contentType.includes("audio/") ||
			contentType.includes("video/") ||
			contentType.includes("application/zip")) {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: "",
				content: "",
				error: `Unsupported content type: ${contentType.split(";")[0]}`,
			};
		}

		const buffer = await readResponseBufferWithLimit(response, maxResponseSize);
		const text = decodeResponseText(buffer, contentType);
		const isHTML = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");

		if (!isHTML) {
			activityMonitor.logComplete(activityId, response.status);
			const title = extractTextTitle(text, url);
			return { url, title, content: text, error: null };
		}

		const { document } = parseHTML(text);
		// Inspect actual bootstrap scripts, not quoted examples or embedded widgets.
		if (/^Just a moment\.\.\.$/i.test(document.title.trim()) &&
			Array.from(document.querySelectorAll("script:not([src])")).some(script => {
				const type = script.getAttribute("type")?.trim() || "";
				return (!type || /^(?:(?:text|application)\/javascript|module)$/i.test(type)) &&
					script.textContent?.includes("window._cf_chl_opt") &&
					script.textContent.includes("/cdn-cgi/challenge-platform/");
			})) {
			throw new Error(challengeError);
		}
		const reader = new Readability(document as unknown as Document);
		const article = reader.parse();

		if (!article?.content) {
			const rscResult = extractRSCContent(text);
			if (rscResult && rscResult.content.length >= MIN_USEFUL_CONTENT) {
				activityMonitor.logComplete(activityId, response.status);
				return { url, title: rscResult.title, content: rscResult.content, error: null };
			}

			activityMonitor.logComplete(activityId, response.status);

			// Provide more specific error message
			const jsRendered = isLikelyJSRendered(text);
			const errorMsg = jsRendered
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Could not extract readable content from HTML structure";

			return {
				url,
				title: "",
				content: "",
				error: errorMsg,
			};
		}

		if (typeof article.content !== "string") {
			throw new Error("Readability returned invalid article content");
		}
		const markdown = turndown.turndown(article.content);
		activityMonitor.logComplete(activityId, response.status);

		if (markdown.length < MIN_USEFUL_CONTENT) {
			const rscResult = extractRSCContent(text);
			if (rscResult && rscResult.content.length >= MIN_USEFUL_CONTENT) {
				return { url, title: rscResult.title, content: rscResult.content, error: null };
			}
		}

		if (markdown.length < MIN_USEFUL_CONTENT && isLikelyJSRendered(text)) {
			return {
				url,
				title: article.title || "",
				content: markdown,
				error: "Page appears to be JavaScript-rendered (content loads dynamically)",
			};
		}

		const content = /data:/i.test(markdown) ? sanitizedTurndown.turndown(article.content) : markdown;
		return { url, title: article.title || "", content, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		return { url, title: "", content: "", error: message };
	} finally {
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
	}
}

export function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}

function extractTextTitle(text: string, url: string): string {
	return extractHeadingTitle(text) ?? (new URL(url).pathname.split("/").pop() || url);
}

export async function fetchAllContent(
	urls: string[],
	signal?: AbortSignal,
	options?: ExtractOptions,
	cloneSession?: GitHubCloneSession,
): Promise<ExtractedContent[]> {
	return Promise.all(urls.map((url) => fetchLimit(async () => {
		const result = await extractContent(url, signal, options, cloneSession);
		return { ...result, title: sanitizeInlineDataUris(result.title), content: sanitizeInlineDataUris(result.content) };
	})));
}
