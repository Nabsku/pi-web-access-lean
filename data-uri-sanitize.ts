import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

// RFC 6838 limits each media-type name to 127 characters; never echo arbitrary headers.
const MIME_TYPE = /^[a-z0-9!#$%&'*+.^_`|~-]{1,127}\/[a-z0-9!#$%&'*+.^_`|~-]{1,127}$/i;
const MARKDOWN_PUNCTUATION = /[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/;

function enclosure(text: string, start: number): { close: string; markdown: boolean } {
	const immediate = text[start - 1];
	if (immediate === '"' || immediate === "'" || immediate === "`") {
		if (start === 1 || /[=([{: ,\s]/.test(text[start - 2])) return { close: immediate, markdown: false };
	}
	let before = start - 1;
	while (before >= 0 && (text[before] === " " || text[before] === "\t")) before--;
	const open = text[before];
	return { close: open === "(" ? ")" : open === "<" ? ">" : "", markdown: open === "<" || (open === "(" && text[before - 1] === "]") };
}

function isMarkdownTitle(text: string, from: number): boolean {
	let cursor = from;
	while (/\s/.test(text[cursor] || "")) cursor++;
	const open = text[cursor], close = open === "(" ? ")" : open === '"' || open === "'" ? open : "";
	if (!close) return false;
	for (cursor++; cursor < text.length; cursor++) {
		if (text[cursor] === "\\") { cursor++; continue; }
		if (text[cursor] === close) {
			cursor++;
			while (/\s/.test(text[cursor] || "")) cursor++;
			return text[cursor] === ")";
		}
		if (open === "(" && text[cursor] === "(") return false;
	}
	return false;
}

function scanCandidate(text: string, start: number): { end: number; markdown: boolean } {
	const { close, markdown } = enclosure(text, start);
	let depth = close === ")" ? 1 : 0;
	let hasComma = false, end = start + 5;
	for (; end < text.length; end++) {
		const ch = text[end];
		if ((close === '"' || close === "'") && ch === "\\") {
			if (end + 1 < text.length) end++;
			continue;
		}
		if (markdown && ch === "\\" && MARKDOWN_PUNCTUATION.test(text[end + 1] || "")) {
			if (text[end + 1] === ",") hasComma = true;
			end++;
			continue;
		}
		if (close === ")") {
			if (!markdown && /[\s\x00-\x1f\x7f"`<>]/.test(ch)) break;
			if (depth === 1 && hasComma && /\s/.test(ch) && !/\s/.test(text[end - 1]) && isMarkdownTitle(text, end)) break;
			if (ch === "(") depth++;
			else if (ch === ")" && --depth === 0) break;
		} else if (close ? ch === close : /[\s\x00-\x1f\x7f"`<>]/.test(ch)) {
			break;
		}
		if (ch === ",") hasComma = true;
	}
	return { end, markdown };
}

type DecodedPayload = { bytes: Buffer } | { error: string };

function decodePercent(payload: string): DecodedPayload {
	if (/%(?![\da-f]{2})/i.test(payload)) return { error: "invalid-percent-escape" };
	const output = Buffer.allocUnsafe(Buffer.byteLength(payload));
	let cursor = 0, written = 0;
	while (cursor < payload.length) {
		const percent = payload.indexOf("%", cursor);
		const end = percent < 0 ? payload.length : percent;
		written += output.write(payload.slice(cursor, end), written, "utf8");
		if (percent < 0) break;
		output[written++] = parseInt(payload.slice(percent + 1, percent + 3), 16);
		cursor = percent + 3;
	}
	return { bytes: output.subarray(0, written) };
}

function decodePayload(payload: string, base64: boolean): DecodedPayload {
	const decoded = decodePercent(payload);
	if ("error" in decoded || !base64) return decoded;
	const encoded = decoded.bytes;
	let paddingStart = encoded.length, paddingCount = 0;
	for (let i = 0; i < encoded.length; i++) {
		const byte = encoded[i];
		if (byte > 127) return { error: "non-ascii-base64" };
		if (byte === 61) {
			if (paddingCount === 0) paddingStart = i;
			paddingCount++;
		} else {
			if (paddingCount > 0) return { error: "invalid-base64-padding" };
			if (!((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || (byte >= 48 && byte <= 57) || byte === 43 || byte === 47)) return { error: "invalid-base64-character" };
		}
	}
	if (paddingCount > 2 || (paddingCount > 0 && encoded.length % 4 !== 0)
		|| (paddingCount === 1 && paddingStart % 4 !== 3) || (paddingCount === 2 && paddingStart % 4 !== 2)) return { error: "invalid-base64-padding" };
	if (paddingCount === 0 && encoded.length % 4 === 1) return { error: "invalid-base64-length" };
	return { bytes: Buffer.from(encoded.toString("ascii"), "base64") };
}

/** Omit inline RFC 2397 payloads, preserving prose and Markdown enclosures. */
export function sanitizeInlineDataUris(text: string, markdownText = false): string {
	const scheme = /data:/gi;
	const pieces: string[] = [];
	let retainedFrom = 0;
	for (let match; (match = scheme.exec(text)) !== null;) {
		const start = match.index;
		if (start > 0 && /[a-z\d+.-]/i.test(text[start - 1])) continue;
		const { end, markdown } = scanCandidate(text, start);
		const candidate = text.slice(start + 5, end);
		// Turndown escapes destinations; URI metadata describes the unescaped bytes.
		const value = markdown || markdownText ? candidate.replace(/\\(.)/g, (escape, char) => MARKDOWN_PUNCTUATION.test(char) ? char : escape) : candidate;
		const comma = value.indexOf(",");
		// Empty or whitespace-prefixed scheme-name labels are not URI headers.
		if (value.length === 0 || /^\s/.test(value)) continue;
		scheme.lastIndex = end;
		const header = value.slice(0, comma < 0 ? value.length : comma);
		const mime = header.split(";", 1)[0];
		const mimeType = mime === "" ? "text/plain" : MIME_TYPE.test(mime) ? mime.toLowerCase() : "application/octet-stream";
		const base64 = /;base64[ \t]*$/i.test(header);
		const payload = comma < 0 ? value : value.slice(comma + 1);
		const decoded: DecodedPayload = comma < 0 ? { error: "missing-comma" } : decodePayload(payload, base64);
		const valid = "bytes" in decoded;
		const digest = createHash("sha256").update(valid ? decoded.bytes : payload).digest("hex");
		const marker = `[pi-web-access inline data URI omitted; mime=${mimeType}; encoding=${base64 ? "base64" : "percent-encoded"}; encodedBytes=${Buffer.byteLength(payload)}; decodedBytes=${valid ? decoded.bytes.length : "unknown"};${valid ? "" : ` decodeError=${decoded.error};`} sha256=${digest}; digestBasis=${valid ? "decoded" : "encoded"}; retrieval=not-retained]`;
		pieces.push(text.slice(retainedFrom, start), marker);
		retainedFrom = end;
	}
	if (retainedFrom === 0) return text;
	pieces.push(text.slice(retainedFrom));
	return pieces.join("");
}
