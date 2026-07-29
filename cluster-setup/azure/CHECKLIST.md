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
 - Deploy `prerequisites.bicep` (DNS zone, external-dns identity, email
   service), or by hand it to/request it from the team that controls DNS and
   email at your organization. See steps 3 and 5.
 - Create a copy of, review, and configure the bicep parameters file, then
   deploy `main.bicep`.
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

Rulebricks needs its own DNS subdomain delegated, e.g. `rb.mycorp.com`.
[prerequisites.bicep](prerequisites.bicep) creates an Azure DNS zone for it,
plus the identity external-dns runs as (granted DNS Zone Contributor on that
zone); your organization then points the parent domain at the zone once, and
all records and TLS certificates are automatic afterward.

- [ ] Decide the subdomain name. This becomes `dnsZoneName` in both parameter
      files.
- [ ] Deploy the prerequisites - or, if creating DNS zones is gated at your
      organization, hand `prerequisites.bicep` to the team that owns DNS. They
      deploy it into any resource group they like with your Entra object ID in
      `deployerPrincipalIds`, which grants you the read (and one
      federated-credential write) access the main deployment needs there -
      nothing else to request. You then set `prerequisitesResourceGroup` and
      the values from their `mainDeploymentParameters` output in your
      parameters file.
- [ ] Identify who controls the parent domain's DNS and confirm they can add
      NS records after the prerequisites deploy (the name servers appear in
      its `dnsZoneNameServers` output).
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
- [ ] Decide the sender address: the Azure-managed `azurecomm.net` one, which
      works as soon as the deployment finishes, or a branded address on a
      domain you own (`DoNotReply@mycorp.com`).

**Already have email?** If your organization gives you SMTP credentials from
any provider (Exchange with SMTP AUTH, SES, SendGrid, Resend, ...), set
`enableManagedEmail = false` and hand those credentials to `rulebricks init`
instead. Nothing else in this section applies.

### Branded sender

Proving you own a domain is a DNS round-trip on Azure's schedule, which is why
the email service and its domains live in the prerequisites deployment: verify
once there, and the main deployment (and every redeploy) simply links the
already-verified domain.

- [ ] Set `emailSenderDomain` in the prerequisites parameters to a name under
      the zone from step 3 (or the zone itself). The verification DNS records
      are published into the zone automatically.
- [ ] After the prerequisites deploy, run its
      `emailInitiateVerificationCommands` outputs (four short `az` commands)
      and wait until its `emailVerificationStatusCommand` reports all four
      checks Verified - typically a couple of minutes. If a platform team ran
      the prerequisites, this is theirs to run too.
- [ ] Set `emailBrandedDomainName` to the same domain in the main parameters.
      Branded email then works on the first run; if verification is still
      pending when main deploys, the deployment does not fail - the
      `azurecomm.net` sender works immediately and the Rulebricks CLI links
      the branded domain automatically once verification lands.

**Organization already runs ACS with a verified domain?** No new email service
is needed: point `emailServiceName`, `emailServiceResourceGroup`, and
`emailBrandedDomainName` in the main parameters at theirs (set
`emailFallbackDomainName = ''` if that service has no Azure-managed domain).
Linking only READS the domain, so Reader on it is all you need to ask for.

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

Whoever runs a deployment needs rights to create resources AND role
assignments in its target resource group (Owner, or Contributor + User Access
Administrator), plus permission to create an Entra app registration for email.
Most privileged, org-gated pieces are in `prerequisites.bicep`.

- **Prerequisites deployer** (you, or a platform team): Owner or
  Contributor + User Access Administrator on the prerequisites resource group.
- **Main deployer**: the same, but only on the workload resource group. When
  the prerequisites live in a different resource group, the two grants the
  main deployment needs there (Reader, plus federated-credential write on the
  external-dns identity) are made automatically by listing your object ID in
  the prerequisites' `deployerPrincipalIds`.

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
      then `az ad sp create --id <appId>` and `az ad app credential reset --id <appId>`.
      The service principal is required: an app registration without one is not
      a sign-in target, and SSO fails at login even though every other setting
      looks correct. The redirect URI must match the deployment's subdomain
      exactly - an app reused from an earlier deployment still carries the old
      one, and the mismatch surfaces only as a redirect_uri error at Entra.

These are provided by Rulebricks or generated by you:

- [ ] `LICENSE_KEY` | your Rulebricks license key
- [ ] `POSTGRES_ADMIN_PASSWORD` | a strong password for the managed
      PostgreSQL instance
- [ ] Rulebricks admin email | the Entra account email address that should have admin
      privileges on the Rulebricks workspace.