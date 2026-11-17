#!/usr/bin/env bash
# Runs ON the k3s server, started by GitHub Actions through AWS Systems Manager (no SSH, no open ports).
# Usage: deploy.sh <ecr-registry>     e.g. 123456789012.dkr.ecr.eu-north-1.amazonaws.com
#
# Order matters:
#   1. namespaces + monitoring         (idempotent)
#   2. image pull secret + app config  (from ECR and Parameter Store; never written to disk or logs)
#   3. database migrations             (a Job; if it fails we stop and the old version keeps running)
#   4. new app version                 (rolling update; if it doesn't become healthy we roll back)
set -euo pipefail

REGISTRY="${1:?usage: deploy.sh <ecr-registry>}"
DIR="$(cd "$(dirname "$0")" && pwd)"
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
REGION="${AWS_REGION:?AWS_REGION must be set}"
NS=nordwind
log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

log "1/4 namespaces and monitoring"
kubectl apply -f "$DIR/namespace.yaml"

log "2/4 image pull secret and app configuration"
# ECR login tokens last 12 hours; the server also refreshes this secret on a timer (see Terraform user data).
kubectl -n "$NS" create secret docker-registry ecr-pull \
  --docker-server="$REGISTRY" --docker-username=AWS \
  --docker-password="$(aws ecr get-login-password --region "$REGION")" \
  --dry-run=client -o yaml | kubectl apply -f -

# App settings live in AWS Parameter Store (SecureString, encrypted with KMS) under /nordwind/app/.
# They are piped straight into Kubernetes Secrets: never written to a file, never printed.
python3 - "$REGION" <<'PY' | kubectl apply -f -
import json, subprocess, sys
region = sys.argv[1]

def params(path):
    out, token = [], None
    while True:
        cmd = ["aws", "ssm", "get-parameters-by-path", "--path", path, "--recursive",
               "--with-decryption", "--region", region, "--output", "json"]
        if token:
            cmd += ["--next-token", token]
        page = json.loads(subprocess.check_output(cmd))
        out += page["Parameters"]
        token = page.get("NextToken")
        if not token:
            return {p["Name"].rsplit("/", 1)[1]: p["Value"] for p in out}

app = params("/nordwind/app/")
missing = [k for k in ("DATABASE_URL", "JWT_SECRET") if k not in app]
if missing:
    sys.exit(f"missing Parameter Store values under /nordwind/app/: {', '.join(missing)}")
grafana = params("/nordwind/grafana/")

def secret(name, ns, data):
    return {"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
            "metadata": {"name": name, "namespace": ns}, "stringData": data}

items = [secret("nordwind-env", "nordwind", app)]
if "admin-password" in grafana:
    items.append(secret("grafana-admin", "monitoring",
                        {"admin-user": "admin", "admin-password": grafana["admin-password"]}))
print(json.dumps({"apiVersion": "v1", "kind": "List", "items": items}))
PY
kubectl apply -f "$DIR/monitoring/"

log "3/4 database migrations"
kubectl -n "$NS" delete job migrate --ignore-not-found --wait=true
kubectl apply -f "$DIR/migrate-job.yaml"
for _ in $(seq 1 60); do
  ok=$(kubectl -n "$NS" get job migrate -o jsonpath='{.status.succeeded}')
  failed=$(kubectl -n "$NS" get job migrate -o jsonpath='{.status.failed}')
  if [ "${ok:-0}" -ge 1 ]; then break; fi
  if [ "${failed:-0}" -ge 1 ]; then
    kubectl -n "$NS" logs job/migrate --tail=50 || true
    log "migrations FAILED: stopping, the running version is untouched"
    exit 1
  fi
  sleep 5
done
[ "${ok:-0}" -ge 1 ] || { log "migrations timed out"; exit 1; }
kubectl -n "$NS" logs job/migrate --tail=20 || true

# Everything you need to debug a failed rollout, in the deploy log (no SSH needed). Secrets are never printed:
# "describe pod" shows only the name of the Secret the env comes from, not its values.
diagnose() {
  kubectl -n "$NS" get pods -l "app=$1" -o wide || true
  for pod in $(kubectl -n "$NS" get pods -l "app=$1" -o jsonpath='{.items[*].metadata.name}'); do
    echo "----- $pod: state and events"
    kubectl -n "$NS" describe pod "$pod" | sed -n '/^Containers:/,/^Conditions:/p;/^Events:/,$p' || true
    echo "----- $pod: last log lines"
    kubectl -n "$NS" logs "$pod" --tail=40 || true
    kubectl -n "$NS" logs "$pod" --previous --tail=40 2>/dev/null || true
  done
  kubectl top node 2>/dev/null || true
}

log "4/4 rolling out the new version"
kubectl apply -f "$DIR/app/"
for d in api worker web; do
  if ! kubectl -n "$NS" rollout status "deployment/$d" --timeout=300s; then
    log "$d did not become healthy. What the pods say:"
    diagnose "$d"
    # Roll back only if there IS a previous version (on the very first deploy there is nothing to go back to).
    if [ "$(kubectl -n "$NS" get "deployment/$d" -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}')" -gt 1 ]; then
      log "rolling $d back to the previous version"
      kubectl -n "$NS" rollout undo "deployment/$d"
      kubectl -n "$NS" rollout status "deployment/$d" --timeout=300s || true
    else
      log "first deploy of $d: nothing to roll back to, pods are left running for debugging"
    fi
    exit 1
  fi
done

kubectl -n "$NS" get pods -o wide
log "done"
