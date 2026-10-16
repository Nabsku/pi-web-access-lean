import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";

// Preserve native Fetch's existing allowance, rather than introduce a new policy.
const MAX_REDIRECTS = 20;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const internalAddresses = new BlockList();
for (const [address, prefix] of [
	["0.0.0.0", 8], ["10.0.0.0", 8], ["127.0.0.0", 8], ["100.64.0.0", 10],
	["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["198.18.0.0", 15],
	["224.0.0.0", 3],
] as const) internalAddresses.addSubnet(address, prefix, "ipv4");
internalAddresses.addAddress("::", "ipv6");
internalAddresses.addAddress("::1", "ipv6");
for (const [address, prefix] of [
	["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) internalAddresses.addSubnet(address, prefix, "ipv6");

function assertPublicAddress(address: string, hostname: string): void {
	const family = isIP(address);
	if (!family) throw new Error(`Blocked fetch target: resolved non-IP address for ${hostname}`);
	// BlockList also matches IPv4 rules against IPv4-mapped IPv6 addresses.
	if (internalAddresses.check(address, family === 4 ? "ipv4" : "ipv6")) {
		throw new Error(`Blocked fetch target: internal address for ${hostname}: ${address}`);
	}
}

async function validateRemoteUrl(url: URL, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Blocked fetch target: Only HTTP and HTTPS URLs can be fetched");
	}
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const withoutTrailingDot = hostname.replace(/\.$/, "");
	if (withoutTrailingDot === "localhost" || withoutTrailingDot.endsWith(".localhost")) {
		throw new Error(`Blocked fetch target: internal hostname ${hostname}`);
	}
	if (isIP(hostname)) {
		assertPublicAddress(hostname, hostname);
		return;
	}

	let addresses: LookupAddress[];
	let onAbort: (() => void) | undefined;
	try {
		const aborted = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(signal?.reason);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		addresses = await Promise.race([lookup(hostname, { all: true, verbatim: true }), aborted]);
	} catch (err) {
		signal?.throwIfAborted();
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Blocked fetch target: failed to resolve ${hostname}: ${message}`);
	} finally {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
	signal?.throwIfAborted();
	if (!Array.isArray(addresses) || addresses.length === 0) {
		throw new Error(`Blocked fetch target: DNS returned no addresses for ${hostname}`);
	}
	for (const answer of addresses) {
		if (!answer || typeof answer.address !== "string" ||
			(answer.family !== 4 && answer.family !== 6) || isIP(answer.address) !== answer.family) {
			throw new Error(`Blocked fetch target: invalid DNS address for ${hostname}`);
		}
		assertPublicAddress(answer.address, hostname);
	}
}

export async function fetchRemoteUrl(url: string, init: RequestInit): Promise<Response> {
	let current = new URL(url);
	for (let redirects = 0; ; redirects++) {
		await validateRemoteUrl(current, init.signal ?? undefined);
		init.signal?.throwIfAborted();
		// Preflight does not pin the connection's IP; DNS rebinding remains possible.
		const response = await fetch(current, { ...init, redirect: "manual" });
		if (!REDIRECT_STATUSES.has(response.status)) return response;
		const location = response.headers.get("location");
		try {
			await response.body?.cancel();
		} catch (err) {
			if (response.body?.locked) throw err;
			// An already-errored body can be discarded without losing its redirect.
		}
		init.signal?.throwIfAborted();
		if (location === null) return response;
		if (redirects === MAX_REDIRECTS) {
			throw new Error(`Redirect limit exceeded (configured: ${MAX_REDIRECTS}, observed: ${redirects + 1}). Fetch the final URL directly or shorten the redirect chain.`);
		}
		current = new URL(location, current);
	}
}
