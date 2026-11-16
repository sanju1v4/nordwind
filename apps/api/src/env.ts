import { z } from "zod";

// Read and check all configuration once, at startup.
// If something is missing, the API refuses to start with a clear message
// instead of failing later in a confusing way.
const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is missing in .env"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 random characters (see .env.example)"),
  API_PORT: z.coerce.number().default(3000),
  WORKER_METRICS_PORT: z.coerce.number().default(9100),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // AI providers. Each one is optional: a model only appears in the app if its provider key is set.
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-haiku-5-5"),
  MISTRAL_API_KEY: z.string().optional(),
  MISTRAL_MODEL: z.string().default("mistral-small-latest"),

  // Document storage (private S3 bucket). Credentials: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY,
  // read automatically by the AWS SDK. Without S3_BUCKET the knowledge base is switched off.
  S3_BUCKET: z.string().optional(),
  AWS_REGION: z.string().default("eu-north-1"),

  // Embeddings turn text into vectors for search. "demo" works offline with no API key.
  EMBEDDINGS_PROVIDER: z.enum(["demo", "mistral", "openai"]).default("demo"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid configuration:\n" + parsed.error.issues.map((i) => ` - ${i.path.join(".")}: ${i.message}`).join("\n"));
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
