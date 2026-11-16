"""
Copies the app's settings from .env into AWS Parameter Store (encrypted SecureStrings) under /nordwind/app/.
The cluster reads them on every deploy (k8s/deploy.sh); nothing secret lives in Git or in the manifests.

Run from E:\\Nordwind after `terraform apply` in infra\\cluster:
    uv run --no-project python scripts\\push_config.py

What it does NOT copy: AWS access keys. In the cluster, pods use the server's IAM role instead.
Production gets its OWN random JWT secret (created once, kept on later runs), so dev and prod logins are separate.
"""
import json
import secrets
import subprocess
import sys
from pathlib import Path

PROFILE = "nordwind"
REGION = "eu-north-1"
PREFIX = "/nordwind/app/"

# Copied from .env when present. Order = order shown in the summary.
FROM_ENV = [
    "DATABASE_URL",
    "S3_BUCKET",
    "AWS_REGION",
    "EMBEDDINGS_PROVIDER",
    "OPENAI_API_KEY",
    "OPENAI_MODEL",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_MODEL",
    "MISTRAL_API_KEY",
    "MISTRAL_MODEL",
]
SECRET_NAMES = {"DATABASE_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "MISTRAL_API_KEY", "JWT_SECRET"}


def aws(*args, input_json=None):
    cmd = ["aws", *args, "--profile", PROFILE, "--region", REGION, "--output", "json"]
    if input_json is not None:
        cmd += ["--cli-input-json", json.dumps(input_json)]  # JSON input: values are never parsed as file:// or URLs
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or f"aws {' '.join(args)} failed")
    return json.loads(result.stdout) if result.stdout.strip() else {}


def read_env(path: Path) -> dict:
    values = {}
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        if value:
            values[key.strip()] = value
    return values


def existing_names(path: str) -> set:
    names, token = set(), None
    while True:
        args = ["ssm", "get-parameters-by-path", "--path", path, "--recursive"]
        if token:
            args += ["--next-token", token]
        page = aws(*args)
        names |= {p["Name"] for p in page.get("Parameters", [])}
        token = page.get("NextToken")
        if not token:
            return names


def put(name: str, value: str, secret: bool):
    aws("ssm", "put-parameter", input_json={
        "Name": name, "Value": value, "Type": "SecureString" if secret else "String", "Overwrite": True,
    })


def main():
    env_file = Path.cwd() / ".env"
    if not env_file.exists():
        sys.exit("Run this from E:\\Nordwind (no .env found here).")
    env = read_env(env_file)

    try:
        aws("sts", "get-caller-identity")
    except RuntimeError:
        sys.exit("Not logged in to AWS. Run: aws login --profile nordwind")

    for required in ("DATABASE_URL", "S3_BUCKET"):
        if required not in env:
            sys.exit(f"{required} is missing in .env")

    existing = existing_names("/nordwind/")
    written = []

    for key in FROM_ENV:
        if key in env:
            put(PREFIX + key, env[key], key in SECRET_NAMES)
            written.append(key)

    # Production JWT secret: create once, never overwrite (overwriting would log everyone out).
    if PREFIX + "JWT_SECRET" not in existing:
        put(PREFIX + "JWT_SECRET", secrets.token_urlsafe(48), True)
        written.append("JWT_SECRET (new, random)")
    else:
        print("- JWT_SECRET: already set, kept")

    # Grafana admin password: create once and show it ONE time, here in your terminal.
    grafana = "/nordwind/grafana/admin-password"
    if grafana not in existing:
        password = secrets.token_urlsafe(18)
        put(grafana, password, True)
        print(f"\nGrafana login (save it in your password manager): user admin / password {password}\n")
    else:
        print("- Grafana password: already set, kept (read it with: aws ssm get-parameter --name "
              f"{grafana} --with-decryption --profile {PROFILE} --region {REGION})")

    for key in written:
        print(f"+ {key}")
    skipped = [k for k in FROM_ENV if k not in env]
    if skipped:
        print(f"(not in .env, skipped: {', '.join(skipped)})")
    print(f"\nDone: {len(written)} values in Parameter Store under {PREFIX} (encrypted where secret).")
    print("They are applied to the cluster on the next deploy.")


if __name__ == "__main__":
    main()
