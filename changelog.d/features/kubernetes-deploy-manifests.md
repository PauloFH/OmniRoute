- **feat(deploy):** first-class Kubernetes support — Kustomize base with k3s (Traefik +
  `local-path`) and generic k8s (ingress-nginx) overlays under `deploy/kubernetes/`, plus a Helm
  chart at `deploy/helm/omniroute/`. Both pin the single-SQLite-writer topology (`replicas: 1`,
  `Recreate`, ReadWriteOnce) and the chart refuses to render a configuration that would corrupt
  the database. Ingress defaults keep SSE unbuffered. New `omniroute deploy k8s` prints the same
  manifests built from a running instance's settings, and `omniroute deploy k8s provision` prints
  the commands for standing up a k3s cluster locally or on a VPS — OmniRoute never runs them and
  never connects to the server. Guide: `docs/ops/KUBERNETES_DEPLOYMENT_GUIDE.md`.
