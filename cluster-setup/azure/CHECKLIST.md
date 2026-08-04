# Azure enterprise deployment checklist

Use this as the handoff between the Rulebricks operator and the platform team.
The Bicep `roleRequirements` outputs contain exact principal IDs and scopes;
this checklist intentionally contains no generated role-assignment commands.

## Resource group and deployer

- [ ] The prerequisites and workload resource groups already exist, or the
      operator has subscription-level permission to create them first.
- [ ] The prerequisites deployer can create the selected resources in the
      prerequisites resource group.
- [ ] If the AKS identity is created in a separate workload resource group, the
      prerequisites deployer can create deployments and managed identities
      there.
- [ ] The main deployer has Contributor or equivalent resource permissions in
      the workload resource group.
- [ ] Role writes remain off for Contributor-only deployers.
- [ ] Any self-service role writer has Owner or Contributor+User Access
      Administrator on every target scope. UAA alone is not resource creation
      permission.

## Prerequisites selection

- [ ] `networkProvisioningMode` matches the approved ownership model:
      `none`, `existingSubnets`, `createSubnetsInExistingVnet`, or
      `createVnetAndSubnets`.
- [ ] Existing subnet IDs are full resource IDs and belong to one intended
      VNet.
- [ ] Subnet prefixes have been allocated and do not overlap.
- [ ] Creating subnets in an existing VNet is approved; the deployer has
      deployment access on its resource group plus `Network Contributor` on
      the VNet (or an approved custom subnet read/write role).
- [ ] The approved AKS subnet NSG is supplied when the organization requires
      one.
- [ ] AKS identity creation/reference is enabled only when needed.
- [ ] Public DNS is either created, supplied as both zone+identity IDs, or
      disabled.
- [ ] Private DNS is either centrally managed, supplied as existing zone IDs,
      or selectively created and linked to the approved VNet.
- [ ] When prerequisites creates private DNS links, its deployer has
      `virtualNetworks/join/action` on the selected VNet before deployment.
- [ ] ACS is created, supplied by ID, or disabled independently of DNS/network.
- [ ] All prerequisite role toggles start `false` unless their exact scopes
      have explicit role-assignment approval.
- [ ] Prerequisites what-if contains only the intended components.
- [ ] Prerequisites deployment succeeded and its
      `mainDeploymentParameters`, `roleRequirements`, and principal IDs were
      saved.

## Required before main

Review each applicable prerequisite `roleRequirements` item:

- [ ] AKS control-plane identity can read/join only the AKS subnet
      (`Network Contributor` at subnet scope, or an approved custom read/join
      role).
- [ ] Main deployer can attach the AKS identity (`Managed Identity Operator`)
      when Contributor inheritance does not already provide that capability.
- [ ] External-dns identity has `DNS Zone Contributor` on only its public zone.
- [ ] CLI operator can create federated credentials on the external-dns
      identity.
- [ ] AKS identity can use the supplied private DNS zone for
      `privateWithExistingDns`, when selected.
- [ ] Main/CLI deployers can read every referenced prerequisite resource,
      including cross-resource-group DNS, identity, and ACS resources.
- [ ] Main deployer can join the staged private-endpoint and PostgreSQL
      subnets selected by main.
- [ ] Main deployer can join every staged private DNS zone selected by main;
      use the exact `beforeMain` scopes from the prerequisite handoff.

If a role toggle caused the deployment to fail:

- [ ] Disable only that failed role toggle.
- [ ] Rerun prerequisites so ordinary resources finish deploying.
- [ ] Give the matching `roleRequirements` entry to the owning platform team.
- [ ] Confirm previously successful grants remain present; a disabled
      conditional role resource is not automatically deleted.

## Main configuration

- [ ] Required AKS identity and subnet IDs were copied from the prerequisite
      handoff.
- [ ] API access mode and authorized CIDRs match enterprise policy.
- [ ] Existing AKS private DNS zone ID is set for
      `privateWithExistingDns`.
- [ ] Optional features are enabled only when their resource ownership and
      access are approved.
- [ ] Existing storage, Key Vault, DCR, and ACR IDs have the expected Azure
      resource type.
- [ ] Existing ACR permission mode is `legacyRbac` or `rbacAbac` as configured
      on that registry.
- [ ] Main does not create or modify any prerequisite-owned network, identity,
      DNS, ACS, or existing ACR resource.
- [ ] Every main role toggle starts `false` for a Contributor-only deployer.
- [ ] Main deployer can join every selected private endpoint to its subnet.
- [ ] Main deployer can join private endpoint zone groups to every supplied
      organization-owned private DNS zone.
- [ ] PostgreSQL deployment principal can join the delegated subnet and has
      Private DNS Zone Contributor (or approved equivalent) on its zone.
- [ ] Main deployer has Reader on every cross-resource-group BYO resource.
- [ ] Main what-if contains no role assignments when all role toggles are off.
- [ ] Main deployment succeeded and its `roleRequirements` and `principalIds`
      outputs were saved.

## Required before `rulebricks deploy`

Review each applicable main `roleRequirements` item:

- [ ] Data-access identity has `Storage Blob Data Contributor`.
- [ ] External-secrets identity has Key Vault Secrets User and selected
      operators have Key Vault Secrets Officer.
- [ ] Data-access identity has Monitoring Metrics Publisher; Managed Grafana
      has Monitoring Data Reader when used.
- [ ] AKS kubelet has `AcrPull` for legacy RBAC or
      `Container Registry Repository Reader` for RBAC+ABAC.
- [ ] CLI operators have `Container Registry Data Importer and Data Reader`
      for image/chart mirroring.
- [ ] Selected Entra administrators have AKS RBAC Cluster Admin.
- [ ] CLI operators can create federated credentials on the data-access,
      external-secrets, and external-dns identities they use.
- [ ] CLI operator can obtain AKS credentials and complete Kubernetes API
      operations required by Helm.
- [ ] Key Vault and AKS private endpoints are reachable from the machine that
      runs the CLI when public access is disabled.

ACS SMTP is a separate handoff and does not appear in main's
`roleRequirements` output:

- [ ] ACS SMTP application service principal has either
      `Communication and Email Service Owner` on the ACS resource or a custom
      role with CommunicationServices Read/Write and EmailServices Write.
- [ ] A platform-created SMTP Username links that Entra application to the
      exact ACS resource and reports `Ready to use`.

## Final verification

- [ ] Both Bicep entry points and all retained parameter files compile.
- [ ] TypeScript typecheck and Azure permission tests pass.
- [ ] Azure what-if was run for the real tenant/resource IDs when credentials
      are available.
- [ ] DNS delegation/verification is complete before branded email or
      external-dns is expected to work.
- [ ] No secret values were placed in Bicep outputs or committed parameter
      files.
