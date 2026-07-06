import test from "node:test";
import assert from "node:assert/strict";
import {
  filterAzureWorkloadIdentities,
  isAwsInfrastructureRoleName,
} from "./clusterSetupDefaults.js";

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
