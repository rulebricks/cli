import React, { useState } from "react";
import { useWizard } from "../WizardContext.js";
import { useFieldFlow, FlowField } from "../fieldFlow.js";
import {
  BorderBox,
  CheckRows,
  FieldError,
  StepFooter,
  TextField,
  WizardSelect,
} from "../../common/index.js";
import { DatabaseType } from "../../../types/index.js";

interface DatabaseStepProps {
  onComplete: () => void;
  onBack: () => void;
  entryDirection?: "forward" | "back";
}

const DATABASE_TYPES = [
  { label: "Self-hosted Supabase", value: "self-hosted" },
  { label: "Supabase Cloud", value: "supabase-cloud" },
];

export function DatabaseStep({
  onComplete,
  onBack,
  entryDirection,
}: DatabaseStepProps) {
  const { state, dispatch } = useWizard();
  const [error, setError] = useState<string | null>(null);

  const [dbType, setDbType] = useState<DatabaseType | null>(state.databaseType);
  const [supabaseUrl, setSupabaseUrl] = useState(state.supabaseUrl || "");
  const [anonKey, setAnonKey] = useState(state.supabaseAnonKey || "");
  const [serviceKey, setServiceKey] = useState(state.supabaseServiceKey || "");
  const [accessToken, setAccessToken] = useState(
    state.supabaseAccessToken || "",
  );

  const cloud = () => dbType === "supabase-cloud";

  const fields: FlowField[] = [
    {
      id: "type",
      render: (flow) => (
        <WizardSelect
          label="Choose your database setup"
          hint="Self-hosted deploys Supabase as part of the Helm chart; Supabase Cloud uses your existing project."
          items={DATABASE_TYPES}
          initialValue={dbType ?? undefined}
          onSelect={(value) => {
            const selected = value as DatabaseType;
            setDbType(selected);
            dispatch({ type: "SET_DATABASE_TYPE", dbType: selected });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "supabase-url",
      when: cloud,
      render: (flow) => (
        <TextField
          label="Supabase project URL"
          hint="Find this in your Supabase Dashboard under Project Settings"
          value={supabaseUrl}
          onChange={setSupabaseUrl}
          placeholder="https://xxxxx.supabase.co"
          onSubmit={() => {
            if (!supabaseUrl) {
              setError("Supabase project URL is required");
              return;
            }
            setError(null);
            dispatch({ type: "SET_SUPABASE_CONFIG", config: { supabaseUrl } });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "anon-key",
      when: cloud,
      render: (flow) => (
        <TextField
          label="Anon (public) key"
          value={anonKey}
          onChange={setAnonKey}
          placeholder="eyJhbGciOiJIUzI1NiIs..."
          onSubmit={() => {
            if (!anonKey) {
              setError("Anon key is required");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_SUPABASE_CONFIG",
              config: { supabaseAnonKey: anonKey },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "service-key",
      when: cloud,
      render: (flow) => (
        <TextField
          label="Service role key"
          value={serviceKey}
          onChange={setServiceKey}
          placeholder="eyJhbGciOiJIUzI1NiIs..."
          onSubmit={() => {
            if (!serviceKey) {
              setError("Service role key is required");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_SUPABASE_CONFIG",
              config: {
                supabaseAnonKey: anonKey,
                supabaseServiceKey: serviceKey,
              },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "access-token",
      when: cloud,
      render: (flow) => (
        <TextField
          label="Supabase Access Token"
          hint="Account Settings > Access Tokens. Required for managing your Supabase project."
          value={accessToken}
          onChange={setAccessToken}
          placeholder="sbp_..."
          mask
          onSubmit={() => {
            if (!accessToken) {
              setError("Access token is required");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_SUPABASE_CONFIG",
              config: { supabaseAccessToken: accessToken },
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
    const rows: { label: string }[] = [];
    if (cloud() && supabaseUrl && flow.current !== "supabase-url") {
      rows.push({ label: "Supabase URL configured" });
    }
    if (cloud() && anonKey && serviceKey && flow.current === "access-token") {
      rows.push({ label: "API keys configured" });
    }
    return rows;
  };

  return (
    <BorderBox title="Database">
      {flow.render()}

      <CheckRows rows={progress()} />
      <FieldError error={error} />
      <StepFooter />
    </BorderBox>
  );
}
