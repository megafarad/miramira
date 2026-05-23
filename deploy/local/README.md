# Local Kubernetes deploy (Docker Desktop)

Runs the full miramira stack on Docker Desktop's built-in Kubernetes for local
testing. Differs from a real deploy in three ways: the image is **built locally
and side-loaded** (not pulled from GHCR), **Postgres runs in-cluster** (the
chart normally expects managed Postgres), and **Supabase values are
placeholders** (the service boots and goes Ready, but real JWT auth needs a
real project).

> Not production. Single replicas, `emptyDir` Postgres (data lost on pod
> restart), trivial credentials.

## Prerequisites

- Docker Desktop with Kubernetes enabled (`kubectl config current-context` →
  `docker-desktop`).
- Helm 3.8+ and `kubectl` on PATH.

## One-time

```sh
# Fetch the OpenFGA subchart pinned in Chart.lock (charts/*.tgz is gitignored).
helm repo add openfga https://openfga.github.io/helm-charts
helm dependency build deploy/helm/miramira
```

## Deploy

```sh
# 1. Build the image and load it into the cluster's containerd. Docker
#    Desktop's kind-backed cluster does NOT see host-built images, so import
#    them directly (no `kind` CLI needed):
docker build -t miramira:local .
docker save miramira:local | docker exec -i desktop-control-plane ctr -n k8s.io images import -

# 2. Namespace + in-cluster Postgres (creates the miramira + openfga databases):
kubectl create namespace miramira
kubectl -n miramira apply -f deploy/local/postgres.yaml
kubectl -n miramira rollout status deploy/pg

# 3. Install the chart:
helm upgrade --install miramira deploy/helm/miramira \
  -n miramira -f deploy/local/values-local.yaml

# 4. Watch it converge. On first install the api/worker crashloop briefly until
#    the post-install bootstrap Job writes the OpenFGA store/model IDs into the
#    *-openfga-ids Secret and restarts them — this self-heals.
kubectl -n miramira get pods -w
```

## Verify

```sh
kubectl -n miramira port-forward svc/miramira-api 4000:4000
# in another shell:
curl localhost:4000/healthz   # {"status":"ok"}
curl localhost:4000/readyz    # {"status":"ready","checks":{...}} once converged
```

## Rebuild after code changes

```sh
docker build -t miramira:local .
docker save miramira:local | docker exec -i desktop-control-plane ctr -n k8s.io images import -
kubectl -n miramira rollout restart deploy/miramira-api deploy/miramira-worker
```

## Tear down

```sh
helm uninstall miramira -n miramira
kubectl delete namespace miramira   # also drops Postgres + the kept IDs Secret
```

The `*-openfga-ids` Secret is marked `helm.sh/resource-policy: keep`, so
`helm uninstall` alone leaves it behind (by design — it preserves the store on
upgrades). Deleting the namespace clears it for a truly clean slate.
