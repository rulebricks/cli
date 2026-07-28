# Pre-deployment checklist

To deploy Rulebricks, your workflow will be:

 - Go through this checklist, please ensure you have any required resources provisioned.
   - **Delegated DNS subdomain** (e.g. `rb.mycorp.com`)
   - **Approved IP ranges** (VNet address space and subnets)
   - **Entra app for email** (Client ID and client secret)
   - **Entra app for SSO** (Client ID and client secret)
   - **TLS certificates** (Only if your organization issues its own)
   - **Rulebricks license key** (Request from Rulebricks)
 - Prepare the machine that will deploy the infrastructure and Rulebricks application.
   - Have the Azure CLI, the Rulebricks CLI, and helm installed
   - Know if you have a network path to the VNet (true/false)
 - Create a copy of, review, and configure the bicep parameters file, then deploy the cluster.
 - Wait for all resources to be deployed successfully, debug any issues (permissions, quota, etc.)
 - Using the Rulebricks CLI, run `rulebricks init` to fully configure your Rulebricks instance.
 - Run `rulebricks deploy` to deploy the Rulebricks application.

This checklist continues with what to confirm you have on hand before deploying bicep.

## 1. Region and capacity

- [ ] Pick a region.
- [ ] Ensure vCPU quota for the node SKUs there: the defaults (Dasv6 family) need
      16-34 vCPUs at launch, 94 at full autoscale (configurable).
      Check: `az vm list-usage --location <region> -o table`
- [ ] PostgreSQL Flexible Server is available to your subscription there.
      Check: `az postgres flexible-server list-skus --location <region>`

## 2. IP ranges

The deployment creates its own VNet. The default ranges work as-is for an
isolated deployment, but if this VNet will be connected to your corporate
network, the ranges must not overlap anything routable on that network.

- [ ] `vnetAddressSpace` | the block your network team allocates
      (default `10.240.0.0/16`)
- [ ] `aksSubnetPrefix`, `privateEndpointsSubnetPrefix`, `postgresSubnetPrefix`
      | three non-overlapping subnets carved from inside that block
      (defaults: a /22 and two /24s). If you change the VNet range, change
      all three with it.
- [ ] `serviceCidr` + `dnsServiceIP` (default `172.16.0.0/16` / `172.16.0.10`)
      and `podCidr` (default `192.168.0.0/16`) | these are cluster-internal
      and never appear on your network, but they must not overlap the VNet or
      any range routed to it. Only change them if your network team flags a
      conflict; keep dnsServiceIP inside serviceCidr.

## 3. DNS

Rulebricks needs its own DNS subdomain delegated, e.g. `rb.mycorp.com`. The deployment
creates an Azure DNS zone for it; your organization then points the parent
domain at that zone once, and all records and TLS certificates are automatic
afterward.

- [ ] Decide the subdomain name. This becomes `dnsZoneName`.
- [ ] Identify who controls the parent domain's DNS and confirm they can add
      NS records after you deploy (the name servers appear in the
      `dnsZoneNameServers` deployment output).
- [ ] If the parent domain publishes a CAA record, confirm it permits
      Let's Encrypt (`letsencrypt.org`).

### TLS certificates

`rulebricks init` asks how certificates are issued and supports three paths:

1. **Let's Encrypt (default)** | issued and renewed automatically for every
   hostname; nothing to prepare beyond the CAA check above.
2. **Your cluster's certificate manager** | if your platform team runs a
   cert-manager issuer (Venafi, Vault, a private ACME CA, ...), the CLI
   points certificate requests at it and renewal stays fully automatic. Have
   on hand: the issuer's name and kind.
3. **Bring your own certificate files** | request them before an install.
   Rulebricks serves these hostnames under the subdomain (`<sub>` = the
   `dnsZoneName` above):

   - [ ] `<sub>` | the main app and API
   - [ ] `supabase.<sub>` | authentication and data APIs
   - [ ] `observability.<sub>` | built-in observability UI
   - [ ] `valkey.<sub>` | only if the optional Valkey admin UI is enabled

   One wildcard certificate covering `<sub>` and `*.<sub>` works for all of
   them; otherwise four individual certificates. 
   
   **It will also be useful to know if the issuing CA is publicly trusted, or
    a private/corporate CA.** Both are supported.


## 4. Network path for the installer

- [ ] The machine that runs the Rulebricks install needs a network path to
      the VNet (VPN, peering, or a jump host); the Kubernetes control plane
      and Key Vault are private. If this is not possible, you can use a public
      endpoint for the control plane and Key Vault by configuring
      `enablePrivateCluster`, `allowKeyVaultPublicAccess`, and
      `enableKeyVaultPrivateEndpoint`.

## 5. Email / SMTP

- [ ] Email is required for Rulebricks to function.
- [ ] Rulebricks supports Azure Communication Services for email. An Entra app
      should be provisioned for this, with the app ID and client secret on
      hand.
- [ ] Decide whether to also use a branded sender address:
      pick a name under the subdomain from step 3 (nothing else is needed),
      or keep the default azurecomm.net sender.

## 6. Component decisions

Confirm the defaults are what you want; each flips with one parameter:

- [ ] Managed PostgreSQL: on
- [ ] Kafka and Redis: in-cluster
- [ ] Managed Prometheus + Grafana monitoring: on

## 7. Images

- [ ] Decide whether cluster nodes pull from Rulebricks' registry directly
      (needs egress from the nodes) or through your own ACR, which caches all
      images automatically (on by default; only the registry needs egress).

## 8. Access and values to have on hand

Whoever runs the deployment needs rights to create resources AND role
assignments in the target resource group (Owner, or Contributor + User Access
Administrator), plus permission to create an Entra app registration for email.

These ensure you can authenticate to the cluster and seed secrets:

- [ ] `aksAdminPrincipalIds` | Entra object IDs of the cluster admins
- [ ] `keyVaultWriterPrincipalIds` | Entra object IDs allowed to seed secrets
      (include whoever runs the Rulebricks deploy)

These need to be provisioned before deployment:

- [ ] An Entra app for email: `az ad app create --display-name "Rulebricks SMTP"`
      then `az ad sp create --id <appId>` and `az ad app credential reset`.
      The CLI takes the app's client ID (`<appId>`) and its client secret
      (`<clientSecret>`), and grants the app access to the email service
      during deploy.
- [ ] An Entra app for SSO. Have on hand: its client ID, a client secret, and your tenant ID. The app needs one web
      redirect URI - `https://supabase.<subdomain-from-step-3>/auth/v1/callback`, 
      and ID token issuance enabled; the default `User.Read` permission is
      sufficient. To create:
      `az ad app create --display-name "Rulebricks SSO" --sign-in-audience AzureADMyOrg --web-redirect-uris "https://supabase.<subdomain>/auth/v1/callback" --enable-id-token-issuance true`,
      then `az ad app credential reset --id <appId>`.

These are provided by Rulebricks or generated by you:

- [ ] `LICENSE_KEY` | your Rulebricks license key
- [ ] `POSTGRES_ADMIN_PASSWORD` | a strong password for the managed
      PostgreSQL instance
- [ ] Admin email | the Entra account email address that should have admin
      privileges on the Rulebricks workspace.