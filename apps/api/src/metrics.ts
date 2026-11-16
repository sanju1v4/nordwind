import client from "prom-client";

/**
 * Prometheus metrics (case study R9: "we found out about the outage from customer emails").
 * Prometheus scrapes GET /metrics every 15s; Grafana draws dashboards and alerts on these.
 *
 * Label rule: only small, fixed sets of values (model, status, route). Never user ids, workspace ids,
 * or raw URLs: every distinct label value creates a new time series, and unbounded ones can take Prometheus down.
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: "nordwind_" }); // CPU, memory, event loop lag, GC

// ---------- HTTP (API) ----------
export const httpDuration = new client.Histogram({
  name: "nordwind_http_request_duration_seconds",
  help: "HTTP request duration (excluding streamed chat answers, which have their own metric)",
  labelNames: ["method", "route", "status"] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// ---------- Chat / AI ----------
export const chatRequests = new client.Counter({
  name: "nordwind_chat_requests_total",
  help: "Chat answers by model and outcome (ok, error, aborted). The availability SLO is built on this.",
  labelNames: ["model", "status"] as const,
  registers: [registry],
});

export const chatFirstToken = new client.Histogram({
  name: "nordwind_chat_time_to_first_token_seconds",
  help: "Time from request to the first streamed token: what users feel as 'speed'",
  labelNames: ["model"] as const,
  buckets: [0.25, 0.5, 1, 2, 3, 5, 8, 13, 20, 30],
  registers: [registry],
});

export const chatDuration = new client.Histogram({
  name: "nordwind_chat_duration_seconds",
  help: "Time until the answer was complete",
  labelNames: ["model", "status"] as const,
  buckets: [1, 2, 5, 10, 20, 30, 60, 90, 120],
  registers: [registry],
});

export const llmTokens = new client.Counter({
  name: "nordwind_llm_tokens_total",
  help: "Tokens used, by model and direction (input/output). Cost dashboards multiply this by the price.",
  labelNames: ["model", "direction"] as const,
  registers: [registry],
});

export const llmProviderErrors = new client.Counter({
  name: "nordwind_llm_provider_errors_total",
  help: "Failed calls to an AI provider, per attempt (retries count separately)",
  labelNames: ["provider", "reason"] as const,
  registers: [registry],
});

export const llmFallbacks = new client.Counter({
  name: "nordwind_llm_fallbacks_total",
  help: "Answers given by the fallback model because the chosen one was unavailable",
  labelNames: ["from", "to"] as const,
  registers: [registry],
});

export const circuitOpen = new client.Gauge({
  name: "nordwind_llm_circuit_open",
  help: "1 while a provider's circuit breaker is open (we are not calling it)",
  labelNames: ["provider"] as const,
  registers: [registry],
});

// ---------- Document worker ----------
export const documentJobs = new client.Counter({
  name: "nordwind_document_jobs_total",
  help: "Processed document jobs by outcome (ready, retry, failed)",
  labelNames: ["status"] as const,
  registers: [registry],
});

export const documentJobDuration = new client.Histogram({
  name: "nordwind_document_job_duration_seconds",
  help: "Time to download, extract, embed and store one document",
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

/** Classifies a provider error into a small, fixed set of reasons (safe as a label). */
export function errorReason(status: number | null, kind: string): string {
  if (kind === "timeout" || kind === "circuit_open" || kind === "network") return kind;
  if (status === 429) return "rate_limited";
  if (status !== null && status >= 500) return "server_error";
  if (status === 401 || status === 403) return "auth";
  return "client_error";
}
