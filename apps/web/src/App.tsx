import { useEffect, useState, type FormEvent } from "react";
import { api, logout } from "./trpc";

type Me = { email: string; role: string; workspace: string };

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);

  // On page load: am I already logged in? (The cookie is sent automatically.)
  useEffect(() => {
    api.auth.me
      .query()
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <Shell><p>Loading…</p></Shell>;
  if (!me) return <Shell><Login onLoggedIn={setMe} /></Shell>;

  return (
    <Shell>
      <p>
        Logged in as <b>{me.email}</b> ({me.role})
      </p>
      <p>
        Workspace: <b>{me.workspace}</b>
      </p>
      <button
        onClick={async () => {
          await logout();
          setMe(null);
        }}
      >
        Log out
      </button>
    </Shell>
  );
}

function Login({ onLoggedIn }: { onLoggedIn: (me: Me) => void }) {
  const [email, setEmail] = useState("max@bauer.test");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.auth.login.mutate({ email, password });
      onLoggedIn(await api.auth.me.query());
    } catch {
      setError("Invalid email or password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 12, maxWidth: 320 }}>
      <label>
        Email
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required style={input} />
      </label>
      <label>
        Password
        <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required style={input} />
      </label>
      {error && <p style={{ color: "crimson", margin: 0 }}>{error}</p>}
      <button type="submit" disabled={busy}>
        {busy ? "Logging in…" : "Log in"}
      </button>
      <small style={{ color: "#666" }}>Demo users: max@bauer.test, anna@lutz.test</small>
    </form>
  );
}

const input = { display: "block", width: "100%", padding: 8, marginTop: 4 } as const;

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", maxWidth: 560, margin: "64px auto", lineHeight: 1.6 }}>
      <h1>Nordwind</h1>
      {children}
    </main>
  );
}
