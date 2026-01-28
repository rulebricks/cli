# Azure AKS Cluster for Rulebricks
# Meets minimum requirements: 4 nodes, 8 vCPU, 16GB RAM per node

terraform {
  required_version = ">= 1.0.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
}

# Variables
variable "cluster_name" {
  description = "Name of the AKS cluster"
  type        = string
  default     = "rulebricks-cluster"
}

variable "resource_group_name" {
  description = "Name of the Azure resource group"
  type        = string
  default     = "rulebricks-rg"
}

variable "location" {
  description = "Azure region"
  type        = string
  default     = "eastus"
}

variable "tier" {
  description = "Performance tier: small, medium, large"
  type        = string
  default     = "small"
}

variable "kubernetes_version" {
  description = "Kubernetes version"
  type        = string
  default     = "1.29"
}

variable "enable_external_dns" {
  description = "Enable managed identity for external-dns (Azure DNS)"
  type        = bool
  default     = false
}

variable "dns_zone_resource_group" {
  description = "Resource group containing the Azure DNS zone"
  type        = string
  default     = ""
}

variable "enable_blob_logging" {
  description = "Enable managed identity for Vector Azure Blob logging"
  type        = bool
  default     = false
}

variable "logging_storage_account" {
  description = "Azure Storage account name for Vector logs"
  type        = string
  default     = ""
}

variable "logging_container_name" {
  description = "Azure Blob container name for Vector logs"
  type        = string
  default     = ""
}

# Tier configurations
# Using Ampere (ARM64) instances for compatibility with arm64 container images
locals {
  tier_configs = {
    small = {
      node_count   = 4
      vm_size      = "Standard_D2ps_v5"  # 2 vCPU, 8GB (Ampere ARM64)
      min_nodes    = 4
      max_nodes    = 4
      disk_size    = 50
    }
    medium = {
      node_count   = 4
      vm_size      = "Standard_D4ps_v5"  # 4 vCPU, 16GB (Ampere ARM64)
      min_nodes    = 4
      max_nodes    = 8
      disk_size    = 100
    }
    large = {
      node_count   = 5
      vm_size      = "Standard_D8ps_v5"  # 8 vCPU, 32GB (Ampere ARM64)
      min_nodes    = 5
      max_nodes    = 16
      disk_size    = 200
    }
  }

  config = local.tier_configs[var.tier]
}

# Resource Group
resource "azurerm_resource_group" "rg" {
  name     = var.resource_group_name
  location = var.location

  tags = {
    Environment = "rulebricks"
    Terraform   = "true"
  }
}

# Virtual Network
resource "azurerm_virtual_network" "vnet" {
  name                = "${var.cluster_name}-vnet"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  address_space       = ["10.0.0.0/8"]

  tags = {
    Environment = "rulebricks"
  }
}

# Subnet for AKS
resource "azurerm_subnet" "aks" {
  name                 = "aks-subnet"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = ["10.240.0.0/16"]
}

# User Assigned Identity for AKS
resource "azurerm_user_assigned_identity" "aks" {
  name                = "${var.cluster_name}-identity"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
}

# Role assignment for network contributor
resource "azurerm_role_assignment" "network" {
  scope                = azurerm_virtual_network.vnet.id
  role_definition_name = "Network Contributor"
  principal_id         = azurerm_user_assigned_identity.aks.principal_id
}

# AKS Cluster
resource "azurerm_kubernetes_cluster" "aks" {
  name                = var.cluster_name
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  dns_prefix          = var.cluster_name
  kubernetes_version  = var.kubernetes_version

  default_node_pool {
    name                = "default"
    node_count          = var.tier == "small" ? local.config.node_count : null
    min_count           = var.tier != "small" ? local.config.min_nodes : null
    max_count           = var.tier != "small" ? local.config.max_nodes : null
    enable_auto_scaling = var.tier != "small"
    vm_size             = local.config.vm_size
    os_disk_size_gb     = local.config.disk_size
    os_disk_type        = "Managed"
    vnet_subnet_id      = azurerm_subnet.aks.id

    node_labels = {
      "environment" = "rulebricks"
      "tier"        = var.tier
    }
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.aks.id]
  }

  network_profile {
    network_plugin    = "azure"
    network_policy    = "calico"
    load_balancer_sku = "standard"
    service_cidr      = "10.0.0.0/16"
    dns_service_ip    = "10.0.0.10"
  }

  oidc_issuer_enabled       = true
  workload_identity_enabled = true

  storage_profile {
    disk_driver_enabled = true
    file_driver_enabled = true
  }

  tags = {
    Environment = "rulebricks"
    Terraform   = "true"
  }

  depends_on = [
    azurerm_role_assignment.network
  ]
}

# ============================================
# External DNS Managed Identity (Azure DNS)
# ============================================
resource "azurerm_user_assigned_identity" "external_dns" {
  count               = var.enable_external_dns ? 1 : 0
  name                = "${var.cluster_name}-external-dns"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
}

# DNS Zone Contributor role for external-dns
resource "azurerm_role_assignment" "external_dns_zone" {
  count                = var.enable_external_dns && var.dns_zone_resource_group != "" ? 1 : 0
  scope                = "/subscriptions/${data.azurerm_subscription.current.subscription_id}/resourceGroups/${var.dns_zone_resource_group}"
  role_definition_name = "DNS Zone Contributor"
  principal_id         = azurerm_user_assigned_identity.external_dns[0].principal_id
}

# Federated credential for external-dns workload identity
resource "azurerm_federated_identity_credential" "external_dns" {
  count               = var.enable_external_dns ? 1 : 0
  name                = "external-dns"
  resource_group_name = azurerm_resource_group.rg.name
  parent_id           = azurerm_user_assigned_identity.external_dns[0].id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = azurerm_kubernetes_cluster.aks.oidc_issuer_url
  subject             = "system:serviceaccount:rulebricks:external-dns"
}

# ============================================
# Vector Blob Storage Managed Identity
# ============================================
resource "azurerm_user_assigned_identity" "vector" {
  count               = var.enable_blob_logging ? 1 : 0
  name                = "${var.cluster_name}-vector"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
}

# Get storage account (if provided)
data "azurerm_storage_account" "logging" {
  count               = var.enable_blob_logging && var.logging_storage_account != "" ? 1 : 0
  name                = var.logging_storage_account
  resource_group_name = azurerm_resource_group.rg.name
}

# Storage Blob Data Contributor role for Vector
resource "azurerm_role_assignment" "vector_blob" {
  count                = var.enable_blob_logging && var.logging_storage_account != "" ? 1 : 0
  scope                = data.azurerm_storage_account.logging[0].id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.vector[0].principal_id
}

# Federated credential for Vector workload identity
resource "azurerm_federated_identity_credential" "vector" {
  count               = var.enable_blob_logging ? 1 : 0
  name                = "vector"
  resource_group_name = azurerm_resource_group.rg.name
  parent_id           = azurerm_user_assigned_identity.vector[0].id
  audience            = ["api://AzureADTokenExchange"]
  issuer              = azurerm_kubernetes_cluster.aks.oidc_issuer_url
  subject             = "system:serviceaccount:rulebricks:vector"
}

# Current subscription data
data "azurerm_subscription" "current" {}

# Outputs
output "cluster_name" {
  value       = azurerm_kubernetes_cluster.aks.name
  description = "AKS cluster name"
}

output "cluster_endpoint" {
  value       = azurerm_kubernetes_cluster.aks.kube_config[0].host
  description = "AKS cluster endpoint"
  sensitive   = true
}

output "cluster_ca_certificate" {
  value       = azurerm_kubernetes_cluster.aks.kube_config[0].cluster_ca_certificate
  description = "Base64 encoded cluster CA certificate"
  sensitive   = true
}

output "resource_group_name" {
  value       = azurerm_resource_group.rg.name
  description = "Azure resource group name"
}

output "location" {
  value       = var.location
  description = "Azure region"
}

output "kubeconfig_command" {
  value       = "az aks get-credentials --name ${var.cluster_name} --resource-group ${var.resource_group_name}"
  description = "Command to update kubeconfig"
}

output "kube_config" {
  value       = azurerm_kubernetes_cluster.aks.kube_config_raw
  description = "Raw kubeconfig for the AKS cluster"
  sensitive   = true
}

output "external_dns_client_id" {
  value       = var.enable_external_dns ? azurerm_user_assigned_identity.external_dns[0].client_id : ""
  description = "Client ID for external-dns managed identity"
}

output "vector_client_id" {
  value       = var.enable_blob_logging ? azurerm_user_assigned_identity.vector[0].client_id : ""
  description = "Client ID for Vector managed identity"
}
