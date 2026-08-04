import test from "node:test";
import assert from "node:assert/strict";
import {
  ACS_SMTP_BUILT_IN_ROLE,
  ACS_SMTP_CUSTOM_ROLE_ACTIONS,
  checkAcsSmtpRoleAssignment,
  extractSecretCredential,
  buildAcsSmtpUsername,
  parseAcsSmtpAppClientId,
  chartOciRef,
  expectedSsoRedirectUri,
  hasSsoRedirectUri,
  planAcrImports,
  recommendEntraAppIndex,
  recommendSmtpAppIndex,
  shouldMirrorToAcr,
  assertAcrMirrorSucceeded,
} from "./cloudCli.js";
import { HELM_CHART_OCI } from "../types/index.js";

test("ACR import plan pins digests, honors targets, and appends app-tier images", () => {
  const specs = planAcrImports(
    [
      {
        name: "curl",
        tag: "8.1.0",
        digest: "sha256:abc",
      },
      // Explicit target repository and no digest: import by tag.
      { name: "supabase-postgres", tag: "15.8", target: "rulebricks/pg" },
    ],
    "2.0.19",
  );

  // Manifest pins are content-addressed, never forced.
  assert.equal(specs[0].force, undefined);
  assert.deepEqual(specs[0], {
    source: "docker.io/rulebricks/curl@sha256:abc",
    repository: "rulebricks/curl",
    tag: "8.1.0",
    digest: "sha256:abc",
  });
  assert.deepEqual(specs[1], {
    source: "docker.io/rulebricks/pg:15.8",
    repository: "rulebricks/pg",
    tag: "15.8",
  });
  // The app tier follows the selected product version, not the manifest. The
  // worker is a TAG on rulebricks/hps (no hps-worker repository), and all
  // three are force entries: the tags are mutable upstream (same-version hps
  // patches), so a skip-if-present mirror would stay stale forever.
  assert.deepEqual(
    specs.slice(2).map((spec) => ({ source: spec.source, force: spec.force })),
    [
      { source: "docker.io/rulebricks/app:2.0.19", force: true },
      { source: "docker.io/rulebricks/hps:2.0.19", force: true },
      { source: "docker.io/rulebricks/hps:worker-2.0.19", force: true },
    ],
  );
  // No version (chart-only re-mirror): manifest pins only.
  assert.equal(planAcrImports([{ name: "curl", tag: "8" }]).length, 1);
});

test("deploy and upgrade share the same strict Azure mirror predicate", () => {
  const azureMirror = {
    imageRegistryMode: "mirror",
    imageRegistry: "example.azurecr.io",
    infrastructure: { provider: "azure" as const },
  };
  assert.equal(shouldMirrorToAcr(azureMirror), true);
  // Registry set with no mode = populated outside the CLI: never imported.
  assert.equal(
    shouldMirrorToAcr({ ...azureMirror, imageRegistryMode: undefined }),
    false,
  );
  assert.equal(
    shouldMirrorToAcr({ ...azureMirror, imageRegistry: "" }),
    false,
  );
  assert.equal(
    shouldMirrorToAcr({
      ...azureMirror,
      infrastructure: { provider: "aws" as const },
    }),
    false,
  );
});

test("chart ref follows the registry only under a full mirror", () => {
  const azureMirror = {
    imageRegistryMode: "mirror",
    imageRegistry: "example.azurecr.io",
    infrastructure: { provider: "azure" as const },
  };
  assert.equal(
    chartOciRef(azureMirror),
    "oci://example.azurecr.io/rulebricks/helm/stack",
  );
  // Everything short of a full mirror installs the canonical ghcr.io chart.
  assert.equal(
    chartOciRef({ ...azureMirror, imageRegistryMode: undefined }),
    HELM_CHART_OCI,
  );
  assert.equal(
    chartOciRef({ ...azureMirror, imageRegistry: "" }),
    HELM_CHART_OCI,
  );
  assert.equal(
    chartOciRef({
      ...azureMirror,
      infrastructure: { provider: "aws" as const },
    }),
    HELM_CHART_OCI,
  );
});

test("mirror failures block with actionable manual import guidance", () => {
  assert.doesNotThrow(() =>
    assertAcrMirrorSucceeded("example.azurecr.io", { failed: [] }),
  );
  assert.throws(
    () =>
      assertAcrMirrorSucceeded("example.azurecr.io", {
        failed: [
          {
            ref: "rulebricks/app:2.0.19",
            source: "docker.io/rulebricks/app:2.0.19",
            detail: "authorization denied",
          },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /authorization denied/);
      assert.match(
        error.message,
        /Container Registry Data Importer and Data Reader/,
      );
      assert.doesNotMatch(error.message, /AcrPush/);
      assert.match(error.message, /az acr import --name example/);
      // Docker Hub sources need the license-derived PAT in the manual command.
      assert.match(error.message, /--username rulebricks --password/);
      return true;
    },
  );
});

test("chart mirror failures suggest an anonymous ghcr.io import", () => {
  assert.throws(
    () =>
      assertAcrMirrorSucceeded(
        "example.azurecr.io",
        {
          failed: [
            {
              ref: "rulebricks/helm/stack:0.3.0",
              source: "ghcr.io/rulebricks/helm/stack:0.3.0",
              detail: "authorization denied",
            },
          ],
        },
        "Mirroring helm chart 0.3.0",
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Mirroring helm chart 0\.3\.0/);
      assert.match(
        error.message,
        /az acr import --name example --source "ghcr\.io\/rulebricks\/helm\/stack:0\.3\.0" --image "rulebricks\/helm\/stack:0\.3\.0" --force/,
      );
      // The ghcr.io chart package is public: no Docker PAT in the manual command.
      assert.doesNotMatch(error.message, /--username rulebricks/);
      return true;
    },
  );
});

test("recommends the SMTP-named Entra app for ACS email", () => {
  const apps = [
    { name: "Corp Intranet" },
    { name: "Rulebricks SSO" },
    { name: "Rulebricks SMTP" },
  ];
  // "smtp" in the name beats a mere "rulebricks" mention.
  assert.equal(recommendSmtpAppIndex(apps), 2);
  // Fallback: any Rulebricks-named app.
  assert.equal(recommendSmtpAppIndex(apps.slice(0, 2)), 1);
  // Nothing matches: no recommendation.
  assert.equal(recommendSmtpAppIndex(apps.slice(0, 1)), -1);
});

test("builds the native-provider SSO callback for a deployment domain", () => {
  assert.equal(
    expectedSsoRedirectUri("Azpg.Rulebricks.com"),
    "https://supabase.azpg.rulebricks.com/auth/v1/callback",
  );
});

test("matches registered redirect URIs case- and slash-insensitively", () => {
  assert.equal(
    hasSsoRedirectUri(
      ["https://Supabase.azpg.rulebricks.com/auth/v1/callback/"],
      "azpg.rulebricks.com",
    ),
    true,
  );
  assert.equal(
    hasSsoRedirectUri(
      ["https://azpg.rulebricks.com/api/sso-proxy/callback"],
      "azpg.rulebricks.com",
    ),
    false,
  );
});

test("recommends the Entra app whose redirect URIs match the deployment", () => {
  const apps = [
    { redirectUris: ["https://other.example.com/callback"] },
    { redirectUris: ["https://azpg.rulebricks.com/api/sso-proxy/callback"] },
    { redirectUris: ["https://supabase.azpg.rulebricks.com/auth/v1/callback"] },
  ];
  // Exact callback beats a mere domain reference.
  assert.equal(recommendEntraAppIndex(apps, "azpg.rulebricks.com"), 2);
  // Domain reference is the fallback when no exact callback exists.
  assert.equal(recommendEntraAppIndex(apps.slice(0, 2), "azpg.rulebricks.com"), 1);
  // Nothing matches: no recommendation.
  assert.equal(recommendEntraAppIndex(apps.slice(0, 1), "azpg.rulebricks.com"), -1);
  assert.equal(recommendEntraAppIndex(apps, ""), -1);
});

test("assembles the ACS SMTP username from discovered parts", () => {
  assert.equal(
    buildAcsSmtpUsername("rbcommxyz", "app-id-123", "tenant-abc"),
    "rbcommxyz.app-id-123.tenant-abc",
  );
});

test("round-trips the app client ID through assemble and parse", () => {
  const username = buildAcsSmtpUsername(
    "rbcommxyz",
    "app-id-123",
    "tenant-abc",
  );
  assert.equal(parseAcsSmtpAppClientId(username), "app-id-123");
});

test("rejects ACS usernames that are incomplete or still placeholders", () => {
  assert.equal(parseAcsSmtpAppClientId("rbcommxyz.tenant-only"), null);
  assert.equal(
    parseAcsSmtpAppClientId("rbcommxyz.<entra-app-client-id>.tenant-abc"),
    null,
  );
});

test("reports the documented least-privilege ACS SMTP access", () => {
  assert.equal(
    ACS_SMTP_BUILT_IN_ROLE,
    "Communication and Email Service Owner",
  );
  assert.deepEqual([...ACS_SMTP_CUSTOM_ROLE_ACTIONS], [
    "Microsoft.Communication/CommunicationServices/Read",
    "Microsoft.Communication/CommunicationServices/Write",
    "Microsoft.Communication/EmailServices/Write",
  ]);
  assert.notEqual(ACS_SMTP_BUILT_IN_ROLE, "Contributor");
});

test("ACS SMTP access check is read-only and reports the platform handoff", async () => {
  const calls: string[][] = [];
  const responses = [
    {
      stdout:
        "/subscriptions/sub/resourceGroups/rg(with-parens)/providers/Microsoft.Communication/communicationServices/rbcomm",
      stderr: "",
    },
    {
      stdout: "22222222-2222-4222-8222-222222222222",
      stderr: "",
    },
    { stdout: "0", stderr: "" },
  ];
  const result = await checkAcsSmtpRoleAssignment(
    "rbcomm.11111111-1111-4111-8111-111111111111.tenant",
    async (file, args) => {
      calls.push([file, ...args]);
      return responses[calls.length - 1];
    },
  );

  assert.equal(result.status, "needs-review");
  assert.equal(
    result.requirement?.scope,
    "/subscriptions/sub/resourceGroups/rg(with-parens)/providers/Microsoft.Communication/communicationServices/rbcomm",
  );
  assert.deepEqual(
    calls.map((call) => call.slice(0, 4)),
    [
      ["az", "resource", "list", "--resource-type"],
      ["az", "ad", "sp", "show"],
      ["az", "role", "assignment", "list"],
    ],
  );
  assert.equal(calls.some((call) => call.includes("create")), false);
  assert.equal(calls.some((call) => call.includes("Contributor")), false);
});

test("ACS SMTP access check resolves modern free-form username resources", async () => {
  const acsId =
    "/subscriptions/sub/resourceGroups/platform-rg/providers/Microsoft.Communication/communicationServices/rbcomm";
  const calls: string[][] = [];
  const result = await checkAcsSmtpRoleAssignment(
    "rulebricks-production",
    { communicationServiceId: acsId },
    async (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === "rest") {
        return {
          stdout: "11111111-1111-4111-8111-111111111111",
          stderr: "",
        };
      }
      if (args[1] === "sp") {
        return {
          stdout: "22222222-2222-4222-8222-222222222222",
          stderr: "",
        };
      }
      return { stdout: "1", stderr: "" };
    },
  );

  assert.equal(result.status, "ok");
  assert.equal(result.requirement?.scope, acsId);
  assert.deepEqual(
    calls.map((call) => call.slice(0, 3)),
    [
      ["az", "rest", "--method"],
      ["az", "ad", "sp"],
      ["az", "role", "assignment"],
    ],
  );
  assert.equal(calls.some((call) => call.includes("create")), false);
});

test("ACS SMTP access check distinguishes a missing service principal", async () => {
  const responses = [
    {
      stdout:
        "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Communication/communicationServices/rbcomm",
      stderr: "",
    },
    { stdout: "", stderr: "Service principal does not exist" },
    { stdout: "11111111-1111-4111-8111-111111111111", stderr: "" },
  ];
  let index = 0;
  const result = await checkAcsSmtpRoleAssignment(
    "rbcomm.11111111-1111-4111-8111-111111111111.tenant",
    async () => responses[index++],
  );

  assert.equal(result.status, "no-service-principal");
  assert.equal(result.detail, "11111111-1111-4111-8111-111111111111");
});

test("ACS SMTP check keeps Graph lookup failures distinct from missing apps", async () => {
  const result = await checkAcsSmtpRoleAssignment(
    "rbcomm.11111111-1111-4111-8111-111111111111.tenant",
    async (_file, args) => {
      if (args[0] === "resource") {
        return {
          stdout:
            "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Communication/communicationServices/rbcomm",
          stderr: "",
        };
      }
      return {
        stdout: "",
        stderr: "Authorization_RequestDenied: Insufficient privileges",
      };
    },
  );

  assert.equal(result.status, "unknown");
  assert.match(result.detail || "", /Insufficient privileges/);
});

test("unwraps RDS-managed {username, password} secrets", () => {
  assert.equal(
    extractSecretCredential('{"username":"postgres","password":"s3cret"}'),
    "s3cret",
  );
});

test("unwraps cluster-setup ElastiCache {authToken} secrets", () => {
  // Regression: this JSON used to be returned verbatim and became
  // REDIS_PASSWORD, making every Redis consumer fail with WRONGPASS.
  assert.equal(
    extractSecretCredential('{"authToken":"zm0QrVxow9nGwAJvrEKGSUqR67VAFYpw"}'),
    "zm0QrVxow9nGwAJvrEKGSUqR67VAFYpw",
  );
});

test("prefers password when both keys are present", () => {
  assert.equal(
    extractSecretCredential('{"password":"a","authToken":"b"}'),
    "a",
  );
});

test("returns plain string secrets verbatim", () => {
  assert.equal(extractSecretCredential("just-a-token"), "just-a-token");
});

test("returns unrecognized JSON envelopes verbatim", () => {
  const raw = '{"connectionString":"redis://..."}';
  assert.equal(extractSecretCredential(raw), raw);
});
