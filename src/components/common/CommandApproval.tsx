import React, { createContext, ReactNode, useContext, useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { useTheme } from "../../lib/theme.js";
import {
  CommandApprovalScope,
  getCurrentCommandApproval,
  PendingCommandApproval,
  respondToCommandApproval,
  setCommandApprovalInteractive,
  subscribeCommandApprovals,
} from "../../lib/commandApproval.js";

interface CommandApprovalContextValue {
  pending: boolean;
}

const CommandApprovalContext = createContext<CommandApprovalContextValue>({
  pending: false,
});

interface CommandApprovalProviderProps {
  children: ReactNode;
}

export function CommandApprovalProvider({
  children,
}: CommandApprovalProviderProps) {
  const [pending, setPending] = useState<PendingCommandApproval | null>(
    getCurrentCommandApproval(),
  );

  useEffect(() => {
    setCommandApprovalInteractive(true);
    const unsubscribe = subscribeCommandApprovals(() => {
      setPending(getCurrentCommandApproval());
    });
    setPending(getCurrentCommandApproval());

    return () => {
      unsubscribe();
      setCommandApprovalInteractive(false);
    };
  }, []);

  return (
    <CommandApprovalContext.Provider value={{ pending: pending !== null }}>
      <Box flexDirection="column">
        <Box display={pending ? "none" : "flex"} flexDirection="column">
          {children}
        </Box>
        {pending && <CommandApprovalScreen request={pending} />}
      </Box>
    </CommandApprovalContext.Provider>
  );
}

export function useCommandApproval() {
  return useContext(CommandApprovalContext);
}

export function useGatedInput(
  inputHandler: Parameters<typeof useInput>[0],
  options: Parameters<typeof useInput>[1] = {},
) {
  const { pending } = useCommandApproval();
  useInput(inputHandler, {
    ...options,
    isActive: (options?.isActive ?? true) && !pending,
  });
}

interface ApprovalItem {
  label: string;
  value: CommandApprovalScope | "deny";
}

function CommandApprovalScreen({
  request,
}: {
  request: PendingCommandApproval;
}) {
  const { colors } = useTheme();
  const tagColor = request.mutating ? colors.warning : colors.success;
  const tag = request.mutating ? "modifies cloud resources" : "read-only";
  const provider = request.provider ? request.provider.toUpperCase() : "CLOUD CLI";

  const approve = (scope: CommandApprovalScope) => {
    respondToCommandApproval(request.id, "approve", scope);
  };

  const deny = () => {
    respondToCommandApproval(request.id, "deny", "once");
  };

  useInput((input) => {
    if (input === "y" || input === "Y") {
      approve("once");
    } else if (input === "a" || input === "A") {
      approve("all-like");
    } else if (input === "n" || input === "N") {
      deny();
    }
  });

  const items: ApprovalItem[] = [
    { label: "Approve", value: "once" },
    { label: `Approve all "${request.intent}" commands`, value: "all-like" },
    { label: "Deny", value: "deny" },
  ];

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text color={colors.accent}>
        ┌─ Cloud CLI Approval {"─".repeat(51)}┐
      </Text>
      <Box flexDirection="column" paddingX={2} paddingY={1} width={76}>
        <Box>
          <Text color={colors.accent} bold>
            {request.intent}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text color={colors.muted}>{provider}</Text>
          <Text color={colors.muted}> • </Text>
          <Text color={tagColor}>{tag}</Text>
        </Box>
        {request.description && (
          <Box marginTop={1}>
            <Text color={colors.muted}>{request.description}</Text>
          </Box>
        )}
        <Box marginTop={1} flexDirection="column">
          <Text>The Rulebricks CLI wants to run:</Text>
          <Box flexDirection="column" marginTop={1} paddingX={1}>
            {wrapCommand(request.command).map((line, index) => (
              <Text key={index} color={colors.accentBright}>
                {index === 0 ? "$ " : "  "}
                {line}
              </Text>
            ))}
          </Box>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <SelectInput
            items={items}
            onSelect={(item: ApprovalItem) => {
              if (item.value === "deny") {
                deny();
              } else {
                approve(item.value);
              }
            }}
            indicatorComponent={() => null}
            itemComponent={({ isSelected, label }) => (
              <Text color={isSelected ? colors.accent : undefined}>
                {isSelected ? "> " : "  "}
                {label}
              </Text>
            )}
          />
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text color={colors.muted} dimColor>
            y approve • a approve all like this • n deny
          </Text>
          <Text color={colors.muted} dimColor>
            You can run this yourself in another terminal, then choose Deny.
          </Text>
        </Box>
      </Box>
      <Text color={colors.accent}>└{"─".repeat(74)}┘</Text>
    </Box>
  );
}

function wrapCommand(command: string, width = 68): string[] {
  const words = command.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (`${current} ${word}`.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = `${current} ${word}`;
    }
  }

  if (current) lines.push(current);
  return lines.length > 0 ? lines : [command];
}
