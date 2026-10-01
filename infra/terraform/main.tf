# ===================================
# DocuChat infrastructure on AWS
# ===================================
#
# Files:
#   network.tf      VPC, subnets, NAT, security groups
#   kms.tf          one customer-managed key (RDS, ElastiCache, Secrets Manager)
#   database.tf     RDS PostgreSQL with pgvector; master password managed by RDS
#   cache.tf        ElastiCache Redis with TLS and an auth token
#   secrets.tf      Secrets Manager: where every secret lives, and how each gets its value
#   iam.tf          least-privilege roles
#   alb.tf          load balancer, HTTPS, health check
#   ecs.tf          API service, worker service, one-off migration task
#   autoscaling.tf  scaling policies for bursty, I/O-bound AI traffic
#   monitoring.tf   alarms and a monthly cost budget
#
# Secrets policy: no secret value is ever written in a .tf or .tfvars file, and none of the
# generated ones reaches the Terraform state. See secrets.tf and docs/DEPLOYMENT.md.

terraform {
  # Write-only arguments (secret_string_wo, auth_token_wo) and ephemeral resources need these
  required_version = ">= 1.11"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }

  # Remote state for any shared or production use: encrypted, versioned, locked.
  # Create the bucket and lock table first (docs/DEPLOYMENT.md), then uncomment.
  # backend "s3" {
  #   bucket         = "docuchat-terraform-state"
  #   key            = "prod/terraform.tfstate"
  #   region         = "us-east-1"
  #   encrypt        = true
  #   dynamodb_table = "docuchat-terraform-locks"
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = var.tags
  }
}

data "aws_caller_identity" "current" {}
