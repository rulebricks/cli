# AWS EKS Cluster for Rulebricks
# Meets minimum requirements: 4 nodes, 8 vCPU, 16GB RAM per node

terraform {
  required_version = ">= 1.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

# Variables
variable "cluster_name" {
  description = "Name of the EKS cluster"
  type        = string
  default     = "rulebricks-cluster"
}

variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
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
  description = "Enable IAM role for external-dns (Route53)"
  type        = bool
  default     = false
}

variable "external_dns_domain" {
  description = "Domain filter for external-dns"
  type        = string
  default     = ""
}

variable "enable_s3_logging" {
  description = "Enable IAM role for Vector S3 logging"
  type        = bool
  default     = false
}

variable "logging_s3_bucket" {
  description = "S3 bucket name for Vector logs"
  type        = string
  default     = ""
}

# Tier configurations
# Using Graviton4 (ARM64) instances for compatibility with arm64 container images
locals {
  tier_configs = {
    small = {
      node_count     = 4
      instance_type  = "c8g.large"  # 2 vCPU, 4GB (Graviton4 ARM64)
      min_nodes      = 4
      max_nodes      = 4
      disk_size      = 50
    }
    medium = {
      node_count     = 4
      instance_type  = "c8g.xlarge"  # 4 vCPU, 8GB (Graviton4 ARM64)
      min_nodes      = 4
      max_nodes      = 8
      disk_size      = 100
    }
    large = {
      node_count     = 5
      instance_type  = "c8g.2xlarge"  # 8 vCPU, 16GB (Graviton4 ARM64)
      min_nodes      = 5
      max_nodes      = 16
      disk_size      = 200
    }
  }

  config = local.tier_configs[var.tier]
}

# VPC
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "${var.cluster_name}-vpc"
  cidr = "10.0.0.0/16"

  azs             = ["${var.region}a", "${var.region}b", "${var.region}c"]
  private_subnets = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]

  enable_nat_gateway   = true
  single_nat_gateway   = var.tier == "small" ? true : false
  enable_dns_hostnames = true
  enable_dns_support   = true

  public_subnet_tags = {
    "kubernetes.io/role/elb"                      = 1
    "kubernetes.io/cluster/${var.cluster_name}"   = "owned"
  }

  private_subnet_tags = {
    "kubernetes.io/role/internal-elb"             = 1
    "kubernetes.io/cluster/${var.cluster_name}"   = "owned"
  }

  tags = {
    Environment = "rulebricks"
    Terraform   = "true"
  }
}

# EKS Cluster
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = var.cluster_name
  cluster_version = var.kubernetes_version

  # Grant the IAM identity running Terraform admin access to the cluster
  enable_cluster_creator_admin_permissions = true

  cluster_endpoint_public_access  = true
  cluster_endpoint_private_access = true

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  # EKS Managed Node Group
  eks_managed_node_groups = {
    rulebricks = {
      name           = "rulebricks-nodes"
      instance_types = [local.config.instance_type]
      ami_type       = "AL2_ARM_64"  # ARM AMI for Graviton instances

      min_size     = local.config.min_nodes
      max_size     = local.config.max_nodes
      desired_size = local.config.node_count

      disk_size = local.config.disk_size

      labels = {
        Environment = "rulebricks"
        Tier        = var.tier
      }
    }
  }

  # Enable IRSA for service accounts
  enable_irsa = true

  # Cluster add-ons
  cluster_addons = {
    coredns = {
      most_recent = true
    }
    kube-proxy = {
      most_recent = true
    }
    vpc-cni = {
      most_recent = true
    }
    aws-ebs-csi-driver = {
      most_recent              = true
      service_account_role_arn = module.ebs_csi_irsa.iam_role_arn
    }
  }

  tags = {
    Environment = "rulebricks"
    Terraform   = "true"
  }
}

# IAM role for EBS CSI driver
module "ebs_csi_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.0"

  role_name             = "${var.cluster_name}-ebs-csi"
  attach_ebs_csi_policy = true

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:ebs-csi-controller-sa"]
    }
  }
}

# ============================================
# External DNS IAM Role (Route53)
# ============================================
module "external_dns_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.0"

  count = var.enable_external_dns ? 1 : 0

  role_name                     = "${var.cluster_name}-external-dns"
  attach_external_dns_policy    = true
  external_dns_hosted_zone_arns = ["arn:aws:route53:::hostedzone/*"]

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["rulebricks:external-dns"]
    }
  }

  tags = {
    Environment = "rulebricks"
    Terraform   = "true"
  }
}

# ============================================
# Vector S3 Logging IAM Role
# ============================================
resource "aws_iam_policy" "vector_s3" {
  count = var.enable_s3_logging ? 1 : 0

  name        = "${var.cluster_name}-vector-s3"
  description = "IAM policy for Vector to write logs to S3"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:PutObjectAcl",
          "s3:GetObject",
          "s3:DeleteObject",
          "s3:ListBucket"
        ]
        Resource = [
          "arn:aws:s3:::${var.logging_s3_bucket}",
          "arn:aws:s3:::${var.logging_s3_bucket}/*"
        ]
      }
    ]
  })
}

module "vector_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.0"

  count = var.enable_s3_logging ? 1 : 0

  role_name = "${var.cluster_name}-vector"

  role_policy_arns = {
    vector_s3 = aws_iam_policy.vector_s3[0].arn
  }

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["rulebricks:vector"]
    }
  }

  tags = {
    Environment = "rulebricks"
    Terraform   = "true"
  }
}


# Outputs
output "cluster_name" {
  value       = module.eks.cluster_name
  description = "EKS cluster name"
}

output "cluster_endpoint" {
  value       = module.eks.cluster_endpoint
  description = "EKS cluster endpoint"
}

output "cluster_certificate_authority" {
  value       = module.eks.cluster_certificate_authority_data
  description = "Base64 encoded cluster CA certificate"
  sensitive   = true
}

output "region" {
  value       = var.region
  description = "AWS region"
}

output "kubeconfig_command" {
  value       = "aws eks update-kubeconfig --name ${var.cluster_name} --region ${var.region}"
  description = "Command to update kubeconfig"
}

output "external_dns_role_arn" {
  value       = var.enable_external_dns ? module.external_dns_irsa[0].iam_role_arn : ""
  description = "IAM role ARN for external-dns service account"
}

output "vector_role_arn" {
  value       = var.enable_s3_logging ? module.vector_irsa[0].iam_role_arn : ""
  description = "IAM role ARN for Vector service account"
}
