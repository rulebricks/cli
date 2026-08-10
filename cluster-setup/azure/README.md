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

## Prepare a linked deploy host

Use a deploy host when the AKS API or Azure data-plane resources are reachable
only from a VM in the Azure network. The setup flow uses Azure Run Command, not
SSH, so the VM does not need a public IP or an inbound management port.

First, link the VM's system-assigned managed identity to an existing
deployment:

```bash
rulebricks host link <deployment-name>
```

Then run the setup utility from the same local machine:

```bash
rulebricks-host-setup <deployment-name>
```

From a source checkout, the equivalent command is:

```bash
cluster-setup/azure/scripts/setup-deploy-host.sh <deployment-name>
```

The utility:

1. Reads the VM name and resource group saved by `host link`.
2. Keeps compatible existing tools in place and installs only missing tools.
   It supports apt-based systems, RHEL-family dnf/yum systems, Azure Linux, and
   SLES/openSUSE. Existing Node.js 20+ installations are retained; otherwise
   Node.js 24 is installed.
3. Installs or upgrades `@rulebricks/cli` to the latest published version.
4. Copies `~/.rulebricks/deployments/<deployment-name>` over the authenticated
   Azure control plane. The remote files are owned by the VM administrator and
   restricted to that user. An existing remote configuration is moved to a
   timestamped backup rather than merged.
5. Signs in with the VM's managed identity, refreshes AKS credentials, and
   verifies `kubectl get nodes` and the Rulebricks CLI.

Run it again before a deploy to send the latest local configuration and check
for a CLI update. It is safe to rerun: Azure CLI, kubectl, kubelogin, Helm, and
compatible Node.js installations are not replaced.

Common options:

```bash
# Sync and verify without installing/updating tools
rulebricks-host-setup <deployment-name> --skip-tools

# Install/update tools and verify without copying config
rulebricks-host-setup <deployment-name> --skip-config

# Explicitly target a VM if local linked-host state is unavailable
rulebricks-host-setup <deployment-name> \
  --vm <vm-name> --resource-group <vm-resource-group>

# Remove copied deployment configuration and its backups; installed tools remain
rulebricks-host-setup <deployment-name> --remove
```

Run `rulebricks-host-setup --help` for all options. `--remove` may need explicit
`--vm` and `--resource-group` arguments after `rulebricks host unlink` because
unlinking intentionally clears the saved host association.

The setup utility copies files inside the deployment directory. If
`config.yaml` refers to a file elsewhere on the local filesystem, such as a
provided TLS certificate or private key, that external file must also be made
available at the configured path on the VM before deploying.

## Deployment Workflow

<details>
<summary><strong>Self-service / Pre-production</strong></summary>

If the deployer already has `Owner`, or `Contributor` plus
`User Access Administrator` / `Role Based Access Control Administrator`, on
the workload resource group, there are no Azure RBAC tickets for resources 
needed within that group.

Enable the applicable `assign*Role` toggles and run prerequisites & main bicep, then
the CLI.

1. **Before deploying prerequisites: external resource access (only if applicable).**
   - Deployer: role-assignment capability plus `Reader` on platform-owned VNet,
     subnet, DNS, or ACS scopes.
   - Deployer: `Network Contributor` only where prerequisites must create
     subnets or VNet links.
2. **Before deploying prerequisites: ACS SMTP identity (only if email is enabled and the
   deployer cannot manage Entra apps).**
   - Identity team: create the Entra application, service principal, and client
     secret.
   - Return to deployer: application client ID and client secret.
3. **After deploying prerequisites: DNS delegation (only if the parent domain is owned
   elsewhere).**
   - Deployer: send the `dnsZoneNameServers` output.
   - DNS owner: delegate the Rulebricks subdomain to those name servers.

No ticket is required after main when all selected role toggles succeed.

</details>

<details>
<summary><strong>Enterprise / Production</strong></summary>

Keep all `assign*Role` toggles off. The deployer runs Bicep and the CLI; the
platform team completes these tickets:

1. **Before prerequisites bicep: deployment access and inputs.**
   - Workload resource group: create it and grant the deployer `Contributor`.
   - Existing VNet/DNS/ACS: provide resource IDs and grant the deployer
     `Reader`.
   - Existing VNet: grant the deployer `Network Contributor` only when
     prerequisites must create subnets or VNet links.
   - ACS email: provide the Entra application client ID and client secret; for
     platform-owned ACS, also provide its resource ID.
2. **After prerequisites, before main bicep: network, DNS, identity, and ACS.**
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
3. **After main bicep, before the CLI: workload access.**
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