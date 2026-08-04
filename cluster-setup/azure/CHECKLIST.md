# Azure enterprise deployment checklist

Use each deployment's `roleRequirements` output for exact principal IDs and scopes.

## Before `prerequisites.bicep`
- [ ] Target RG exists (or you can create it)
- [ ] DNS zone name chosen (e.g. `rb.mycorp.com`) and AKS subnet picked (enough IPs)
- [ ] Deployer can create selected resources in that RG
- [ ] Prefer temporary Owner or Contributor+UAA/RBAC Admin on that RG (avoids many per-role tickets)
- [ ] `parameters.prerequisites.bicepparam` filled per your ownership model

## **Deploy** `prerequisites.bicep` (what-if, then create; tee/save outputs).

## After `prerequisites.bicep`
- [ ] Review outputs: `mainDeploymentParameters` + `roleRequirements`
- [ ] Ticket anything still needed outside your RG (usually AKS identity → Network Contributor on the subnet)
- [ ] Confirm in-RG DNS/identity grants succeeded (or ticket those rows)
- [ ] Request parent DNS NS delegation using `dnsZoneNameServers` (if zone is a child of corp DNS)
- [ ] Confirm you can read any cross-RG refs you rely on (VNet, ACS, …)

## `main.bicep`
- [ ] Paste prereq IDs; set API CIDRs; enable only features you own
- [ ] Set role toggles `true` only where you can write RBAC; else leave `false` and ticket after deploy

## **Deploy** `main.bicep` (what-if, then create; tee/save outputs)

## Before `rulebricks deploy`
- [ ] Main `roleRequirements` granted (or toggles already wrote them)
- [ ] `az aks get-credentials` works from this machine
- [ ] ACS SMTP Username ready + app can send (if using ACS email)

## **Run** `rulebricks deploy`