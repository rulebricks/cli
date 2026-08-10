import React, { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import {
  BorderBox,
  CommandApprovalProvider,
  DiscoveredSelect,
  Logo,
  Spinner,
  StatusLine,
  TextField,
  ThemeProvider,
  useGatedInput,
  useTheme,
  WizardSelect,
} from "../components/common/index.js";
import {
  loadDeploymentConfig,
  loadDeploymentState,
  saveDeploymentState,
} from "../lib/config.js";
import {
  assignVmSystemIdentity,
  checkAzureCli,
  deleteAzureRoleAssignment,
  ensureAzureRoleAssignment,
  formatAzureRoleAssignmentCreateCommand,
  formatAzureRoleAssignmentDeleteCommand,
  getAksClusterFacts,
  getAzureKeyVaultId,
  listAzureResourceGroups,
  listAzureVms,
  resolveAzureContainerRegistryId,
  shouldMirrorToAcr,
} from "../lib/cloudCli.js";
import { CommandDeniedError } from "../lib/commandApproval.js";
import {
  azureResourceGroupScope,
  deriveHostGrantPlan,
  diffHostGrants,
  formatGrantDeniedWarning,
  type HostGrantDeniedBinding,
  type HostRoleGrant,
} from "../lib/hostGrant.js";
import type {
  DeploymentConfig,
  DeploymentState,
  LinkedDeploymentHost,
  LinkedHostGrant,
} from "../types/index.js";

interface HostCommandProps {
  name: string;
}

interface VmSelection {
  name: string;
  resourceGroup: string;
}

type ProgressStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "skipped";

interface ProgressRow {
  status: ProgressStatus;
  detail?: string;
}

type GrantStep =
  | "loading"
  | "intro"
  | "preflight"
  | "select-resource-group"
  | "manual-resource-group"
  | "select-vm"
  | "manual-vm-name"
  | "resolving"
  | "review"
  | "executing"
  | "complete"
  | "error";

function sameHost(host: LinkedDeploymentHost, vm: VmSelection): boolean {
  return (
    host.vmName.toLowerCase() === vm.name.toLowerCase() &&
    host.vmResourceGroup.toLowerCase() === vm.resourceGroup.toLowerCase()
  );
}

function roleKey(grant: Pick<HostRoleGrant, "role" | "scope">): string {
  return `${grant.role.toLowerCase()}\0${grant.scope.toLowerCase()}`;
}

function linkedGrantPrincipal(
  grant: LinkedHostGrant,
  activePrincipalId: string,
): string {
  return grant.principalId ?? activePrincipalId;
}

function linkedGrantKey(
  grant: LinkedHostGrant,
  activePrincipalId: string,
): string {
  return `${linkedGrantPrincipal(grant, activePrincipalId).toLowerCase()}\0${roleKey(
    grant,
  )}`;
}

function encodeVm(vm: VmSelection): string {
  return JSON.stringify(vm);
}

function decodeVm(value: string): VmSelection {
  const parsed = JSON.parse(value) as Partial<VmSelection>;
  if (!parsed.name || !parsed.resourceGroup) {
    throw new Error("The selected Azure VM is missing a name or resource group.");
  }
  return { name: parsed.name, resourceGroup: parsed.resourceGroup };
}

function stateWithLinkedHost(
  config: DeploymentConfig,
  state: DeploymentState | null,
  linkedHost: LinkedDeploymentHost,
): DeploymentState {
  const now = new Date().toISOString();
  const infrastructure =
    config.infrastructure.provider &&
    config.infrastructure.region &&
    config.infrastructure.clusterName
      ? {
          provider: config.infrastructure.provider,
          region: config.infrastructure.region,
          clusterName: config.infrastructure.clusterName,
        }
      : undefined;
  return {
    ...(state ?? {
      name: config.name,
      version: config.version,
      createdAt: now,
      status: "pending" as const,
      infrastructure,
    }),
    updatedAt: now,
    linkedHost,
  };
}

function HostLinkCommandInner({ name }: HostCommandProps) {
  const { exit } = useApp();
  const { colors } = useTheme();
  const [step, setStep] = useState<GrantStep>("loading");
  const [config, setConfig] = useState<DeploymentConfig | null>(null);
  const [deploymentState, setDeploymentState] =
    useState<DeploymentState | null>(null);
  const [selectedVm, setSelectedVm] = useState<VmSelection | null>(null);
  const [manualVmName, setManualVmName] = useState("");
  const [vmResourceGroup, setVmResourceGroup] = useState("");
  const [plan, setPlan] = useState<HostRoleGrant[]>([]);
  const [grantsToApply, setGrantsToApply] = useState<HostRoleGrant[]>([]);
  const [identityStatus, setIdentityStatus] = useState<ProgressRow>({
    status: "pending",
  });
  const [grantStatuses, setGrantStatuses] = useState<
    Record<string, ProgressRow>
  >({});
  const [denied, setDenied] = useState<HostGrantDeniedBinding[]>([]);
  const [principalId, setPrincipalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [loadedConfig, loadedState] = await Promise.all([
          loadDeploymentConfig(name),
          loadDeploymentState(name),
        ]);
        if (loadedConfig.infrastructure.provider !== "azure") {
          throw new Error(
            "Deploy host linking currently supports Azure deployments only.",
          );
        }
        if (
          !loadedConfig.infrastructure.clusterName ||
          !loadedConfig.infrastructure.azureResourceGroup
        ) {
          throw new Error(
            "The deployment needs an AKS cluster name and Azure resource group before a host can be linked.",
          );
        }
        if (!active) return;
        setConfig(loadedConfig);
        setDeploymentState(loadedState);
        setVmResourceGroup(
          loadedState?.linkedHost?.vmResourceGroup ??
            loadedConfig.infrastructure.azureResourceGroup,
        );
        setStep("intro");
      } catch (loadError) {
        if (!active) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Could not load the deployment.",
        );
        setStep("error");
      }
    })();
    return () => {
      active = false;
    };
  }, [name]);

  async function checkAzureThen(nextVm?: VmSelection) {
    if (!config) return;
    setStep("preflight");
    try {
      const azure = await checkAzureCli();
      if (!azure.installed) {
        throw new Error("Azure CLI is not installed on this machine.");
      }
      if (!azure.authenticated) {
        throw new Error(azure.error || 'Run "az login" and try again.');
      }
      if (nextVm) {
        await resolvePlan(nextVm);
      } else {
        setStep("select-resource-group");
      }
    } catch (preflightError) {
      setError(
        preflightError instanceof Error
          ? preflightError.message
          : "Azure CLI preflight failed.",
      );
      setStep("error");
    }
  }

  async function resolvePlan(vm: VmSelection) {
    if (!config) return;
    setSelectedVm(vm);
    setStep("resolving");
    try {
      const clusterName = config.infrastructure.clusterName!;
      const resourceGroup = config.infrastructure.azureResourceGroup!;
      const cluster = await getAksClusterFacts(clusterName, resourceGroup);
      let keyVaultId: string | undefined;
      let acrId: string | undefined;

      if (config.secrets?.backend === "azure-key-vault") {
        const vaultName = config.secrets.azure?.vaultName;
        if (!vaultName) {
          throw new Error(
            "The deployment uses Azure Key Vault but has no vault name configured.",
          );
        }
        keyVaultId = await getAzureKeyVaultId(vaultName);
      }

      if (shouldMirrorToAcr(config)) {
        const registryName = config.imageRegistry!.split(".")[0];
        acrId = await resolveAzureContainerRegistryId(
          registryName,
          config.imageRegistryResourceId,
        );
      }

      const nextPlan = deriveHostGrantPlan(config, {
        clusterId: cluster.id,
        resourceGroupId: azureResourceGroupScope(cluster.id),
        entraRbacEnabled: cluster.entraRbacEnabled,
        keyVaultId,
        acrId,
      });
      const persisted =
        deploymentState?.linkedHost &&
        sameHost(deploymentState.linkedHost, vm)
          ? deploymentState.linkedHost.grants.filter(
              (grant) =>
                linkedGrantPrincipal(
                  grant,
                  deploymentState.linkedHost!.principalId,
                ) === deploymentState.linkedHost!.principalId,
            )
          : [];
      const missing = diffHostGrants(nextPlan, persisted);
      const missingKeys = new Set(missing.map(roleKey));
      setPlan(nextPlan);
      setGrantsToApply(missing);
      setGrantStatuses(
        Object.fromEntries(
          nextPlan.map((grant) => [
            roleKey(grant),
            missingKeys.has(roleKey(grant))
              ? { status: "pending" }
              : { status: "skipped", detail: "already linked" },
          ]),
        ),
      );
      setStep("review");
    } catch (resolveError) {
      setError(
        resolveError instanceof Error
          ? resolveError.message
          : "Could not resolve Azure resources.",
      );
      setStep("error");
    }
  }

  async function persistLinkedHost(
    workingState: DeploymentState | null,
    vm: VmSelection,
    identityPrincipalId: string,
    grants: LinkedHostGrant[],
    linkedAt: string,
  ): Promise<DeploymentState> {
    if (!config) throw new Error("Deployment config is not loaded.");
    const nextState = stateWithLinkedHost(config, workingState, {
      provider: "azure",
      vmName: vm.name,
      vmResourceGroup: vm.resourceGroup,
      principalId: identityPrincipalId,
      grants,
      linkedAt,
    });
    await saveDeploymentState(name, nextState);
    return nextState;
  }

  async function executeGrant() {
    if (!config || !selectedVm) return;
    setStep("executing");
    setDenied([]);
    setIdentityStatus({ status: "running" });

    try {
      const identity = await assignVmSystemIdentity(
        selectedVm.name,
        selectedVm.resourceGroup,
      );
      setPrincipalId(identity.principalId);
      setIdentityStatus({ status: "success", detail: identity.principalId });

      const storedHost = deploymentState?.linkedHost;
      const previousHost =
        storedHost && sameHost(storedHost, selectedVm) ? storedHost : undefined;
      const replacedHost =
        storedHost && !sameHost(storedHost, selectedVm) ? storedHost : undefined;
      const linkedAt = previousHost?.linkedAt ?? new Date().toISOString();
      let records = previousHost
        ? [...previousHost.grants]
        : (replacedHost?.grants ?? [])
            .filter((record) => record.createdByRulebricks)
            .map((record) => ({
              ...record,
              principalId: linkedGrantPrincipal(
                record,
                replacedHost!.principalId,
              ),
            }));
      const plannedKeys = new Set(plan.map(roleKey));
      records = [
        ...records.filter(
          (record) =>
            linkedGrantPrincipal(record, identity.principalId) !==
              identity.principalId ||
            !plannedKeys.has(
              roleKey({ role: record.role, scope: record.scope }),
            ),
        ),
        ...plan.map((grant) => {
          const existing = records.find(
            (record) =>
              linkedGrantPrincipal(record, identity.principalId) ===
                identity.principalId &&
              roleKey({ role: record.role, scope: record.scope }) ===
              roleKey(grant),
          );
          return (
            existing ?? {
              role: grant.role,
              scope: grant.scope,
              status: "pending" as const,
              principalId: identity.principalId,
              createdByRulebricks: false,
            }
          );
        }),
      ];

      let workingState = await persistLinkedHost(
        deploymentState,
        selectedVm,
        identity.principalId,
        records,
        linkedAt,
      );
      const deniedBindings: HostGrantDeniedBinding[] = [];

      for (const grant of grantsToApply) {
        const key = roleKey(grant);
        setGrantStatuses((current) => ({
          ...current,
          [key]: { status: "running" },
        }));
        const request = {
          principalId: identity.principalId,
          role: grant.role,
          scope: grant.scope,
        };

        try {
          const result = await ensureAzureRoleAssignment(request);
          if (result.status === "denied") {
            deniedBindings.push({
              subject: `${grant.role} on ${grant.scopeLabel}`,
              command: result.command,
            });
            records = records.map((record) =>
              linkedGrantPrincipal(record, identity.principalId) ===
                identity.principalId &&
              roleKey({ role: record.role, scope: record.scope }) === key
                ? { ...record, status: "pending" as const }
                : record,
            );
            setGrantStatuses((current) => ({
              ...current,
              [key]: {
                status: "skipped",
                detail: "administrator action required",
              },
            }));
          } else {
            records = records.map((record) =>
              linkedGrantPrincipal(record, identity.principalId) ===
                identity.principalId &&
              roleKey({ role: record.role, scope: record.scope }) === key
                ? {
                    ...record,
                    status: "granted" as const,
                    createdByRulebricks:
                      record.createdByRulebricks || result.status === "created",
                  }
                : record,
            );
            setGrantStatuses((current) => ({
              ...current,
              [key]: {
                status: result.status === "created" ? "success" : "skipped",
                detail:
                  result.status === "created"
                    ? "granted"
                    : "already assigned",
              },
            }));
          }
        } catch (grantError) {
          if (!(grantError instanceof CommandDeniedError)) throw grantError;
          deniedBindings.push({
            subject: `${grant.role} on ${grant.scopeLabel}`,
            command: formatAzureRoleAssignmentCreateCommand(request),
          });
          setGrantStatuses((current) => ({
            ...current,
            [key]: { status: "skipped", detail: "approval denied" },
          }));
        }

        workingState = await persistLinkedHost(
          workingState,
          selectedVm,
          identity.principalId,
          records,
          linkedAt,
        );
      }

      const previousAssignments = records.filter(
        (record) =>
          record.createdByRulebricks &&
          linkedGrantPrincipal(record, identity.principalId) !==
            identity.principalId,
      );
      if (previousAssignments.length > 0) {
        const previousHostLabel =
          replacedHost?.vmName ?? "a previous linked host";
        for (const record of previousAssignments) {
          const request = {
            principalId: linkedGrantPrincipal(record, identity.principalId),
            role: record.role,
            scope: record.scope,
          };
          try {
            const result = await deleteAzureRoleAssignment(request);
            if (result.status === "denied") {
              deniedBindings.push({
                subject: `Remove ${record.role} from ${previousHostLabel}`,
                command: result.command,
              });
            } else {
              const removedKey = linkedGrantKey(record, identity.principalId);
              records = records.filter(
                (candidate) =>
                  linkedGrantKey(candidate, identity.principalId) !==
                  removedKey,
              );
            }
          } catch {
            deniedBindings.push({
              subject: `Remove ${record.role} from ${previousHostLabel}`,
              command: formatAzureRoleAssignmentDeleteCommand(request),
            });
          }
        }
        workingState = await persistLinkedHost(
          workingState,
          selectedVm,
          identity.principalId,
          records,
          linkedAt,
        );
      }

      setDenied(deniedBindings);
      setDeploymentState(workingState);
      setStep("complete");
    } catch (grantError) {
      setIdentityStatus((current) =>
        current.status === "running" ? { status: "error" } : current,
      );
      setError(
        grantError instanceof CommandDeniedError
          ? "Managed identity setup was denied. No host access was changed."
          : grantError instanceof Error
            ? grantError.message
            : "Could not link the deploy host.",
      );
      setStep("error");
    }
  }

  useGatedInput(
    (_input, key) => {
      if (step === "intro" && !deploymentState?.linkedHost && key.return) {
        void checkAzureThen();
      } else if (step === "select-resource-group" && key.escape) {
        setStep("intro");
      } else if (step === "manual-resource-group" && key.escape) {
        setStep("select-resource-group");
      } else if (step === "select-vm" && key.escape) {
        setStep("select-resource-group");
      } else if (step === "manual-vm-name" && key.escape) {
        setStep("select-vm");
      } else if (step === "review" && key.return) {
        void executeGrant();
      } else if (
        key.escape &&
        (step === "intro" ||
          step === "review" ||
          step === "complete" ||
          step === "error")
      ) {
        exit();
      } else if (
        key.return &&
        (step === "complete" || step === "error")
      ) {
        exit();
      }
    },
    {
      isActive:
        step !== "intro" ||
        !deploymentState?.linkedHost,
    },
  );

  if (step === "loading") {
    return (
      <BorderBox title="Link Deploy Host">
        <Box marginY={1}>
          <Spinner label="Loading deployment..." />
        </Box>
      </BorderBox>
    );
  }

  if (step === "intro") {
    const linkedHost = deploymentState?.linkedHost;
    return (
      <BorderBox title={`Link Deploy Host · ${name}`}>
        <Box flexDirection="column" marginY={1}>
          <Text>This sets up an Azure VM to run Rulebricks CLI commands.</Text>
          <Box flexDirection="column" marginTop={1}>
            <Text color={colors.muted}>
              1. Select the resource group and jumpbox or bastion VM
            </Text>
            <Text color={colors.muted}>
              2. Enable its system-assigned managed identity
            </Text>
            <Text color={colors.muted}>
              3. Grant only the access required by this deployment
            </Text>
            <Text color={colors.muted}>
              4. Save the link for future access updates or unlinking
            </Text>
          </Box>
          {linkedHost ? (
            <WizardSelect
              label="This deployment already has a linked host"
              hint={`${linkedHost.vmName} in ${linkedHost.vmResourceGroup}`}
              initialValue="update"
              items={[
                {
                  label: `Update access for ${linkedHost.vmName}`,
                  value: "update",
                },
                { label: "Choose a different Azure VM", value: "replace" },
              ]}
              onSelect={(value) => {
                if (value === "update") {
                  void checkAzureThen({
                    name: linkedHost.vmName,
                    resourceGroup: linkedHost.vmResourceGroup,
                  });
                } else {
                  void checkAzureThen();
                }
              }}
              footer="Esc to cancel"
            />
          ) : (
            <Box marginTop={1}>
              <Text color={colors.muted}>
                Enter to continue • Esc to cancel
              </Text>
            </Box>
          )}
        </Box>
      </BorderBox>
    );
  }

  if (step === "preflight" || step === "resolving") {
    return (
      <BorderBox title="Link Deploy Host">
        <Box marginY={1}>
          <Spinner
            label={
              step === "preflight"
                ? "Checking Azure CLI access..."
                : "Resolving deployment resources..."
            }
          />
        </Box>
      </BorderBox>
    );
  }

  if (step === "select-resource-group" && config) {
    return (
      <BorderBox title="Select Deploy Host Resource Group">
        <DiscoveredSelect
          key="select-resource-group"
          label="Select the resource group containing the deploy host"
          hint="The deployment resource group is recommended."
          loadingLabel="Loading Azure resource groups..."
          emptyHint="No resource groups were discovered. Enter one manually."
          load={async () =>
            (await listAzureResourceGroups()).map((group) => ({
              label: `${group.name}  ·  ${group.location}`,
              value: group.name,
            }))
          }
          recommendIndex={(items) =>
            items.findIndex(
              (item) =>
                item.value.toLowerCase() ===
                config.infrastructure.azureResourceGroup!.toLowerCase(),
            )
          }
          initialValue={vmResourceGroup || undefined}
          onSelect={(value) => {
            setVmResourceGroup(value);
            setStep("select-vm");
          }}
          onManual={() => setStep("manual-resource-group")}
        />
      </BorderBox>
    );
  }

  if (step === "manual-resource-group") {
    return (
      <BorderBox title="Enter Deploy Host Resource Group">
        <TextField
          label="Azure resource group"
          hint="Only VMs in this resource group will be listed."
          value={vmResourceGroup}
          onChange={setVmResourceGroup}
          placeholder="resource-group"
          onSubmit={() => {
            if (vmResourceGroup.trim()) {
              setVmResourceGroup(vmResourceGroup.trim());
              setStep("select-vm");
            }
          }}
        />
        <Text color={colors.muted}>Enter to continue • Esc to go back</Text>
      </BorderBox>
    );
  }

  if (step === "select-vm" && vmResourceGroup) {
    return (
      <BorderBox title="Select Deploy Host">
        <DiscoveredSelect
          key={`select-vm:${vmResourceGroup}`}
          label="Select the Azure VM that will run Rulebricks commands"
          hint={`Showing only VMs in ${vmResourceGroup}.`}
          loadingLabel="Loading Azure VMs..."
          emptyHint={`No VMs were found in ${vmResourceGroup}. Enter a VM name manually or go back to choose another group.`}
          load={async () =>
            (await listAzureVms(vmResourceGroup)).map((vm) => ({
              label: `${vm.name}  ·  ${vm.resourceGroup}${
                vm.powerState ? `  ·  ${vm.powerState}` : ""
              }`,
              value: encodeVm({
                name: vm.name,
                resourceGroup: vm.resourceGroup,
              }),
            }))
          }
          initialValue={
            deploymentState?.linkedHost &&
            deploymentState.linkedHost.vmResourceGroup.toLowerCase() ===
              vmResourceGroup.toLowerCase()
              ? encodeVm({
                  name: deploymentState.linkedHost.vmName,
                  resourceGroup:
                    deploymentState.linkedHost.vmResourceGroup,
                })
              : undefined
          }
          onSelect={(value) => {
            try {
              void resolvePlan(decodeVm(value));
            } catch (selectionError) {
              setError(
                selectionError instanceof Error
                  ? selectionError.message
                  : "Invalid VM selection.",
              );
              setStep("error");
            }
          }}
          onManual={() => setStep("manual-vm-name")}
        />
      </BorderBox>
    );
  }

  if (step === "manual-vm-name") {
    return (
      <BorderBox title="Enter Deploy Host">
        <TextField
          label="Azure VM name"
          value={manualVmName}
          onChange={setManualVmName}
          placeholder="jumpbox-vm"
          onSubmit={() => {
            if (manualVmName.trim()) {
              void resolvePlan({
                name: manualVmName.trim(),
                resourceGroup: vmResourceGroup,
              });
            }
          }}
        />
        <Text color={colors.muted}>Enter to continue • Esc to go back</Text>
      </BorderBox>
    );
  }

  if (step === "review" && selectedVm) {
    return (
      <BorderBox title="Review Deploy Host Access">
        <Box flexDirection="column" marginY={1}>
          <Text bold>
            {selectedVm.name}{" "}
            <Text color={colors.muted}>
              · {selectedVm.resourceGroup}
            </Text>
          </Text>
          <Text color={colors.muted}>
            A system-assigned identity is attached to the VM; it does not create
            a standalone Azure resource.
          </Text>
          {deploymentState?.linkedHost &&
            !sameHost(deploymentState.linkedHost, selectedVm) && (
              <Text color={colors.warning}>
                CLI-created assignments on the previously linked host will be
                removed after this host is linked.
              </Text>
            )}
          <Box flexDirection="column" marginTop={1}>
            {plan.map((grant) => (
              <Box key={roleKey(grant)} flexDirection="column" marginBottom={1}>
                <Text>
                  {grant.role}{" "}
                  <Text color={colors.muted}>· {grant.scopeLabel}</Text>
                </Text>
                <Text color={colors.muted}>  {grant.reason}</Text>
              </Box>
            ))}
          </Box>
          {grantsToApply.length === 0 && (
            <Text color={colors.success}>
              All planned grants are already linked. The VM identity will still
              be verified.
            </Text>
          )}
          <Box marginTop={1}>
            <Text color={colors.muted}>
              Enter to approve commands as they run • Esc to cancel
            </Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  if (step === "executing" && selectedVm) {
    return (
      <BorderBox title={`Linking ${selectedVm.name}`}>
        <Box flexDirection="column" marginY={1}>
          <StatusLine
            status={identityStatus.status}
            label="System-assigned managed identity"
            detail={identityStatus.detail}
          />
          {plan.map((grant) => {
            const row = grantStatuses[roleKey(grant)] ?? {
              status: "pending" as const,
            };
            return (
              <StatusLine
                key={roleKey(grant)}
                status={row.status}
                label={grant.role}
                detail={
                  row.detail
                    ? `${grant.scopeLabel}; ${row.detail}`
                    : grant.scopeLabel
                }
              />
            );
          })}
          <Box marginTop={1}>
            <Spinner label="Applying deploy host access..." />
          </Box>
        </Box>
      </BorderBox>
    );
  }

  if (step === "complete" && selectedVm && config) {
    return (
      <BorderBox title="Deploy Host Linked">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.success} bold>
            {selectedVm.name} is linked to {name}
          </Text>
          {principalId && (
            <Text color={colors.muted}>Principal: {principalId}</Text>
          )}
          {denied.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color={colors.warning}>
                {formatGrantDeniedWarning(denied)}
              </Text>
            </Box>
          )}
          <Box flexDirection="column" marginTop={1}>
            <Text bold>On the linked VM:</Text>
            <Text color={colors.accentBright}>az login --identity</Text>
            <Text color={colors.accentBright}>
              az aks get-credentials --resource-group{" "}
              {config.infrastructure.azureResourceGroup} --name{" "}
              {config.infrastructure.clusterName} --overwrite-existing
            </Text>
            <Text color={colors.accentBright}>kubectl get nodes</Text>
            <Text color={colors.accentBright}>rulebricks deploy {name}</Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text color={colors.muted}>
              Future configure, deploy, upgrade, status, and logs commands can
              run from this VM without an interactive Azure login.
            </Text>
            <Text color={colors.muted}>
              Run rulebricks host unlink {name} to remove CLI-created grants.
            </Text>
            <Text color={colors.muted}>Enter or Esc to close</Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  return (
    <BorderBox title="Deploy Host Link Failed">
      <Box flexDirection="column" marginY={1}>
        <Text color={colors.error} bold>
          Could not link the deploy host
        </Text>
        <Text color={colors.error}>{error}</Text>
        <Box marginTop={1}>
          <Text color={colors.muted}>Enter or Esc to close</Text>
        </Box>
      </Box>
    </BorderBox>
  );
}

type UnlinkStep = "loading" | "confirm" | "running" | "complete" | "error";

function HostUnlinkCommandInner({ name }: HostCommandProps) {
  const { exit } = useApp();
  const { colors } = useTheme();
  const [step, setStep] = useState<UnlinkStep>("loading");
  const [state, setState] = useState<DeploymentState | null>(null);
  const [host, setHost] = useState<LinkedDeploymentHost | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ProgressRow>>({});
  const [manualCleanup, setManualCleanup] = useState<string[]>([]);
  const [preserved, setPreserved] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const loaded = await loadDeploymentState(name);
      if (!active) return;
      setState(loaded);
      if (!loaded?.linkedHost) {
        setMessage(`Deployment "${name}" has no linked deploy host.`);
        setStep("complete");
        return;
      }
      setHost(loaded.linkedHost);
      setStep("confirm");
    })();
    return () => {
      active = false;
    };
  }, [name]);

  async function unlink() {
    if (!state || !host) return;
    setStep("running");
    const managed = host.grants.filter(
      (grant) =>
        grant.createdByRulebricks && grant.status === "granted",
    );
    setPreserved(host.grants.length - managed.length);
    setStatuses(
      Object.fromEntries(
        managed.map((grant) => [
          linkedGrantKey(grant, host.principalId),
          { status: "pending" },
        ]),
      ),
    );
    const cleanup: string[] = [];

    for (const grant of managed) {
      const key = linkedGrantKey(grant, host.principalId);
      const request = {
        principalId: linkedGrantPrincipal(grant, host.principalId),
        role: grant.role,
        scope: grant.scope,
      };
      setStatuses((current) => ({
        ...current,
        [key]: { status: "running" },
      }));
      try {
        const result = await deleteAzureRoleAssignment(request);
        if (result.status === "denied") {
          cleanup.push(result.command);
          setStatuses((current) => ({
            ...current,
            [key]: {
              status: "skipped",
              detail: "administrator action required",
            },
          }));
        } else {
          setStatuses((current) => ({
            ...current,
            [key]: {
              status: "success",
              detail:
                result.status === "deleted"
                  ? "removed"
                  : "already absent",
            },
          }));
        }
      } catch (unlinkError) {
        cleanup.push(formatAzureRoleAssignmentDeleteCommand(request));
        setStatuses((current) => ({
          ...current,
          [key]: {
            status:
              unlinkError instanceof CommandDeniedError ? "skipped" : "error",
            detail:
              unlinkError instanceof CommandDeniedError
                ? "approval denied"
                : "remove manually",
          },
        }));
      }
    }

    try {
      const cleared: DeploymentState = {
        ...state,
        updatedAt: new Date().toISOString(),
      };
      delete cleared.linkedHost;
      await saveDeploymentState(name, cleared);
      setManualCleanup(cleanup);
      setMessage(`${host.vmName} is no longer linked to ${name}.`);
      setStep("complete");
    } catch (saveError) {
      setMessage(
        saveError instanceof Error
          ? saveError.message
          : "Could not update deployment state.",
      );
      setStep("error");
    }
  }

  useGatedInput((_input, key) => {
    if (step === "confirm" && key.return) {
      void unlink();
    } else if (
      key.escape ||
      (key.return && (step === "complete" || step === "error"))
    ) {
      exit();
    }
  });

  if (step === "loading") {
    return (
      <BorderBox title="Unlink Deploy Host">
        <Box marginY={1}>
          <Spinner label="Loading linked host..." />
        </Box>
      </BorderBox>
    );
  }

  if (step === "confirm" && host) {
    const managedCount = host.grants.filter(
      (grant) =>
        grant.createdByRulebricks && grant.status === "granted",
    ).length;
    return (
      <BorderBox title={`Unlink Deploy Host · ${name}`}>
        <Box flexDirection="column" marginY={1}>
          <Text>
            Unlink {host.vmName}{" "}
            <Text color={colors.muted}>· {host.vmResourceGroup}</Text>
          </Text>
          <Text color={colors.muted}>
            {managedCount} CLI-created role assignment
            {managedCount === 1 ? "" : "s"} will be removed. The VM identity and
            any pre-existing assignments will be left in place.
          </Text>
          <Box marginTop={1}>
            <Text color={colors.muted}>
              Enter to continue • Esc to cancel
            </Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  if (step === "running" && host) {
    const managed = host.grants.filter(
      (grant) =>
        grant.createdByRulebricks && grant.status === "granted",
    );
    return (
      <BorderBox title={`Unlinking ${host.vmName}`}>
        <Box flexDirection="column" marginY={1}>
          {managed.map((grant) => {
            const key = linkedGrantKey(grant, host.principalId);
            const row = statuses[key] ?? { status: "pending" as const };
            return (
              <StatusLine
                key={key}
                status={row.status}
                label={grant.role}
                detail={
                  row.detail
                    ? `${linkedGrantPrincipal(grant, host.principalId)}; ${row.detail}`
                    : linkedGrantPrincipal(grant, host.principalId)
                }
              />
            );
          })}
          <Box marginTop={1}>
            <Spinner label="Removing deploy host access..." />
          </Box>
        </Box>
      </BorderBox>
    );
  }

  if (step === "error") {
    return (
      <BorderBox title="Unlink Failed">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.error}>{message}</Text>
          <Text color={colors.muted}>Enter or Esc to close</Text>
        </Box>
      </BorderBox>
    );
  }

  return (
    <BorderBox title="Deploy Host Unlinked">
      <Box flexDirection="column" marginY={1}>
        <Text color={colors.success}>{message}</Text>
        {preserved > 0 && host && (
          <Text color={colors.muted}>
            {preserved} pre-existing or pending assignment
            {preserved === 1 ? " was" : "s were"} left untouched.
          </Text>
        )}
        {manualCleanup.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={colors.warning}>
              Ask an Azure administrator to remove the remaining assignments:
            </Text>
            {manualCleanup.map((command) => (
              <Text key={command} color={colors.accentBright}>
                {command}
              </Text>
            ))}
          </Box>
        )}
        <Box marginTop={1}>
          <Text color={colors.muted}>Enter or Esc to close</Text>
        </Box>
      </Box>
    </BorderBox>
  );
}

export function HostLinkCommand(props: HostCommandProps) {
  return (
    <ThemeProvider theme="status">
      <Logo />
      <CommandApprovalProvider>
        <HostLinkCommandInner {...props} />
      </CommandApprovalProvider>
    </ThemeProvider>
  );
}

export function HostUnlinkCommand(props: HostCommandProps) {
  return (
    <ThemeProvider theme="destroy">
      <Logo />
      <CommandApprovalProvider>
        <HostUnlinkCommandInner {...props} />
      </CommandApprovalProvider>
    </ThemeProvider>
  );
}
