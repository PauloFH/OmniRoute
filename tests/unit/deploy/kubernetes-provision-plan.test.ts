/**
 * Provisioning plan and deploy-spec validation.
 *
 * The plan is text the operator runs by hand — OmniRoute never connects to the
 * server. So the assertions here are about the commands being CORRECT and
 * honest: a missing --tls-san produces a cluster no remote kubectl can reach,
 * and a rendered command that lies about what it does is worse than no command.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildProvisionPlan,
  isSafeServerAddress,
  isSafeVersion,
  isSafeContextName,
  isSafeSshUser,
} from "../../../src/lib/deploy/kubernetes/provisionPlan.ts";
import { deploySpecSchema } from "../../../src/lib/deploy/kubernetes/types.ts";
import { defaultSpec } from "../../../src/lib/deploy/kubernetes/manifestGenerator.ts";

// ── The plan is advisory, never executed ─────────────────────────────────────

test("a VPS plan puts the public address in the API server certificate", () => {
  const plan = buildProvisionPlan({ target: "vps", serverAddress: "203.0.113.10" });
  const install = plan.steps.find((s) => s.id === "install");
  assert.ok(install);
  assert.match(
    install.command,
    /--tls-san 203\.0\.113\.10/,
    "without --tls-san the cluster is only reachable as 127.0.0.1 and remote kubectl fails TLS"
  );
});

test("a VPS plan rewrites the kubeconfig server address", () => {
  const plan = buildProvisionPlan({ target: "vps", serverAddress: "203.0.113.10" });
  const fetch = plan.steps.find((s) => s.id === "fetch-kubeconfig");
  assert.ok(fetch);
  assert.match(
    fetch.command,
    /https:\/\/203\.0\.113\.10:6443/,
    "the kubeconfig k3s writes points at 127.0.0.1, which is the VPS itself"
  );
});

test("a VPS plan without an address warns instead of rendering a broken command", () => {
  const plan = buildProvisionPlan({ target: "vps" });
  assert.ok(
    plan.warnings.some((w) => w.includes("<vps-address>")),
    "the placeholder must be called out, not left for the operator to discover"
  );
  assert.ok(plan.steps.every((s) => !s.command.includes("undefined")));
});

test("a local plan does not reference SSH or a remote address", () => {
  const plan = buildProvisionPlan({ target: "local" });
  for (const step of plan.steps) {
    assert.ok(!step.command.includes("ssh "), `local plan must not shell out to ssh: ${step.id}`);
  }
});

test("every plan says OmniRoute does not run these commands", () => {
  for (const target of ["local", "vps"] as const) {
    const plan = buildProvisionPlan({ target });
    assert.ok(
      plan.warnings.some((w) => /never connects|yours to run/i.test(w)),
      `${target}: the operator must know these are run by hand`
    );
  }
});

test("a VPS plan warns about exposing the Kubernetes API port", () => {
  const plan = buildProvisionPlan({ target: "vps", serverAddress: "203.0.113.10" });
  assert.ok(plan.warnings.some((w) => w.includes("6443")));
});

test("a pinned k3s version reaches the installer", () => {
  const plan = buildProvisionPlan({ target: "local", k3sVersion: "v1.31.2+k3s1" });
  const install = plan.steps.find((s) => s.id === "install");
  assert.match(install!.command, /INSTALL_K3S_VERSION=v1\.31\.2\+k3s1/);
});

// ── Inputs that get rendered into commands ───────────────────────────────────

test("server addresses carrying shell metacharacters are rejected", () => {
  for (const bad of [
    "1.2.3.4; curl attacker.example",
    "host && rm -rf /",
    "$(id)",
    "`id`",
    "host | tee /tmp/x",
    "host with space",
    "host'quote",
    'host"quote',
  ]) {
    assert.equal(isSafeServerAddress(bad), false, `must reject: ${JSON.stringify(bad)}`);
  }
  for (const good of ["203.0.113.10", "vps.example.com", "192.168.0.15"]) {
    assert.equal(isSafeServerAddress(good), true, `must accept: ${good}`);
  }
});

test("version, context and ssh user inputs are constrained", () => {
  assert.equal(isSafeVersion("v1.31.2+k3s1"), true);
  assert.equal(isSafeVersion("latest; rm -rf /"), false);
  assert.equal(isSafeContextName("omniroute-vps"), true);
  assert.equal(isSafeContextName("ctx; id"), false);
  assert.equal(isSafeSshUser("root"), true);
  assert.equal(isSafeSshUser("root; id"), false);
});

// ── Deploy-spec guard rails ──────────────────────────────────────────────────

test("a spec whose shutdown budget exceeds the grace period is rejected", () => {
  const base = defaultSpec("local");
  const bad = {
    ...base,
    terminationGracePeriodSeconds: 40,
    preStopSleepSeconds: 15,
    config: { ...base.config, shutdownTimeoutMs: 30_000 }, // 30s > (40-15)=25s
  };
  const parsed = deploySpecSchema.safeParse(bad);
  assert.equal(parsed.success, false, "the kubelet would SIGKILL the pod mid-drain");
});

test("a heap ceiling at or above the memory limit is rejected", () => {
  const base = defaultSpec("local");
  const bad = {
    ...base,
    resources: { ...base.resources, limitsMemory: "2Gi" },
    config: { ...base.config, maxOldSpaceSizeMb: 2048 }, // == 2Gi
  };
  const parsed = deploySpecSchema.safeParse(bad);
  assert.equal(parsed.success, false, "the pod would be OOMKilled instead of raising a heap error");
});

test("TLS without an Ingress is rejected", () => {
  const base = defaultSpec("local");
  const bad = {
    ...base,
    ingress: { ...base.ingress, enabled: false, tlsEnabled: true },
  };
  assert.equal(deploySpecSchema.safeParse(bad).success, false);
});

test("names that are not RFC 1123 labels are rejected", () => {
  const base = defaultSpec("local");
  for (const bad of ["Omniroute", "omni_route", "omni route", "ns;drop"]) {
    assert.equal(
      deploySpecSchema.safeParse({ ...base, namespace: bad }).success,
      false,
      `namespace must reject: ${bad}`
    );
  }
});

test("an image tag carrying a shell metacharacter is rejected", () => {
  const base = defaultSpec("local");
  const bad = { ...base, image: { ...base.image, tag: "latest; rm -rf /" } };
  assert.equal(deploySpecSchema.safeParse(bad).success, false);
});
