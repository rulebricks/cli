// Kubernetes Secret management for k8s secret mode.
//
// In k8s mode the CLI creates the deployment's Secrets directly (idempotent
// `kubectl apply`) and the generated values.yaml carries only secretRef
// references — no plaintext secrets on disk or in the Helm release. Secret names
// come from deploymentSecretNames() so they always match the secretRef seams the
// value generator writes.
import { execa } from "execa";
import { DeploymentConfig } from "../types/index.js";
import {
  signSupabaseJwt,
  deriveRealtimeSecrets,
  deploymentSecretNames,
} from "./helmValues.js";

export interface K8sSecretManifest {
  name: string;
  stringData: Record<string, string>;
}

/**
 * Build the Kubernetes Secret manifests for a deployment. Only includes values
 * that are actually set. Supabase anon/service keys are derived from the JWT
 * secret (HS256), matching self-hosted Supabase.
 */
export function buildDeploymentSecrets(
  config: DeploymentConfig,
): K8sSecretManifest[] {
  const names = deploymentSecretNames(config);
  const out: K8sSecretManifest[] = [];

  // Consolidated app secret (global.secrets.secretRef).
  const app: Record<string, string> = {};
  const put = (k: string, v?: string) => {
    if (v) app[k] = v;
  };
  put("LICENSE_KEY", config.licenseKey);
  put("EMAIL", config.adminEmail);
  put("SMTP_USER", config.smtp?.user);
  put("SMTP_PASS", config.smtp?.pass);
  if (config.database.type === "supabase-cloud") {
    put("SUPABASE_ANON_KEY", config.database.supabaseAnonKey);
    put("SUPABASE_SERVICE_KEY", config.database.supabaseServiceKey);
    put("SUPABASE_SECRET_KEY", config.database.supabaseServiceKey);
    put("SUPABASE_ACCESS_TOKEN", config.database.supabaseAccessToken);
  } else if (config.database.supabaseJwtSecret) {
    const jwt = config.database.supabaseJwtSecret;
    put("SUPABASE_ANON_KEY", signSupabaseJwt("anon", jwt));
    put("SUPABASE_SERVICE_KEY", signSupabaseJwt("service_role", jwt));
    put("SUPABASE_SECRET_KEY", signSupabaseJwt("service_role", jwt));
    put("JWT_SECRET", jwt);
  }
  if (config.features.ai.enabled) {
    put("OPENAI_API_KEY", config.features.ai.openaiApiKey);
  }
  if (config.features.sso.enabled) {
    put("SSO_CLIENT_ID", config.features.sso.clientId);
    put("SSO_CLIENT_SECRET", config.features.sso.clientSecret);
  }
  const redis = config.externalServices?.redis?.external;
  if (redis?.password) put("REDIS_PASSWORD", redis.password);
  const kafkaSasl = config.externalServices?.kafka?.external?.sasl;
  if (kafkaSasl?.username) put("KAFKA_SASL_USERNAME", kafkaSasl.username);
  if (kafkaSasl?.password) put("KAFKA_SASL_PASSWORD", kafkaSasl.password);
  if (Object.keys(app).length > 0) {
    out.push({ name: names.app, stringData: app });
  }

  // Supabase self-hosted component secrets (each maps to a supabase.secret.*.secretRef).
  if (config.database.type === "self-hosted") {
    const pgExt =
      config.externalServices?.postgres?.mode === "external"
        ? config.externalServices.postgres.external
        : undefined;
    const dbStringData: Record<string, string> = {
      username: "postgres",
      password: config.database.supabaseDbPassword ?? "",
      database: pgExt?.database ?? "postgres",
    };
    if (pgExt) {
      dbStringData.host = pgExt.host ?? "";
      dbStringData.port = String(pgExt.port ?? 5432);
    }
    out.push({
      name: names.db,
      stringData: dbStringData,
    });
    if (pgExt) {
      out.push({
        name: names.dbBootstrap,
        stringData: {
          "master-username": pgExt.bootstrap?.masterUsername ?? "postgres",
          "master-password": pgExt.bootstrap?.masterPassword ?? "",
          "service-password": config.database.supabaseDbPassword ?? "",
        },
      });
    }
    const jwt = config.database.supabaseJwtSecret ?? "";
    out.push({
      name: names.jwt,
      stringData: {
        secret: jwt,
        anonKey: jwt ? signSupabaseJwt("anon", jwt) : "",
        serviceKey: jwt ? signSupabaseJwt("service_role", jwt) : "",
      },
    });
    out.push({
      name: names.dashboard,
      stringData: {
        username: config.database.supabaseDashboardUser || "supabase",
        password: config.database.supabaseDashboardPass ?? "",
      },
    });
    const rt = deriveRealtimeSecrets(jwt);
    out.push({
      name: names.realtime,
      stringData: { SECRET_KEY_BASE: rt.secretKeyBase, DB_ENC_KEY: rt.dbEncKey },
    });
    // Supabase auth (GoTrue) SMTP, when configured.
    if (config.smtp?.user || config.smtp?.pass) {
      out.push({
        name: names.smtp,
        stringData: {
          username: config.smtp.user ?? "",
          password: config.smtp.pass ?? "",
        },
      });
    }
  }

  return out;
}

function secretManifest(
  name: string,
  namespace: string,
  stringData: Record<string, string>,
): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: { name, namespace },
    stringData,
  };
}

/**
 * Idempotently ensure the namespace exists so Secrets can be applied before Helm
 * runs (`helm upgrade --install --create-namespace` also creates it, but that
 * happens after this step).
 */
export async function ensureNamespace(namespace: string): Promise<void> {
  const manifest = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: namespace },
  };
  await execa("kubectl", ["apply", "-f", "-"], {
    input: JSON.stringify(manifest),
  });
}

/**
 * Create/update the deployment's Kubernetes Secrets. `kubectl apply` is an
 * upsert, so upgrades and redeploys never wipe or churn the Secrets. Returns the
 * names applied.
 */
export async function applyDeploymentSecrets(
  config: DeploymentConfig,
  namespace: string,
): Promise<string[]> {
  const secrets = buildDeploymentSecrets(config);
  for (const s of secrets) {
    await execa("kubectl", ["apply", "-f", "-"], {
      input: JSON.stringify(secretManifest(s.name, namespace, s.stringData)),
    });
  }
  return secrets.map((s) => s.name);
}
