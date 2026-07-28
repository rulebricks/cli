import test from "node:test";
import assert from "node:assert/strict";
import {
  parseCertificate,
  certificateCoversHost,
  keyMatchesCertificate,
  requiredTlsHostnames,
  tlsSecretNameForHost,
  planTlsSecretsFromPems,
} from "./tlsCerts.js";
import { buildConfigMatrix } from "./configFixtures.js";
import { DeploymentConfig } from "../types/index.js";

const matrix = buildConfigMatrix();

function cloneFixture(name: string): DeploymentConfig {
  const entry = matrix.find((c) => c.name === name);
  assert.ok(entry, `missing matrix fixture ${name}`);
  return JSON.parse(JSON.stringify(entry.config)) as DeploymentConfig;
}

// Self-signed test certificate for rb.example.com + *.rb.example.com
// (matches the fixture configs' domain), valid until 2036.
const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDQTCCAimgAwIBAgIUEOxdbSYWksOcBHjBMKIwLzchBnEwDQYJKoZIhvcNAQEL
BQAwGTEXMBUGA1UEAwwOcmIuZXhhbXBsZS5jb20wHhcNMjYwNzI3MjE1MDMwWhcN
MzYwNzI0MjE1MDMwWjAZMRcwFQYDVQQDDA5yYi5leGFtcGxlLmNvbTCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAJBJh9G3z5/7Xa9+hQ7sfHALSwhYKLvN
q/kGgjIBi+Z0gPyfLY5ZgE5JZnoR2wFLuRrO1U5eWmhfHSeNuwUfNs4qvv6sxHwA
UYSLOGb4kQZA1IJPSa7Fy7olXnclXbMa9BH8CoBKZeUDpebLd2hhS60Ujdy/JRT1
tWfbCJtzIrKAT7IXgM72NHubPyEf7/MWwRV4HKBKpvJKBjgp5mEoMK/SkxX1F1DT
tAYTtejbjozYGD6awz37eQk4L+sQHZKgfw++TZ26Qf5nnLF25Hw3PhPWe23P0nqD
B7CnIH2bmNBXHlBkMPlDBb/4NS13bikY3GiEu69OaajzK7RVt2Oh54kCAwEAAaOB
gDB+MB0GA1UdDgQWBBR6CgXvnwZmsNNL+0BNcHU893rhwTAfBgNVHSMEGDAWgBR6
CgXvnwZmsNNL+0BNcHU893rhwTAPBgNVHRMBAf8EBTADAQH/MCsGA1UdEQQkMCKC
DnJiLmV4YW1wbGUuY29tghAqLnJiLmV4YW1wbGUuY29tMA0GCSqGSIb3DQEBCwUA
A4IBAQCNwytR3lDn5gBWEdSXWMuQjaQkVdstQt3PSoYHWdzBsaIWq0XzX+qDfVuh
ZZOx7s/ukDUJb7lGX4ntxz6e78blfmw9dsVIhomxvxB5QxL474J75Zd6pdHSmGq/
FpNUoWQjcFGJTCbzNNSycT8l4AQRHM890+4ezDsITeR7RtaPhZotILJY9qo4EO4+
t3a5ulq+2MVLxHaAUuS07KCflEr6FQzbwI93wfrt+wJyAzTAUgXoB13sSXzO7ZUn
lary4cGXaKNurjQvm16fOOkoTKkSQChBszcCuOqfAl9ob/qQcGDz9IO7l5I9EUUp
S+LNBD3/Os14Lh/CIQlk1blZk0ym
-----END CERTIFICATE-----`;

const KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCQSYfRt8+f+12v
foUO7HxwC0sIWCi7zav5BoIyAYvmdID8ny2OWYBOSWZ6EdsBS7kaztVOXlpoXx0n
jbsFHzbOKr7+rMR8AFGEizhm+JEGQNSCT0muxcu6JV53JV2zGvQR/AqASmXlA6Xm
y3doYUutFI3cvyUU9bVn2wibcyKygE+yF4DO9jR7mz8hH+/zFsEVeBygSqbySgY4
KeZhKDCv0pMV9RdQ07QGE7Xo246M2Bg+msM9+3kJOC/rEB2SoH8Pvk2dukH+Z5yx
duR8Nz4T1nttz9J6gwewpyB9m5jQVx5QZDD5QwW/+DUtd24pGNxohLuvTmmo8yu0
VbdjoeeJAgMBAAECggEAD62zyN+/u48/iAI4IG3lXDH39GdK/tRLpX7V7yvgmTlL
6ld8JmmWkfszG9zclsSVD8MNpetGCO0b8Ig7vCPfC1JVCHy6yYwpz3ym03abYKnz
BZlqxOdomri0jf8VElEhmCIyfGwJLDRkJsLxfdnDtMIk46mwFHnaHVfNVMHzMWDq
7pKvGCaLQyBBe55Z+3WT3GKb6jrqCxk7ShAwcZHEQVqXV+ymrhZHPle3YyAICa27
Zf7L/s1dfXJ5aZIpHh2LV7e62ihF9Or3GLKSfojXvVZhks2r8PFBMy/Wvj3uv+d5
uk83Pv1Mj7eix43nDTzuRmPqpvYGRfGIJxrT1ZXLwQKBgQDGA4vM23ZjpzHgT9i7
dvJxWTmZqjYIpFZIZ4CXnEvag/6/12ZxMJZDXA0uyBXiJT/bIgIdr/uHNhCw5wNT
aEHqmQo63WWJoIiV9kWf4h6scrNJvbtqEJw5lQTKgg1ZHwD794nmTN8DppBdoovi
MxomWQ6Nw8m/9HIeOJT2H31cSQKBgQC6ikY+wwOHPOKZ+qfoBECy73wcgYQUQ2aD
rAEIyWQ+qCQ76B/qfsReUmBfNFAZazPHaM7pJH9A2+eJOTSiytqe00az/dsqoT/v
+YZgkfpBN01IltAX2ZAX2Bhfv6aanIKJ8HYeypXgGcj0tlNNemEHX1qbC34BC/NO
SLGgogexQQKBgQCSKdvwA6+IL8ppQYdCGbMsaChUfYgVKPlnyL7rKrvzOKu7AEzm
EG9amYBBoABHRie0oY3eTCDm1cnMSznxP2wot38NpI9m39DyoS8Trd3mfWRKcnr8
9/XZq141/XnM503asAZisSuNjk3SUEHhXsdWtzY+/t7ViqMSG8IZS3VFwQKBgEhI
Wm3pfU2DLz+BXFzQgQ2VNR+KpFaBw5CULxZri3eoCdpY2T0xgAAYpZVenQcsfjTw
DPVUmibUz4Rh8V5/gnV24vfOD4YWU8M2inaTOkjZGA5fuiTzvh0vNEqt5e4VZZPz
5KGL2MWs2CzTFbZ5DG4h6ecYbewT6GTWUFYxUw/BAoGAZF3olXLZkJfRolFzccqC
RnmbnZnuS/83/C7WR/mRFHR/2ZLS091EYuhqOIuIjWiqYKJpyLY4a5akJ5mJZnlu
a5uMKZCTujOPjKvUI/BTdrqAYl2fRnEyvFT7YBw/9bwh4HIG2BeLKUBOzmf8ZhYj
pqHVfPRnHkHq9B4uILFEAmU=
-----END PRIVATE KEY-----`;

// A different keypair - valid PEM, wrong key for CERT_PEM.
const MISMATCHED_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7WxIQjo5lRU3q
ITk+fO3HwBSerPhxxhr8fRJ3hvfacpPOPp3nMH9jEFXVCN7kuHLFCRClJ7GyeDFp
sQuMqTkbMlKEerYPC263wCWnPFW6hJxTzrdXjfC/hJX+THqCcFnak4H+XjBRRXjp
DvDjtytnnQ7OSiDGbc6LtuPPV4/GdhfC9TZoKRM+t4Ef0njKZRmrMJo6z8PnzMK8
SfkMbzvHk2lYvF3Yq8lMLR0nH9YeJ+9lvA+UGihxG7a1cX/rr/3N13BWD2xPmNkC
z4nDDDh82MbgWz/8YyTi8/Q3Ih047TeIEHZp/jd0TWSN7r7oA+mWGOQR6Q0T0K5T
xE9zWe5fAgMBAAECggEAVV7Ji/bRRq7+MkWiRml5la/eFXF+oaUh7dP14rYC4Syd
UfixTcOJADRU0AZDPlgXn9WiGodMTqS660yLlTQUu+JBvHEH3TIZ6Kuq3Jm+/Ibp
jryeSUx5m2MIT8A8gIw+PT1CmgwEGzw7PIMc274+jm9/7BrV9WTanUogYv2km0qz
nced27iRuwLStlthozh++80fdwhBXWd3uptWQBPTKDXBQmV6/k5THTSo+KPpGFew
sGUyqbS1QAyfRUIZVsPjjqW0QWS303UGkLaPrxVTcNxpOVEkbBKO9WTSH/ZwrHHf
9eYJgZM75csz9op39QOtJYN+R3UuvRVAD38IRGREJQKBgQDhRaDyttuYczYhjzcq
g9VQr0vW7LElG1AuW9A0B8a0Yo3eeWteHA2AQ8yBf2rGTivHzrf9BiF0mw11QKAU
t6YsqtnTEA8tYH3h92GPbDJSsTJM1e5AHHi3n7uPYE29Z2jIblx3p5Yvxx9RFwFj
TboVTtGMQ4gYgi6b2mQo7HgJNQKBgQDU6W2OiHI2ukUHV6qe7Q7a+JecfcOtslZY
NHjI9Cn4Hrst882MG1WiCsIaXDal2BRSEznDJ99lf0916uK4xhne5lQb0lophtMt
e6lMCzBod2dzNwfBOEUH1gLf9giLzjiBzszA8ycMutS+KAIYUyszvu8mTLfWU6Cd
FBfw5sefwwKBgEjvxVuwbsseSmF1QDRIuPFFwHVW70gHXt+TpIakGebfnfVxNJ0k
0g48ZWNsQMLyHmSz/ogyyvQ5G5NiGDJ8/5Wov5wBsBhODJP0B6drLaPucU3FWj1x
unghhJW4ZZM0fw2eBdxL62mOvAoCO9XOHbi2a0xRtSfSRor5m8JQRdEdAoGBANHz
xddR8d7J3BwbdOL3PTjs/wSQeA+m1sJwK9NuApzsIQR1cHIC2nTKSxIXcMQlyhQN
ZV5uyTqbSk4ra5ttrkFBvBsbWVGt5DzrvsyAFCJP7LGOyJTe2iOaBIe5ZEAJAWvv
87UpkY5aBkPly/sUuHt0gvuvl3FAUhfTorApwxxlAoGBAMKWC7MlZfUuHFGoLZwN
0JWjHorhwNHSmDvEIYw3scI4BfN6r/pt5dW7cYZAPodyum+WkAdpoqbuxmg9SsEr
Q1OUFmwWHbdnrMujIX62rGXNgRzGk3aeCElIXQG2ZaWPSKfNKLnRYnnr2KDHNxOd
z7cZh6KCIcISHecWcvk7y/8m
-----END PRIVATE KEY-----`;

test("parses SANs and expiry from a PEM certificate", () => {
  const info = parseCertificate(CERT_PEM);
  assert.deepEqual(info.dnsNames, ["rb.example.com", "*.rb.example.com"]);
  assert.ok(info.validTo.getTime() > Date.now());
});

test("wildcards cover one subdomain label and never the apex", () => {
  const wildcardOnly = ["*.rb.example.com"];
  assert.equal(
    certificateCoversHost(wildcardOnly, "supabase.rb.example.com"),
    true,
  );
  assert.equal(certificateCoversHost(wildcardOnly, "rb.example.com"), false);
  assert.equal(
    certificateCoversHost(wildcardOnly, "a.b.rb.example.com"),
    false,
  );
  assert.equal(certificateCoversHost(["rb.example.com"], "RB.example.com"), true);
});

test("detects key/certificate pairing", () => {
  assert.equal(keyMatchesCertificate(CERT_PEM, KEY_PEM), true);
  assert.equal(keyMatchesCertificate(CERT_PEM, MISMATCHED_KEY_PEM), false);
});

test("required hostnames track the deployment's served surfaces", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  assert.deepEqual(requiredTlsHostnames(config), [
    "rb.example.com",
    "supabase.rb.example.com",
    "observability.rb.example.com",
  ]);

  config.features.observability = { clickstack: { enabled: false } };
  config.features.cache = {
    valkeyAdmin: { enabled: true, exposure: "ingress" },
  };
  assert.deepEqual(requiredTlsHostnames(config), [
    "rb.example.com",
    "supabase.rb.example.com",
    "valkey.rb.example.com",
  ]);
});

test("maps hostnames to the chart's expected TLS secret names", () => {
  const domain = "rb.example.com";
  assert.equal(tlsSecretNameForHost(domain, domain, "azpg"), "azpg-tls-secret");
  assert.equal(
    tlsSecretNameForHost(`supabase.${domain}`, domain, "azpg"),
    "azpg-supabase-kong-tls",
  );
  assert.equal(
    tlsSecretNameForHost(`observability.${domain}`, domain, "azpg"),
    "azpg-clickstack-hyperdx-tls",
  );
  assert.equal(
    tlsSecretNameForHost(`valkey.${domain}`, domain, "azpg"),
    "azpg-valkey-admin-tls",
  );
});

test("plans one secret per hostname from a covering wildcard certificate", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  const plan = planTlsSecretsFromPems(config, "rb", [
    { certPem: CERT_PEM, keyPem: KEY_PEM, label: "tls.crt" },
  ]);
  assert.deepEqual(
    plan.entries.map((e) => [e.host, e.secretName]),
    [
      ["rb.example.com", "rb-tls-secret"],
      ["supabase.rb.example.com", "rb-supabase-kong-tls"],
      ["observability.rb.example.com", "rb-clickstack-hyperdx-tls"],
    ],
  );
  assert.deepEqual(plan.warnings, []);
});

test("fails the plan with the exact uncovered hostname", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  // A Valkey admin UI on a hostname outside the certificate's SANs.
  config.features.cache = {
    valkeyAdmin: {
      enabled: true,
      exposure: "ingress",
      hostname: "valkey.other.example.net",
    },
  };
  assert.throws(
    () =>
      planTlsSecretsFromPems(config, "rb", [
        { certPem: CERT_PEM, keyPem: KEY_PEM, label: "tls.crt" },
      ]),
    /do not cover: valkey\.other\.example\.net/,
  );
});

test("fails the plan on a key that does not match its certificate", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  assert.throws(
    () =>
      planTlsSecretsFromPems(config, "rb", [
        { certPem: CERT_PEM, keyPem: MISMATCHED_KEY_PEM, label: "tls.crt" },
      ]),
    /private key does not match/,
  );
});

test("warns on certificates expiring within thirty days", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  const nearExpiry = new Date(
    parseCertificate(CERT_PEM).validTo.getTime() - 10 * 24 * 60 * 60 * 1000,
  );
  const plan = planTlsSecretsFromPems(
    config,
    "rb",
    [{ certPem: CERT_PEM, keyPem: KEY_PEM, label: "tls.crt" }],
    nearExpiry,
  );
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /expires on/);
});
