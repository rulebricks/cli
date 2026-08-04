# Azure enterprise deployment checklist

Use prereq/main `roleRequirements` outputs for exact principal IDs and scopes.

## Before prerequisites
- [ ] Target RG(s) exist (or you can create them)
- [ ] Deployer can create the selected resources in those RGs
- [ ] Role toggles `true` only where you can write RBAC on that scope; else `false`
- [ ] Params filled: subnet/DNS/ACS mode + required IDs; what-if looks right

## After prerequisites → before main
- [ ] Saved `mainDeploymentParameters` and `roleRequirements`
- [ ] AKS identity can join the AKS subnet (usually the one platform ask)
- [ ] In-RG DNS/identity grants done (or toggles wrote them)
- [ ] Parent DNS NS delegation for the child zone (if applicable)
- [ ] Deployer can read any cross-RG refs (VNet, ACS, …)

## Main
- [ ] Prereq IDs pasted; API CIDRs set; features match what you own
- [ ] Role toggles `true` only with RBAC write on those scopes
- [ ] What-if OK → deploy → save `roleRequirements` / `principalIds`

## Before `rulebricks deploy`
- [ ] Main `roleRequirements` granted (storage, KV, ACR, monitoring, FIC) (or bicepparam toggles wrote them)
- [ ] `az aks get-credentials` + Helm work from this machine
- [ ] ACS SMTP Username ready + app can send (if using ACS email)