// Creates two demo companies with one user each, for local development only:  npm run seed
// Bauer and Lutz are used to prove that one workspace can never see the other's data.
import { db } from "../db.js";
import { hashPassword } from "../auth.js";

const password = process.env.SEED_PASSWORD ?? "nordwind-demo-123";

const demo = [
  { workspace: "Bauer Logistik GmbH", email: "max@bauer.test", role: "admin" },
  { workspace: "Schreinerei Lutz", email: "anna@lutz.test", role: "admin" },
] as const;

async function main() {
  const hash = await hashPassword(password);
  for (const d of demo) {
    const existing = await db.query("SELECT 1 FROM users WHERE email = $1", [d.email]);
    if (existing.rowCount) {
      console.log(`exists: ${d.email}`);
      continue;
    }
    const ws = await db.query<{ id: string }>("INSERT INTO workspaces (name) VALUES ($1) RETURNING id", [d.workspace]);
    await db.query("INSERT INTO users (workspace_id, email, password_hash, role) VALUES ($1, $2, $3, $4)", [
      ws.rows[0].id,
      d.email,
      hash,
      d.role,
    ]);
    console.log(`created: ${d.email} in ${d.workspace}`);
  }
  console.log(`demo password: ${password}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.end());
