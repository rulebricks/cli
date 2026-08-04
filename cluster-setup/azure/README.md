# Rulebricks on Azure

The Azure setup has two resource-group-scoped deployments with a deliberate
approval point between them:

1. `prerequisites.bicep` stages organization-owned resources such as network,
   DNS, the AKS control-plane identity, private DNS, and ACS email.
2. A platform team applies any required access from the prerequisite
   `roleRequirements` output.
3. `main.bicep` creates AKS and workload resources while referencing the
   prerequisite bicep outputs.
4. A platform team applies any deferred workload access from main's
   `roleRequirements` output before `rulebricks deploy`.
5. The Rulebricks CLI completes the deployment and installs the helm chart

## Expectations

Everything gets created in one resource group, but first figure out what your
platform team owns vs. what you provision yourself... VNets, subnets, and ACS
are commonly platform-controlled, and you should expect to adjust the
prerequisites parameters file accordingly.

- AKS brings a lot of services, and some of them need roles that plain
  Contributor can't create (external-dns write access being the main one).
  For non-prod, getting temporary Owner or User Access Administrator so you
  can self-grant these is much faster than filing a ticket per role.
- Deploying into an existing VNet/subnet needs Network Contributor (or
  equivalent) for the AKS managed identity. The flow is: deploy prerequisites,
  hand the resource group ID and AKS identity info to the platform team, get
  the VNet/subnet role granted.
- Reader and writer requirements are consolidated in the Roles section below;
  request only the rows used by your selected features.

## Commands

```bash
# Create resource group
az group create --name <rulebricks-rg> --location <location>

# Assess impact of prerequisites bicep
az deployment group what-if --resource-group <rulebricks-rg> --parameters cluster-setup/azure/parameters.prerequisites.bicepparam

# Deploy prerequisites bicep
az deployment group create \
  --name rulebricks-prerequisites \
  --resource-group <rulebricks-rg> \
  --parameters cluster-setup/azure/parameters.prerequisites.bicepparam \
  | tee rulebricks-prerequisites-outputs.json

# Assess impact of main bicep
az deployment group what-if --resource-group <rulebricks-rg> --parameters cluster-setup/azure/parameters.bicepparam

# Deploy main bicep
az deployment group create \
  --name rulebricks \
  --resource-group <rulebricks-rg> \
  --parameters cluster-setup/azure/parameters.bicepparam \
  | tee rulebricks-outputs.json
```

## Platform team tickets

Each numbered item below is a ticket and when to submit it.

<details>
<summary><strong>Self-service / non-production</strong></summary>

If the deployer already has `Owner`, or `Contributor` plus
`User Access Administrator` / `Role Based Access Control Administrator`, on
the workload resource group, there are no Azure RBAC tickets for resources in that group.
Enable the applicable `assign*Role` toggles and run prerequisites, main, then
the CLI.

1. **Before prerequisites — external resource access (only if applicable).**
   - Deployer: role-assignment capability plus `Reader` on platform-owned VNet,
     subnet, DNS, or ACS scopes.
   - Deployer: `Network Contributor` only where prerequisites must create
     subnets or VNet links.
2. **Before prerequisites — ACS SMTP identity (only if email is enabled and the
   deployer cannot manage Entra apps).**
   - Identity team: create the Entra application, service principal, and client
     secret.
   - Return to deployer: application client ID and client secret.
3. **After prerequisites — DNS delegation (only if the parent domain is owned
   elsewhere).**
   - Deployer: send the `dnsZoneNameServers` output.
   - DNS owner: delegate the Rulebricks subdomain to those name servers.

No ticket is required after main when all selected role toggles succeed.

</details>

<details>
<summary><strong>Enterprise / Contributor</strong></summary>

Keep all `assign*Role` toggles off. The deployer runs Bicep and the CLI; the
platform team completes these tickets:

1. **Before prerequisites — deployment access and inputs.**
   - Workload resource group: create it and grant the deployer `Contributor`.
   - Existing VNet/DNS/ACS: provide resource IDs and grant the deployer
     `Reader`.
   - Existing VNet: grant the deployer `Network Contributor` only when
     prerequisites must create subnets or VNet links.
   - ACS email: provide the Entra application client ID and client secret; for
     platform-owned ACS, also provide its resource ID.
2. **After prerequisites, before main — network, DNS, identity, and ACS.**
   - Attach: prerequisite `roleRequirements` output.
   - AKS identity: `Network Contributor` on the AKS subnet.
   - External-dns identity: `DNS Zone Contributor`.
   - Main deployer: `Managed Identity Operator` and required `Reader` access.
   - CLI operator: `Managed Identity Federated Identity Credential Contributor`
     on external-dns and ACS `Reader`.
   - SMTP service principal: `Communication and Email Service Owner`.
   - Optional private networking: `Network Contributor` on selected subnets and
     `Private DNS Zone Contributor` on selected zones.
   - DNS delegation: include `dnsZoneNameServers` when another team owns the
     parent domain.
3. **After main, before the CLI — workload access.**
   - Attach: main `roleRequirements` output.
   - Data-access identity: `Storage Blob Data Contributor` and
     `Monitoring Metrics Publisher`.
   - External-secrets identity: `Key Vault Secrets User`.
   - Grafana identity: `Monitoring Data Reader`.
   - Kubelet identity: `AcrPull` or
     `Container Registry Repository Reader`.
   - CLI operator: `Key Vault Secrets Officer`,
     `Container Registry Data Importer and Data Reader`, and
     `Managed Identity Federated Identity Credential Contributor` on workload
     identities.
   - Optional Entra administrators:
     `Azure Kubernetes Service RBAC Cluster Admin` when Entra RBAC is enabled.

</details>