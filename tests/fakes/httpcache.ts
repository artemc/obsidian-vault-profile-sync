import type { Http, HttpResponse } from "../../src/io";

/**
 * Stand-in for the HTTP cache behind Obsidian's requestUrl: a GET is answered from
 * the cache unless the request says `Cache-Control: no-cache`, and writes do not
 * invalidate anything. That is how GitHub's `max-age=60` behaves inside Obsidian.
 */
export function browserCache(http: Http): Http {
	const cache = new Map<string, HttpResponse>();
	return async (req) => {
		const method = (req.method ?? "GET").toUpperCase();
		if (method !== "GET") return http(req);
		const noCache = Object.entries(req.headers ?? {}).some(([k, v]) => k.toLowerCase() === "cache-control" && /no-cache|no-store/i.test(v));
		const hit = cache.get(req.url);
		if (hit && !noCache) return hit;
		const res = await http(req);
		if (res.status === 200) cache.set(req.url, res);
		return res;
	};
}
