import { z } from "zod";

// Read and check all configuration once, at startup.
// If something is missing, the API refuses to start with a clear message
// instead of failing later in a confusing way.
const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is missing in .env"),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 random characters (see .env.example)"),
  API_PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid configuration:\n" + parsed.error.issues.map((i) => ` - ${i.path.join(".")}: ${i.message}`).join("\n"));
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === "production";
