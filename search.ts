import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isPerplexityAvailable, searchWithPerplexity, type SearchResponse, type SearchOptions } from "./perplexity.js";
import { hasExaApiKey, isExaAvailable, searchWithExa } from "./exa.js";

export type SearchProvider = "auto" | "perplexity" | "exa";
export type ResolvedSearchProvider = Exclude<SearchProvider, "auto">;

export interface AttributedSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider;
}

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");
let cachedSearchConfig: { searchProvider: SearchProvider } | null = null;

function getSearchConfig(): { searchProvider: SearchProvider } {
	if (cachedSearchConfig) return cachedSearchConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedSearchConfig = { searchProvider: "auto" };
		return cachedSearchConfig;
	}

	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as { searchProvider?: unknown; provider?: unknown };
		cachedSearchConfig = { searchProvider: normalizeSearchProvider(raw.searchProvider ?? raw.provider) };
		return cachedSearchConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

function normalizeSearchProvider(value: unknown): SearchProvider {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	return normalized === "auto" || normalized === "perplexity" || normalized === "exa" ? normalized : "auto";
}

export interface FullSearchOptions extends SearchOptions {
	provider?: SearchProvider;
	includeContent?: boolean;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

export async function search(query: string, options: FullSearchOptions = {}): Promise<AttributedSearchResponse> {
	const provider = options.provider ?? getSearchConfig().searchProvider;

	if (provider === "perplexity") {
		const result = await searchWithPerplexity(query, options);
		return { ...result, provider: "perplexity" };
	}

	if (provider === "exa") {
		const exaApiKeyConfigured = hasExaApiKey();
		try {
			const result = await searchWithExa(query, options);
			if (result && "exhausted" in result) {
				throw new Error("Exa monthly free tier exhausted (1,000 requests). Resets next month.");
			}
			if (result && "answer" in result) return { ...result, provider: "exa" };
			if (exaApiKeyConfigured) throw new Error("Exa search returned no results.");
		} catch (err) {
			if (isAbortError(err) || exaApiKeyConfigured) throw err;
		}
	}

	const fallbackErrors: string[] = [];

	if (provider !== "exa" && isExaAvailable()) {
		try {
			const result = await searchWithExa(query, options);
			if (result && "answer" in result) return { ...result, provider: "exa" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Exa: ${errorMessage(err)}`);
		}
	}

	if (isPerplexityAvailable()) {
		try {
			const result = await searchWithPerplexity(query, options);
			return { ...result, provider: "perplexity" };
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`Perplexity: ${errorMessage(err)}`);
		}
	}

	if (fallbackErrors.length > 0) {
		throw new Error(`Auto provider search failed:\n  - ${fallbackErrors.join("\n  - ")}`);
	}

	throw new Error("No search provider available. Set EXA_API_KEY/exaApiKey or perplexityApiKey in ~/.pi/web-search.json");
}
