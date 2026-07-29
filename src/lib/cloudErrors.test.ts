import test from "node:test";
import assert from "node:assert/strict";
import {
  isCloudAuthorizationError,
  isKubernetesForbiddenError,
} from "./cloudErrors.js";

test("classifies AWS authorization denials", () => {
  assert.equal(
    isCloudAuthorizationError(
      "An error occurred (AccessDeniedException) when calling the CreatePodIdentityAssociation operation: User: arn:aws:iam::123:user/dev is not authorized to perform: eks:CreatePodIdentityAssociation",
    ),
    true,
  );
  assert.equal(
    isCloudAuthorizationError(
      "An error occurred (AccessDenied) when calling the CreateSecret operation",
    ),
    true,
  );
  assert.equal(
    isCloudAuthorizationError("UnauthorizedOperation: You are not authorized"),
    true,
  );
});

test("classifies Azure authorization denials", () => {
  assert.equal(
    isCloudAuthorizationError(
      "(AuthorizationFailed) The client 'x' with object id 'y' does not have authorization to perform action 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials/write'",
    ),
    true,
  );
  assert.equal(
    isCloudAuthorizationError(
      "(Forbidden) Caller is not authorized to perform action on resource.",
    ),
    true,
  );
  assert.equal(
    isCloudAuthorizationError("Error: ForbiddenByRbac (Forbidden)"),
    true,
  );
});

test("classifies GCP authorization denials", () => {
  assert.equal(
    isCloudAuthorizationError(
      "ERROR: (gcloud.iam.service-accounts.add-iam-policy-binding) PERMISSION_DENIED: Permission iam.serviceAccounts.setIamPolicy is required",
    ),
    true,
  );
  assert.equal(
    isCloudAuthorizationError(
      "ERROR: user does not have permission to access secret",
    ),
    true,
  );
});

test("does not classify non-authorization errors", () => {
  assert.equal(isCloudAuthorizationError(""), false);
  assert.equal(
    isCloudAuthorizationError(
      "An error occurred (ResourceNotFoundException) when calling the DescribeAddon operation",
    ),
    false,
  );
  assert.equal(
    isCloudAuthorizationError(
      "An error occurred (InvalidParameterException) when calling the CreatePodIdentityAssociation operation: Trust policy of the role provided is invalid.",
    ),
    false,
  );
  assert.equal(
    isCloudAuthorizationError("connection timed out"),
    false,
  );
  assert.equal(
    isCloudAuthorizationError(
      "An error occurred (ResourceInUseException): association already exists",
    ),
    false,
  );
});

test("classifies Kubernetes RBAC denials", () => {
  assert.equal(
    isKubernetesForbiddenError(
      'namespaces is forbidden: User "dev@corp.com" cannot create resource "namespaces" in API group "" at the cluster scope',
    ),
    true,
  );
  assert.equal(
    isKubernetesForbiddenError(
      'Error: INSTALLATION FAILED: customresourcedefinitions.apiextensions.k8s.io is forbidden: User "dev" cannot create resource "customresourcedefinitions"',
    ),
    true,
  );
  assert.equal(
    isKubernetesForbiddenError("error: You must be logged in to the server (Unauthorized)"),
    true,
  );
});

test("does not classify other kubectl errors as RBAC denials", () => {
  assert.equal(isKubernetesForbiddenError(""), false);
  assert.equal(
    isKubernetesForbiddenError(
      'Error from server (NotFound): namespaces "rulebricks" not found',
    ),
    false,
  );
  assert.equal(
    isKubernetesForbiddenError("Unable to connect to the server: dial tcp: lookup"),
    false,
  );
});
