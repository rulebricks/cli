# Pre-deployment checklist

What to confirm and have on hand before deploying parameters.bicepparam.

## 1. Region and capacity

- [ ] Pick a region.
- [ ] vCPU quota for the node SKUs there: the defaults (Dasv6 family) need
      16-34 vCPUs at launch, 94 at full autoscale.
      Check: `az vm list-usage --location <region> -o table`
- [ ] PostgreSQL Flexible Server is available to your subscription there.
      Check: `az postgres flexible-server list-skus --location <region>`

## 2. DNS and access

- [ ] Choose the deployment's subdomain, e.g. rb.corp.com. This becomes
      dnsZoneName.
- [ ] Know who controls the parent domain: they add one NS record set after
      the deployment. That is the only DNS task, records and TLS
      certificates are automatic afterward.
- [ ] The machine that runs the Rulebricks install needs a network path to
      the VNet (VPN, peering, or a jump host), the Kubernetes control plane
      and Key Vault are private.

## 3. Component decisions

Confirm the defaults are what you want; each flips with one parameter:

- [ ] Managed PostgreSQL: on (off = in-cluster database)
- [ ] Key Vault as the secrets source of truth: on
- [ ] Kafka and Redis: in-cluster (managed Event Hubs and Azure Managed
      Redis available)
- [ ] Managed Prometheus + Grafana monitoring: on
- [ ] ACS email: on. Decide whether to also use a branded sender address:
      pick a name under the subdomain from step 2 (nothing else is needed),
      or keep the default azurecomm.net sender.

## 4. Images

- [ ] Decide whether cluster nodes pull from Rulebricks' registry directly
      (needs egress from the nodes) or through your own ACR, which caches all
      images automatically (on by default; only the registry needs egress).

## 5. Values to have on hand

For the parameter file:

- [ ] aksAdminPrincipalIds - Entra object IDs of the cluster admins
- [ ] keyVaultWriterPrincipalIds - object IDs allowed to seed secrets
      (include whoever runs the Rulebricks deploy)
- [ ] dnsZoneName - the subdomain from step 2

For the Rulebricks CLI (not the parameter file - the CLI wires these up at
deploy time, like SSO):

- [ ] An Entra app for email: `az ad app create --display-name "Rulebricks SMTP"`
      then `az ad sp create --id <appId>` and `az ad app credential reset`.
      The CLI takes the app's client ID (into the SMTP username) and its
      client secret (the SMTP password), and grants the app access to the
      email service during deploy.

## 6. Exports

Secrets never go in the parameter file; run these in the shell that will
deploy:

    export RB_POSTGRES_ADMIN_PASSWORD='<choose-a-strong-password>'
    export RB_LICENSE_KEY='<your-license-key>'

---

<sub>This covers the infrastructure only. Installing Rulebricks itself also
needs the same license key plus application settings (admin email, SSO client
credentials if used). Some come from this deployment's outputs, others from
your organization.</sub>
