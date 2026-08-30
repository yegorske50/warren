import { describe, expect, test } from "bun:test";
import { createPreviewPathRedirect } from "./redirect.ts";

function requestFor(url: string): { request: Request; url: URL } {
	const request = new Request(url);
	return { request, url: new URL(url) };
}

describe("createPreviewPathRedirect (warren-3f8a)", () => {
	test("308-redirects /p/<runId>/ paths to the preview port, preserving path + query", async () => {
		const handler = createPreviewPathRedirect(8081);
		const { request, url } = requestFor("http://warren.example.com:8080/p/run_abc/inner?x=1");
		const response = await handler(request, url);
		expect(response).not.toBeNull();
		expect(response?.status).toBe(308);
		expect(response?.headers.get("location")).toBe(
			"http://warren.example.com:8081/p/run_abc/inner?x=1",
		);
	});

	test("keeps the inbound scheme and hostname (only the port changes)", async () => {
		const handler = createPreviewPathRedirect(9000);
		const { request, url } = requestFor("https://warren.example.com/p/run_abc/");
		const response = await handler(request, url);
		expect(response?.headers.get("location")).toBe("https://warren.example.com:9000/p/run_abc/");
	});

	test("falls through (null) on non-preview paths", async () => {
		const handler = createPreviewPathRedirect(8081);
		for (const path of ["/", "/runs/run_abc", "/p", "/p/", "/assets/app.js"]) {
			const { request, url } = requestFor(`http://warren.example.com:8080${path}`);
			expect(await handler(request, url)).toBeNull();
		}
	});

	test("falls through on referer-only asset requests (no referer sniff on the API origin)", async () => {
		const handler = createPreviewPathRedirect(8081);
		const request = new Request("http://warren.example.com:8080/_next/static/foo.js", {
			headers: { referer: "http://warren.example.com:8080/p/run_abc/" },
		});
		expect(await handler(request, new URL(request.url))).toBeNull();
	});
});
