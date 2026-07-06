import React from "react";
import { Box, Text } from "ink";
import { useWizard } from "../WizardContext.js";
import {
  BorderBox,
  CheckboxList,
  StepFooter,
  useGatedInput,
} from "../../common/index.js";

interface FeaturesStepProps {
  onComplete: () => void;
  onBack: () => void;
}

// Forwarding a copy of decision logs to a third-party platform (Datadog,
// Splunk, ...) is intentionally not offered here; it remains available for
// config-file/configure users via features.logging.sink.
export function FeaturesStep({ onComplete, onBack }: FeaturesStepProps) {
  const { state, dispatch } = useWizard();

  useGatedInput((_input, key) => {
    if (key.escape) onBack();
  });

  const toggle = (id: string) => {
    switch (id) {
      case "ai":
        dispatch({ type: "SET_AI_ENABLED", enabled: !state.aiEnabled });
        break;
      case "sso":
        dispatch({ type: "SET_SSO_ENABLED", enabled: !state.ssoEnabled });
        break;
      case "valkeyObservability": {
        const enabled = !state.valkeyAdminEnabled;
        dispatch({
          type: "SET_EXTERNAL_SERVICES",
          config: {
            valkeyAdminEnabled: enabled,
            redisExporterEnabled: enabled,
            kafkaExporterEnabled: enabled,
            valkeyAdminExposure: enabled ? "ingress" : "internal",
            valkeyAdminHostname: "",
            ...(enabled
              ? {}
              : { valkeyAdminBasicAuthUsers: [], valkeyAdminAllowedIPs: [] }),
          },
        });
        break;
      }
      case "customEmails":
        dispatch({
          type: "SET_CUSTOM_EMAILS_ENABLED",
          enabled: !state.customEmailsEnabled,
        });
        break;
    }
  };

  const anyEnabled =
    state.aiEnabled ||
    state.ssoEnabled ||
    state.valkeyAdminEnabled ||
    state.customEmailsEnabled;

  return (
    <BorderBox title="Optional Features">
      <CheckboxList
        label="Select features to enable"
        items={[
          {
            key: "ai",
            label: "AI Features",
            hint: "Enable AI-powered rule generation (requires OpenAI API key)",
            checked: state.aiEnabled,
          },
          {
            key: "sso",
            label: "Single Sign-On",
            hint: "Enable SSO via OIDC provider (Azure AD, Google, Okta, etc.)",
            checked: state.ssoEnabled,
          },
          {
            key: "valkeyObservability",
            label: "Valkey Admin + Cache Metrics",
            hint: "Deploy the Valkey Admin console (public via Traefik BasicAuth) and export Valkey/Kafka lag metrics to Prometheus.",
            checked: state.valkeyAdminEnabled,
          },
          {
            key: "customEmails",
            label: "Custom Email Templates",
            hint: "Use custom HTML templates for Supabase auth emails (invite, confirm, reset, etc.)",
            checked: state.customEmailsEnabled,
          },
        ]}
        onToggle={toggle}
        onContinue={onComplete}
      />

      {anyEnabled && (
        <Box>
          <Text color="yellow" dimColor>
            Enabled features will be configured in the next step
          </Text>
        </Box>
      )}
      <StepFooter hints={["Space/Enter to toggle", "Esc to go back"]} />
    </BorderBox>
  );
}
