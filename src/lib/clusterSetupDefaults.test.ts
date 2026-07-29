import test from "node:test";
import assert from "node:assert/strict";
import {
  filterAzureWorkloadIdentities,
  findClusterSetupDefault,
  isAwsInfrastructureRoleName,
} from "./clusterSetupDefaults.js";

test("prefers the -data-access identity over the legacy -rulebricks name", () => {
  // A cluster redeployed with current templates can have both generations of
  // the identity side by side; the new name must win.
  const candidates = [
    "rulebricks-cluster-external-secrets",
    "rulebricks-cluster-rulebricks",
    "rulebricks-cluster-data-access",
  ];
  for (const category of [
    "decision-logs-identity",
    "backups-identity",
    "metrics-identity",
  ] as const) {
    assert.equal(
      findClusterSetupDefault(candidates, category, {
        clusterName: "rulebricks-cluster",
      }),
      "rulebricks-cluster-data-access",
      category,
    );
  }
});

test("still resolves the legacy -rulebricks identity on existing clusters", () => {
  const candidates = [
    "rulebricks-cluster-external-dns",
    "rulebricks-cluster-rulebricks",
  ];
  assert.equal(
    findClusterSetupDefault(candidates, "backups-identity", {
      clusterName: "rulebricks-cluster",
    }),
    "rulebricks-cluster-rulebricks",
  );
});

test("flags EKS infrastructure roles across provisioning conventions", () => {
  const infraRoles = [
    // terraform-aws-eks name_prefix: cluster + node group roles.
    "rulebricks-cluster-cluster-20260323234020580400000002",
    "standard-nodes-eks-node-group-20260323234020580400000003",
    "burst-workers-node-20260323234020580400000004",
    // CloudFormation generated names (<stack>-<LogicalId>-<RANDOM>).
    "rulebricks-cluster-ClusterRole-1AB2CD3EF4GH",
    "rulebricks-cluster-NodeRole-9ZY8XW7VU6TS",
    // eksctl stacks.
    "eksctl-rulebricks-cluster-cluster-ServiceRole-ABC123DEF456",
    "eksctl-rulebricks-nodegroup-ng-1-NodeInstanceRole-XYZ789",
    // Service-linked roles.
    "AWSServiceRoleForAmazonEKS",
    "AWSServiceRoleForAmazonEKSNodegroup",
  ];
  for (const name of infraRoles) {
    assert.equal(isAwsInfrastructureRoleName(name), true, name);
  }
});

test("keeps workload roles even when the cluster name contains 'cluster'", () => {
  const workloadRoles = [
    "rulebricks-cluster-rulebricks",
    "rulebricks-cluster-decision-logs",
    "rulebricks-cluster-backups",
    "rulebricks-cluster-metrics",
    "rulebricks-cluster-ebs-csi",
    "my-app-vector",
  ];
  for (const name of workloadRoles) {
    assert.equal(isAwsInfrastructureRoleName(name), false, name);
  }
});

test("filters Azure infra identities and keeps workload identities", () => {
  const identities = [
    { name: "rulebricks-cluster-agentpool" },
    { name: "rulebricks-cluster-identity" },
    // The Azure Policy add-on identity, created whenever enableAzurePolicy is
    // on - federating it would fail at runtime.
    { name: "azurepolicy-rulebricks-cluster" },
    { name: "rulebricks-cluster-rulebricks" },
    { name: "rulebricks-cluster-decision-logs" },
  ];
  const filtered = filterAzureWorkloadIdentities(
    identities,
    "rulebricks-cluster",
  );
  assert.deepEqual(
    filtered.map((identity) => identity.name),
    ["rulebricks-cluster-rulebricks", "rulebricks-cluster-decision-logs"],
  );
});

test("never reintroduces infra identities when filtering empties the list", () => {
  const identities = [
    { name: "rulebricks-cluster-agentpool" },
    { name: "rulebricks-cluster-identity" },
  ];
  const filtered = filterAzureWorkloadIdentities(
    identities,
    "rulebricks-cluster",
  );
  assert.deepEqual(filtered, []);
});

test("only excludes the control-plane identity of the given cluster", () => {
  const identities = [
    { name: "other-cluster-identity" },
    { name: "rulebricks-cluster-identity" },
  ];
  const filtered = filterAzureWorkloadIdentities(
    identities,
    "rulebricks-cluster",
  );
  assert.deepEqual(
    filtered.map((identity) => identity.name),
    ["other-cluster-identity"],
  );
});
