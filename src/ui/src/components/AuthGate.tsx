import type { ReactElement } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { getApiToken } from "@/api/client.ts";

/**
 * Redirects to /login when no API token is set in localStorage. The
 * server replies 401 if the token is wrong, which the API client
 * intercepts and clears — the next render then reaches this guard
 * and bounces back to login.
 */
export function AuthGate({ children }: { children: ReactElement }): ReactElement {
	const token = getApiToken();
	const location = useLocation();
	if (token === null || token.length === 0) {
		return <Navigate to="/login" replace state={{ from: location }} />;
	}
	return children;
}
