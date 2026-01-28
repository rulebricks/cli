import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useWizard } from "../WizardContext.js";
import { BorderBox } from "../../common/index.js";
import { generateSecureSecret } from "../../../lib/validation.js";

interface SupabaseCredentialsStepProps {
  onComplete: () => void;
  onBack: () => void;
}

type SubStep = "db-password" | "dashboard-user" | "dashboard-pass";

// Fixed JWT secret - users can edit this in the raw config if needed
const JWT_SECRET =
  "your-super-secret-jwt-token-with-at-least-32-characters-long";

export function SupabaseCredentialsStep({
  onComplete,
  onBack,
}: SupabaseCredentialsStepProps) {
  const { state, dispatch } = useWizard();

  // Generate defaults if not already set
  const defaultDbPass = state.supabaseDbPassword || generateSecureSecret(24);
  const defaultDashboardPass =
    state.supabaseDashboardPass || generateSecureSecret(16);

  const [subStep, setSubStep] = useState<SubStep>("db-password");
  const [dbPassword, setDbPassword] = useState(defaultDbPass);
  const [dashboardUser, setDashboardUser] = useState(
    state.supabaseDashboardUser || "supabase",
  );
  const [dashboardPass, setDashboardPass] = useState(defaultDashboardPass);
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape) {
      setError(null);
      if (subStep === "db-password") {
        onBack();
      } else if (subStep === "dashboard-user") {
        setSubStep("db-password");
      } else if (subStep === "dashboard-pass") {
        setSubStep("dashboard-user");
      }
    }
  });

  const handleDbPasswordSubmit = () => {
    if (!dbPassword || dbPassword.length < 8) {
      setError("Database password must be at least 8 characters");
      return;
    }
    setError(null);
    setSubStep("dashboard-user");
  };

  const handleDashboardUserSubmit = () => {
    if (!dashboardUser) {
      setError("Dashboard username is required");
      return;
    }
    setError(null);
    setSubStep("dashboard-pass");
  };

  const handleDashboardPassSubmit = () => {
    if (!dashboardPass || dashboardPass.length < 8) {
      setError("Dashboard password must be at least 8 characters");
      return;
    }
    setError(null);

    dispatch({
      type: "SET_SUPABASE_SELF_HOSTED",
      config: {
        supabaseJwtSecret: JWT_SECRET,
        supabaseDbPassword: dbPassword,
        supabaseDashboardUser: dashboardUser,
        supabaseDashboardPass: dashboardPass,
      },
    });

    onComplete();
  };

  const regenerateSecret = (field: "db" | "dashboard") => {
    if (field === "db") {
      setDbPassword(generateSecureSecret(24));
    } else {
      setDashboardPass(generateSecureSecret(16));
    }
  };

  return (
    <BorderBox title="Supabase Credentials">
      <Box flexDirection="column" marginY={1}>
        <Text color="gray" dimColor>
          Configure credentials for your self-hosted Supabase instance
        </Text>
        <Text color="yellow" dimColor>
          ⚠ Save these credentials securely - you'll need them to access
          Supabase
        </Text>
      </Box>

      {subStep === "db-password" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Database Password:</Text>
          <Text color="gray" dimColor>
            PostgreSQL database password
          </Text>
          <Text color="gray" dimColor>
            Default (press Enter to use): {defaultDbPass}
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={dbPassword}
              onChange={setDbPassword}
              onSubmit={handleDbPasswordSubmit}
              placeholder="Database password (min 8 chars)"
              mask="*"
            />
          </Box>
        </Box>
      )}

      {subStep === "dashboard-user" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Supabase Studio Username:</Text>
          <Text color="gray" dimColor>
            Username for accessing the Supabase dashboard
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={dashboardUser}
              onChange={setDashboardUser}
              onSubmit={handleDashboardUserSubmit}
              placeholder="supabase"
            />
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text color="green">✓</Text>
              <Text color="gray"> Database password configured</Text>
            </Box>
          </Box>
        </Box>
      )}

      {subStep === "dashboard-pass" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Supabase Studio Password:</Text>
          <Text color="gray" dimColor>
            Password for accessing the Supabase dashboard
          </Text>
          <Text color="gray" dimColor>
            Default (press Enter to use): {defaultDashboardPass}
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={dashboardPass}
              onChange={setDashboardPass}
              onSubmit={handleDashboardPassSubmit}
              placeholder="Dashboard password (min 8 chars)"
              mask="*"
            />
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text color="green">✓</Text>
              <Text color="gray"> Database password configured</Text>
            </Box>
            <Box>
              <Text color="green">✓</Text>
              <Text color="gray"> Dashboard user: {dashboardUser}</Text>
            </Box>
          </Box>
        </Box>
      )}

      {error && (
        <Box marginTop={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Esc to go back • Enter to continue
        </Text>
      </Box>
    </BorderBox>
  );
}
