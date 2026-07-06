import test from "node:test";
import assert from "node:assert/strict";
import {
  awsRoleNameFromArn,
  awsTrustPolicyAllowsPodIdentity,
  isAwsPodIdentityCliUnsupported,
  isAwsPodIdentityTrustPolicyInvalid,
  plannedBindings,
} from "./workloadIdentity.js";
import type { DeploymentConfig } from "../types/index.js";

test("detects AWS CLI builds without EKS Pod Identity operations", () => {
  const stderr = `usage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]
aws: error: argument operation: Invalid choice, valid choices are:
associate-encryption-config | create-addon | update-kubeconfig | get-token | wait | help`;

  assert.equal(isAwsPodIdentityCliUnsupported(stderr), true);
});

test("does not flag regular Pod Identity command errors as unsupported CLI", () => {
  assert.equal(
    isAwsPodIdentityCliUnsupported(
      "An error occurred (AccessDeniedException) when calling the CreatePodIdentityAssociation operation",
    ),
    false,
  );
  assert.equal(
    isAwsPodIdentityCliUnsupported(
      "An error occurred (ResourceInUseException) when calling the CreatePodIdentityAssociation operation",
    ),
    false,
  );
});

test("detects AWS Pod Identity invalid trust policy failures", () => {
  assert.equal(
    isAwsPodIdentityTrustPolicyInvalid(
      "An error occurred (InvalidParameterException) when calling the CreatePodIdentityAssociation operation: Trust policy of the role provided is invalid.",
    ),
    true,
  );
  assert.equal(
    isAwsPodIdentityTrustPolicyInvalid(
      "An error occurred (AccessDeniedException) when calling the CreatePodIdentityAssociation operation",
    ),
    false,
  );
});

test("accepts the cluster-setup Pod Identity trust policy", () => {
  // Matches RulebricksRole in cluster-setup/aws/rulebricks-cluster.cfn.yaml.
  const document = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "pods.eks.amazonaws.com" },
        Action: ["sts:AssumeRole", "sts:TagSession"],
      },
    ],
  };
  assert.equal(awsTrustPolicyAllowsPodIdentity(document), true);
});

test("accepts single-statement / single-action trust policy shapes", () => {
  const document = {
    Version: "2012-10-17",
    Statement: {
      Effect: "Allow",
      Principal: { Service: ["pods.eks.amazonaws.com", "eks.amazonaws.com"] },
      Action: "sts:AssumeRole",
    },
  };
  assert.equal(awsTrustPolicyAllowsPodIdentity(document), true);
});

test("rejects EKS control-plane and node trust policies", () => {
  // The failure mode from the field: an EKS cluster service role was selected.
  const controlPlane = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "eks.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  };
  const node = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "ec2.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  };
  assert.equal(awsTrustPolicyAllowsPodIdentity(controlPlane), false);
  assert.equal(awsTrustPolicyAllowsPodIdentity(node), false);
});

test("rejects legacy IRSA (OIDC federated) trust policies", () => {
  const irsa = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: {
          Federated:
            "arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE",
        },
        Action: "sts:AssumeRoleWithWebIdentity",
      },
    ],
  };
  assert.equal(awsTrustPolicyAllowsPodIdentity(irsa), false);
});

test("rejects malformed trust policy documents", () => {
  assert.equal(awsTrustPolicyAllowsPodIdentity(null), false);
  assert.equal(awsTrustPolicyAllowsPodIdentity("not-json-object"), false);
  assert.equal(awsTrustPolicyAllowsPodIdentity({}), false);
});

test("extracts role names from ARNs, including paths", () => {
  assert.equal(
    awsRoleNameFromArn(
      "arn:aws:iam::123456789012:role/rulebricks-cluster-rulebricks",
    ),
    "rulebricks-cluster-rulebricks",
  );
  assert.equal(
    awsRoleNameFromArn("arn:aws:iam::123456789012:role/teams/data/my-role"),
    "my-role",
  );
});

test("external MSK IAM binds hps, worker, and topic-provision SAs (one association each)", () => {
  const cfg = {
    name: "aws-p1",
    infrastructure: { provider: "aws", region: "us-east-1" },
    database: { type: "self-hosted" },
    features: { monitoring: {} },
    externalServices: {
      kafka: {
        mode: "external",
        external: {
          preset: "aws-msk-iam",
          identity: {
            awsRoleArn:
              "arn:aws:iam::123456789012:role/rulebricks-cluster-rulebricks",
          },
        },
      },
    },
  } as unknown as DeploymentConfig;

  const bindings = plannedBindings(cfg);
  const sas = bindings.map((b) => b.serviceAccount);
  assert.ok(sas.some((s) => s.endsWith("-hps")), sas.join(","));
  assert.ok(sas.some((s) => s.endsWith("-hps-worker")), sas.join(","));
  assert.ok(
    sas.some((s) => s.endsWith("-kafka-topic-provision")),
    sas.join(","),
  );
  // Each kafka SA gets exactly one association, to the configured MSK role.
  for (const b of bindings.filter((x) => x.serviceAccount.includes("-hps"))) {
    assert.match(b.principal, /:role\/rulebricks-cluster-rulebricks$/);
  }
});

test("embedded kafka creates no HPS/worker kafka bindings", () => {
  const cfg = {
    name: "aws-p1",
    infrastructure: { provider: "aws", region: "us-east-1" },
    database: { type: "self-hosted" },
    features: { monitoring: {} },
    externalServices: { kafka: { mode: "embedded" } },
  } as unknown as DeploymentConfig;

  const sas = plannedBindings(cfg).map((b) => b.serviceAccount);
  assert.ok(!sas.some((s) => s.endsWith("-hps")), sas.join(","));
  assert.ok(!sas.some((s) => s.endsWith("-hps-worker")), sas.join(","));
});
