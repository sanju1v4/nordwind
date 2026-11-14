import { createTRPCClient, httpLink } from "@trpc/client";
// "import type" = only the TypeScript types come over; no server code reaches the browser.
import type { AppRouter } from "../../api/src/router";

// Ask the server for a new 15-minute access token using the refresh cookie.
// Several calls failing at once share ONE refresh request.
let refreshing: Promise<boolean> | null = null;
export function refreshSession(): Promise<boolean> {
  refreshing ??= fetch("/auth/refresh", { method: "POST" })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

// Every API call goes through this. If the access token expired (401), refresh once and retry.
// The user never sees this happen; they stay logged in for up to 7 days.
export async function fetchWithRefresh(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  const url = String(input);
  if (res.status !== 401 || url.includes("auth.login")) return res;
  return (await refreshSession()) ? fetch(input, init) : res;
}

export const api = createTRPCClient<AppRouter>({
  links: [httpLink({ url: "/trpc", fetch: fetchWithRefresh })],
});

export async function logout() {
  await fetch("/auth/logout", { method: "POST" });
}
