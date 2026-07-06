import React, { useState } from "react";
import { Box, Text } from "ink";
import { useWizard } from "../WizardContext.js";
import { useFieldFlow, FlowField } from "../fieldFlow.js";
import {
  BorderBox,
  CheckRows,
  FieldError,
  StepFooter,
  TextField,
} from "../../common/index.js";
import { generateSecureSecret } from "../../../lib/validation.js";

interface SupabaseCredentialsStepProps {
  onComplete: () => void;
  onBack: () => void;
  entryDirection?: "forward" | "back";
}

export function SupabaseCredentialsStep({
  onComplete,
  onBack,
  entryDirection,
}: SupabaseCredentialsStepProps) {
  const { state, dispatch } = useWizard();
  const [error, setError] = useState<string | null>(null);

  // Secure fallbacks used only when the user leaves a field empty. Generated
  // once so they stay stable across renders. The inputs themselves start empty
  // (or prefilled with an existing value when editing) so there's no confusing
  // pre-filled secret to clear.
  const [defaultDbPass] = useState(() => generateSecureSecret(24));
  const [defaultDashboardPass] = useState(() => generateSecureSecret(16));
  const [defaultJwtSecret] = useState(
    () => state.supabaseJwtSecret || generateSecureSecret(64),
  );

  const [dbPassword, setDbPassword] = useState(state.supabaseDbPassword || "");
  const [dashboardUser, setDashboardUser] = useState(
    state.supabaseDashboardUser || "supabase",
  );
  const [dashboardPass, setDashboardPass] = useState(
    state.supabaseDashboardPass || "",
  );

  const fields: FlowField[] = [
    {
      id: "db-password",
      render: (flow) => (
        <TextField
          label="Database Password"
          hint="PostgreSQL database password. Leave empty to generate a secure value."
          value={dbPassword}
          onChange={setDbPassword}
          placeholder="Leave empty to generate a secure value"
          mask
          onSubmit={() => {
            const effective = dbPassword.trim() || defaultDbPass;
            if (effective.length < 8) {
              setError("Database password must be at least 8 characters");
              return;
            }
            setDbPassword(effective);
            setError(null);
            dispatch({
              type: "SET_SUPABASE_SELF_HOSTED",
              config: { supabaseDbPassword: effective },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "dashboard-user",
      render: (flow) => (
        <TextField
          label="Supabase Studio Username"
          hint="Username for accessing the Supabase dashboard"
          value={dashboardUser}
          onChange={setDashboardUser}
          placeholder="supabase"
          onSubmit={() => {
            if (!dashboardUser) {
              setError("Dashboard username is required");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_SUPABASE_SELF_HOSTED",
              config: { supabaseDashboardUser: dashboardUser },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "dashboard-pass",
      render: (flow) => (
        <TextField
          label="Supabase Studio Password"
          hint="Password for accessing the Supabase dashboard. Leave empty to generate a secure value."
          value={dashboardPass}
          onChange={setDashboardPass}
          placeholder="Leave empty to generate a secure value"
          mask
          onSubmit={() => {
            const effectivePass = dashboardPass.trim() || defaultDashboardPass;
            if (effectivePass.length < 8) {
              setError("Dashboard password must be at least 8 characters");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_SUPABASE_SELF_HOSTED",
              config: {
                supabaseJwtSecret: defaultJwtSecret,
                supabaseDbPassword: dbPassword.trim() || defaultDbPass,
                supabaseDashboardUser: dashboardUser,
                supabaseDashboardPass: effectivePass,
              },
            });
            flow.next();
          }}
        />
      ),
    },
  ];

  const flow = useFieldFlow({
    fields,
    onDone: onComplete,
    onExit: onBack,
    entry: entryDirection === "back" ? "end" : "start",
    onNavigate: () => setError(null),
  });

  const progress = () => {
    const rows: { label: string; value?: string }[] = [];
    if (flow.current !== "db-password" && dbPassword) {
      rows.push({ label: "Database password configured" });
    }
    if (flow.current === "dashboard-pass") {
      rows.push({ label: "Dashboard user", value: dashboardUser });
    }
    return rows;
  };

  return (
    <BorderBox title="Supabase Credentials">
      <Box flexDirection="column" marginY={1}>
        <Text color="gray" dimColor>
          Configure credentials for your self-hosted Supabase instance
        </Text>
        <Text color="yellow" dimColor>
          Save these credentials securely - you'll need them to access Supabase
        </Text>
      </Box>

      {flow.render()}

      <CheckRows rows={progress()} />
      <FieldError error={error} />
      <StepFooter />
    </BorderBox>
  );
}
