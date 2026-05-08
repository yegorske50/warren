import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { agentsApi, setApiToken, UnauthorizedError } from "@/api/client.ts";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";

export function LoginPage() {
	const navigate = useNavigate();
	const [token, setToken] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	const onSubmit = async (e: React.FormEvent): Promise<void> => {
		e.preventDefault();
		if (token.length === 0) {
			setError("Token cannot be empty");
			return;
		}
		setPending(true);
		setError(null);
		setApiToken(token);
		try {
			// Probe a token-protected route to validate the bearer. /agents
			// always returns 200 for a valid token (empty list is fine);
			// /readyz can return 503 even on a valid token when no agents
			// are registered yet, so it can't disambiguate.
			await agentsApi.list();
			navigate("/runs", { replace: true });
		} catch (err) {
			setApiToken(null);
			if (err instanceof UnauthorizedError) {
				setError("Token rejected by server.");
			} else {
				setError(err instanceof Error ? err.message : String(err));
			}
		} finally {
			setPending(false);
		}
	};

	return (
		<div className="flex min-h-screen items-center justify-center p-6">
			<Card className="w-full max-w-md">
				<CardHeader>
					<CardTitle>warren</CardTitle>
					<CardDescription>
						Paste your <code>WARREN_API_TOKEN</code> to access the control plane.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={onSubmit} className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="token">API token</Label>
							<Input
								id="token"
								type="password"
								autoComplete="off"
								value={token}
								onChange={(e) => setToken(e.target.value)}
								placeholder="warren-…"
								autoFocus
							/>
						</div>
						{error !== null ? (
							<p className="text-sm text-(--color-destructive)">{error}</p>
						) : null}
						<Button type="submit" disabled={pending} className="w-full">
							{pending ? "Verifying…" : "Continue"}
						</Button>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}
