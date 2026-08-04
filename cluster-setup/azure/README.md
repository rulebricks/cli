# Rulebricks on Azure

The Azure setup has two resource-group-scoped deployments with a deliberate
approval point between them:

1. `prerequisites.bicep` stages organization-owned resources such as network,
   DNS, the AKS control-plane identity, private DNS, and ACS email.
2. A platform team applies any required access from the prerequisite
   `roleRequirements` output.
3. `main.bicep` creates AKS and workload resources while only referencing the
   prerequisite resources.
4. A platform team applies any deferred workload access from main's
   `roleRequirements` output before `rulebricks deploy`.

No generated role-assignment commands or extra access templates are required.
Every role write is independently selectable and disabled by default.

## Resource group first

Both entry points use `targetScope = 'resourceGroup'`, so the target resource
group must exist before either deployment starts.

- An operator with subscription-level `Microsoft.Resources/subscriptions/resourceGroups/write`
  can create it with the normal `az group create` workflow.
- A resource-group-only Contributor cannot create its parent resource group;
  the platform team must provide one.
- Contributor on the supplied resource group can deploy ordinary resources but
  cannot create role assignments.
- If `workloadResourceGroupId` points to a different group and prerequisites
  creates the AKS identity there, the prerequisites deployer also needs
  deployment and managed-identity write access in that workload group.
- Self-service role assignment requires Owner or Contributor plus User Access
  Administrator at each target scope. User Access Administrator alone cannot
  create the resources.

## 1. Configure prerequisites

Start with `parameters.prerequisites.bicepparam`. Its role toggles are all
`false`, which is the Contributor-safe path.

`operatorPrincipalIds = []` deliberately auto-detects the principal executing
the ARM deployment. That same principal is used for prerequisite, main, and
CLI handoffs. The Rulebricks CLI does not modify Bicep parameters. Enterprises
with separate actors can set `prerequisiteDeployerPrincipalIds`,
`mainDeployerPrincipalIds`, or `cliPrincipalIds` as explicit overrides.

### AKS network modes

`networkProvisioningMode` supports four explicit ownership models:

- `none`: no AKS network writes or references. Use for ACS-only, DNS-only, or
  other partial prerequisite runs.
- `existingSubnets`: reference `existingAksSubnetId` and optional existing
  private-endpoint/PostgreSQL subnet IDs. This performs zero network writes.
- `createSubnetsInExistingVnet`: create the named AKS subnet and selected
  supporting subnets inside `existingVnetId`. The module does not change the
  VNet address space or sibling subnets. The deployer needs deployment access
  on the VNet resource group and subnet read/write permission.
- `createVnetAndSubnets`: create an isolated VNet and selected subnets in the
  prerequisites resource group for self-managed environments.

An AKS subnet created inside an existing VNet can reference an approved NSG
through `existingAksSubnetNetworkSecurityGroupId`. If it is empty, no NSG is
attached by this template; organization policy may attach one.

`configureAksControlPlaneIdentity = false` skips AKS identity staging. Otherwise
choose between creating it and supplying
`existingAksControlPlaneIdentityId`.

### Independent prerequisite components

The remaining components can be selected separately:

- Public DNS: set `createExternalDnsResources = true`, reference both
  `existingDnsZoneId` and `existingExternalDnsIdentityId`, or leave all three
  disabled.
- Private DNS: select only zones to create with
  `createPrivateDnsZonesFor`, pass organization-owned IDs through
  `existingPrivateDnsZoneIds`, or leave both empty for Azure Policy/central
  DNS. `privateDnsVnetId` allows private-DNS-only runs without AKS networking.
  Creating VNet links requires `virtualNetworks/join/action` on that VNet
  before prerequisites runs.
- AKS private API DNS: pass `existingAksPrivateDnsZoneId` when main will use
  `privateWithExistingDns`.
- ACS email: set `createAcsEmail = true`, pass
  `existingCommunicationServiceId`, or leave both empty.

Valid partial examples include:

```bicep
// ACS-only
param networkProvisioningMode = 'none'
param configureAksControlPlaneIdentity = false
param createAcsEmail = true
```

```bicep
// Existing AKS subnet: no network writes
param networkProvisioningMode = 'existingSubnets'
param existingAksSubnetId = '/subscriptions/.../virtualNetworks/.../subnets/...'
```

```bicep
// Platform-approved subnet creation in an existing VNet
param networkProvisioningMode = 'createSubnetsInExistingVnet'
param existingVnetId = '/subscriptions/.../virtualNetworks/...'
param aksSubnetPrefix = '10.50.0.0/23'
```

Run a what-if and deploy the parameter file:

```bash
az deployment group what-if \
  --resource-group <prerequisites-rg> \
  --parameters cluster-setup/azure/parameters.prerequisites.bicepparam

az deployment group create \
  --name rulebricks-prerequisites \
  --resource-group <prerequisites-rg> \
  --parameters cluster-setup/azure/parameters.prerequisites.bicepparam
```

Save `mainDeploymentParameters`, `roleRequirements`, and the relevant principal
IDs from the deployment outputs.

A partial prerequisite run intentionally leaves unrelated handoff fields empty.
Merge the fields for the components you staged; do not run a full main
deployment until its required AKS identity and subnet values are populated.

## 2. Complete the pre-main handoff

Each item in `roleRequirements` contains the role name, role definition ID,
principal ID, exact scope, phase, reason, and whether this deployment was
configured to write it.

Typical requirements are:

- Prerequisites deployer: Contributor on a separate workload resource group
  when it creates the AKS identity there (or a custom role with deployment and
  managed-identity write permissions).
- Prerequisites deployer: `Network Contributor` on the approved VNet when
  `createSubnetsInExistingVnet` is selected (or a custom subnet read/write
  role). Existing-subnet reference mode needs only Reader for validation.
- AKS control-plane identity: `Network Contributor` on only the AKS subnet. An
  approved custom role with subnet read and join permissions can be used
  instead.
- External-dns identity: `DNS Zone Contributor` on only its public DNS zone.
- CLI operator: `Managed Identity Federated Identity Credential Contributor`
  on the external-dns identity.
- Main deployer: `Managed Identity Operator` on the staged AKS identity when
  that capability is not inherited through Contributor.
- AKS control-plane identity: `Private DNS Zone Contributor` on an
  organization-owned AKS private DNS zone when applicable.
- Main/CLI deployers: Reader on prerequisite resources they must resolve.
- Main deployer: subnet join access on staged private-endpoint/PostgreSQL
  subnets and Private DNS Zone Contributor on staged private zones. These exact
  scopes now appear in the prerequisite handoff before main runs.

The corresponding prerequisite role toggles are independent. An Owner or
Contributor+UAA can enable only the grants they are authorized to create. If a
role write fails, disable that role's toggle and rerun: resource deployment can
complete, and already-created role assignments are not deleted merely because
their toggle is now off.

## 3. Configure main

Copy the values from `mainDeploymentParameters` into
`parameters.bicepparam`, then choose workload features.

`main.bicep` never creates or modifies:

- VNet or subnets
- AKS control-plane identity
- public or private DNS zones
- ACS resources
- an organization-owned ACR

For an existing ACR, set `existingContainerRegistryId` and choose:

- `legacyRbac` for `AcrPull`
- `rbacAbac` for `Container Registry Repository Reader`

Main does not create a private endpoint on an existing ACR.

The single shipped main profile matches the standard Rulebricks topology:
storage, Key Vault, ACR, Azure Monitor managed Prometheus, Managed Grafana,
public DNS, and ACS are enabled; external PostgreSQL, Redis, and Kafka remain
off so those services run in-cluster. Private endpoints and every role write
remain off. Fill the prerequisite IDs and approved API CIDRs before deploying.

Key Vault names are globally unique and remain reserved while a deleted vault
is recoverable. If a previous environment with the generated name was
soft-deleted, set `keyVaultCreateMode = 'recover'`. If Azure reports that the
name is owned elsewhere or is no longer recoverable, set an explicit globally
unique `keyVaultName` and keep `keyVaultCreateMode = 'default'`.

Before running main, select the applicable `beforeMain` entries from the
prerequisite handoff based on the features enabled in main:

- The main deployer needs subnet read/join capability on the private-endpoint
  subnet when any private endpoint is selected.
- The main deployer needs Private DNS Zone Contributor (or an approved custom
  join role) on every organization-owned zone used by a private endpoint.
- Managed PostgreSQL requires delegated-subnet join access and Private DNS Zone
  Contributor before its server resource can be created.
- The deployer needs Reader on every cross-resource-group BYO resource. With
  all role toggles off, main reads those resources directly and does not create
  nested deployments in their resource groups.

These items are listed in `CHECKLIST.md`. Main repeats them with
`phase: beforeMain` in its `roleRequirements` output for audit and reruns.

```bash
az deployment group what-if \
  --resource-group <workload-rg> \
  --parameters cluster-setup/azure/parameters.bicepparam

az deployment group create \
  --name rulebricks \
  --resource-group <workload-rg> \
  --parameters cluster-setup/azure/parameters.bicepparam
```

## 4. Complete the pre-CLI handoff

Main's `roleRequirements` output covers the selected features, including:

- `Storage Blob Data Contributor` for the data-access identity.
- Key Vault Secrets User/Officer access.
- Monitoring Metrics Publisher and Managed Grafana reader access.
- `AcrPull` or `Container Registry Repository Reader` for the kubelet.
- `Container Registry Data Importer and Data Reader` for operators running the
  CLI mirror flow.
- AKS Entra RBAC admin access when selected.
- Federated-identity-credential write access for CLI operators.

The output reports requirements; it does not assume a broader role is absent.
For example, Contributor on the workload resource group may already satisfy a
resource-management capability.

ACS SMTP is a separate application-service-principal handoff and is not part of
main's `roleRequirements` output. The
documented built-in role is `Communication and Email Service Owner` on the ACS
resource. A platform team can instead use a custom role containing:

- `Microsoft.Communication/CommunicationServices/Read`
- `Microsoft.Communication/CommunicationServices/Write`
- `Microsoft.Communication/EmailServices/Write`

The Rulebricks CLI checks this access but never attempts to assign a broad
Contributor role. The platform team also creates the `SMTP Username` child
resource linked to that Entra application and waits for `Ready to use`; the
wizard can discover it by the exact ACS resource ID even when the service is in
another subscription.

## Private endpoints and DNS

`enableDataServicePrivateEndpoints = true` requires
`existingPrivateEndpointsSubnetId`.

- With `privateDnsIntegrationMode = 'policy'`, this deployment creates no
  private DNS zone groups; organization policy or central networking must
  provide name resolution.
- With `privateDnsIntegrationMode = 'existingZones'`, provide the zone ID for
  every enabled private endpoint. The main deployer needs permission to join
  each zone.
- Managed PostgreSQL uses its delegated subnet and private DNS zone directly;
  both IDs are required when it is enabled.

## Validation

Compile without writing generated ARM JSON into the repository:

```bash
az bicep build --file cluster-setup/azure/prerequisites.bicep --stdout >/dev/null
az bicep build --file cluster-setup/azure/main.bicep --stdout >/dev/null
az bicep build-params --file cluster-setup/azure/parameters.prerequisites.bicepparam --stdout >/dev/null
az bicep build-params --file cluster-setup/azure/parameters.bicepparam --stdout >/dev/null
```

Before deployment, verify Azure CLI login, provider registration, quota,
required CLIs, and API-server CIDR formatting for the target subscription.
