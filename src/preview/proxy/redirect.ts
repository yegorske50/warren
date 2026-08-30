/**
 * Main-listener redirect for path-mode previews (warren-3f8a).
 *
 * Path-mode previews are served from a dedicated listener so they get
 * their own browser origin (see `proxy/index.ts`). The warren origin no
 * longer serves `/p/<runId>/...` itself — this preamble answers those
 * paths with a 308 to the same path on the preview origin, so
 * pre-split bookmarks, PR annotations, and stale UI tabs keep working.
 *
 * 308 (not 301/307) because it is cacheable AND method-preserving; a
 * POST into a preview app must stay a POST across the hop. Only the
 * port changes — scheme + hostname come from the inbound request, the
 * same derivation the login handshake uses.
 *
 * Referer-based asset requests (`/_next/static/...` with a `/p/<id>/`
 * referer) are NOT redirected: after the split those only originate
 * from a tab that loaded its page HTML from the warren origin before
 * the upgrade, and a reload lands the tab on the preview origin. The
 * paths fall through to the SPA/404 pipeline instead of dragging a
 * referer sniff back onto the API origin.
 */

import { parsePreviewPathPrefix } from "./route-match.ts";
import type { PreviewProxyHandler } from "./types.ts";

/**
 * Build the main-listener preamble that bounces `/p/<runId>/...` to the
 * dedicated preview listener at `previewPort`. Non-preview paths fall
 * through (`null`) to the regular auth + route pipeline.
 */
export function createPreviewPathRedirect(previewPort: number): PreviewProxyHandler {
	return (_request: Request, url: URL): Promise<Response | null> => {
		if (parsePreviewPathPrefix(url.pathname) === null) return Promise.resolve(null);
		const target = new URL(url.toString());
		target.port = String(previewPort);
		return Promise.resolve(
			new Response(null, {
				status: 308,
				headers: { location: target.toString() },
			}),
		);
	};
}
