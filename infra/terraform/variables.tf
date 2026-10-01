# ===================================
# Input variables
# ===================================
# Only configuration lives here. There is deliberately no variable for a password or an API key:
# secrets are created in Secrets Manager (secrets.tf) and never pass through Terraform variables.

# -----------------------------------
# General
# -----------------------------------

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be dev, staging or prod."
  }
}

variable "project_name" {
  description = "Prefix for resource names"
  type        = string
  default     = "docuchat"
}

variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "tags" {
  description = "Tags applied to every resource"
  type        = map(string)
  default = {
    Project   = "DocuChat"
    ManagedBy = "Terraform"
  }
}

# -----------------------------------
# Network
# -----------------------------------

variable "vpc_cidr" {
  description = "CIDR of the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "Availability zones to spread subnets over"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

# -----------------------------------
# Database (RDS PostgreSQL with pgvector)
# -----------------------------------

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.small"
}

variable "db_engine_version" {
  description = "PostgreSQL major version. pgvector with HNSW indexes needs 15.4 or newer."
  type        = string
  default     = "16"
}

variable "db_allocated_storage" {
  description = "Initial storage in GiB"
  type        = number
  default     = 20
}

variable "db_max_allocated_storage" {
  description = "Storage autoscaling ceiling in GiB"
  type        = number
  default     = 100
}

variable "db_name" {
  description = "Name of the application database"
  type        = string
  default     = "docuchat"
}

variable "db_username" {
  description = "Master user name. Its password is generated and rotated by RDS and kept in Secrets Manager."
  type        = string
  default     = "docuchat_admin"
}

variable "db_backup_retention_days" {
  description = "Automated backup retention. A deleted user's data stays in backups until they expire."
  type        = number
  default     = 7
}

# -----------------------------------
# Redis (ElastiCache)
# -----------------------------------

variable "redis_node_type" {
  description = "ElastiCache node type"
  type        = string
  default     = "cache.t4g.small"
}

variable "redis_nodes" {
  description = "Number of cache nodes. 2 or more enables a replica and automatic failover."
  type        = number
  default     = 2
}

variable "redis_auth_token_version" {
  description = "Increase this number to generate and apply a new Redis auth token (rotation)."
  type        = number
  default     = 1
}

# -----------------------------------
# Application (ECS Fargate)
# -----------------------------------

variable "app_image" {
  description = "Backend image, including a tag or digest. Prefer an immutable tag (the git SHA)."
  type        = string
}

variable "app_port" {
  description = "Port the API listens on"
  type        = number
  default     = 3001
}

variable "frontend_url" {
  description = "Origin of the web app, used for CORS (for example https://app.example.com)"
  type        = string
}

variable "api_count" {
  description = "Initial number of API tasks. Autoscaling adjusts it afterwards."
  type        = number
  default     = 2
}

variable "worker_count" {
  description = "Number of worker tasks (embeddings and scheduled retention)"
  type        = number
  default     = 1
}

variable "fargate_cpu" {
  description = "API task CPU units"
  type        = number
  default     = 1024
}

variable "fargate_memory" {
  description = "API task memory in MiB"
  type        = number
  default     = 2048
}

variable "worker_cpu" {
  description = "Worker task CPU units"
  type        = number
  default     = 512
}

variable "worker_memory" {
  description = "Worker task memory in MiB"
  type        = number
  default     = 1024
}

# -----------------------------------
# AI configuration (not secret)
# -----------------------------------

variable "ai_provider" {
  description = "Chat provider: openai or anthropic. The matching API key secret is created and injected."
  type        = string
  default     = "openai"

  validation {
    condition     = contains(["openai", "anthropic"], var.ai_provider)
    error_message = "ai_provider must be openai or anthropic. The mock provider is not for AWS."
  }
}

variable "ai_fallback_provider" {
  description = "Provider used when the primary is down: none, openai or anthropic"
  type        = string
  default     = "none"

  validation {
    condition     = contains(["none", "openai", "anthropic"], var.ai_fallback_provider)
    error_message = "ai_fallback_provider must be none, openai or anthropic."
  }
}

variable "embedding_provider" {
  description = "Embedding provider: auto, or openai. Anthropic has no embeddings API, so with ai_provider = anthropic this must resolve to openai."
  type        = string
  default     = "auto"

  validation {
    condition     = contains(["auto", "openai"], var.embedding_provider)
    error_message = "embedding_provider must be auto or openai on AWS."
  }
}

variable "app_environment" {
  description = "Extra non-secret settings for the containers (budgets, prompt versions, retention...). Overrides the defaults set in ecs.tf."
  type        = map(string)
  default     = {}
}

variable "jwt_secret_version" {
  description = "Increase this number to generate new JWT signing secrets. Doing so signs every user out."
  type        = number
  default     = 1
}

# -----------------------------------
# Load balancer
# -----------------------------------

variable "acm_certificate_arn" {
  description = "ACM certificate for HTTPS. Required in prod: without it traffic, including tokens and documents, would be unencrypted."
  type        = string
  default     = ""
}

variable "alb_idle_timeout" {
  description = "Seconds an idle connection stays open. Streamed answers send a heartbeat every 15 s, so this only needs to exceed that; it is raised from the 60 s default as a margin."
  type        = number
  default     = 120
}

# -----------------------------------
# Autoscaling
# -----------------------------------

variable "autoscaling_min_capacity" {
  description = "Minimum API tasks"
  type        = number
  default     = 2
}

variable "autoscaling_max_capacity" {
  description = "Maximum API tasks. The AI provider's rate limit, not CPU, usually decides how many are useful."
  type        = number
  default     = 10
}

variable "autoscaling_cpu_threshold" {
  description = "Target average CPU percentage"
  type        = number
  default     = 60
}

variable "autoscaling_requests_per_target" {
  description = "Target requests per task per minute (the signal that actually tracks load for I/O-bound AI traffic)"
  type        = number
  default     = 120
}

# -----------------------------------
# Monitoring and cost
# -----------------------------------

variable "log_retention_days" {
  description = "CloudWatch log retention"
  type        = number
  default     = 30
}

variable "alert_email" {
  description = "Where alarms and budget alerts go. Leave empty to create no alarms or budget."
  type        = string
  default     = ""
}

variable "monthly_budget_usd" {
  description = "Monthly AWS cost budget. Alerts at 80 % of actual and 100 % of forecast."
  type        = number
  default     = 150
}
