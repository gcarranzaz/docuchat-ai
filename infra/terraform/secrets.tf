# ===================================
# Secrets Manager: where every secret lives
# ===================================
#
#   Secret                         Source of the value                      In Terraform state?
#   -----------------------------  ---------------------------------------  -------------------
#   RDS master password            generated and rotated by RDS             no
#   Redis auth token               ephemeral random_password (write-only)   no
#   JWT access / refresh secrets   ephemeral random_password (write-only)   no
#   OpenAI / Anthropic API keys    a person, once, with put-secret.sh       no (container only)
#
# Terraform creates the provider-key secrets empty. A person puts the value in with
# infra/scripts/put-secret.sh, which reads it from a hidden prompt, so the key is never in a .tf file,
# a tfvars file, shell history or the state. docs/DEPLOYMENT.md covers rotation.

locals {
  recovery_window = var.environment == "prod" ? 7 : 0

  # Embeddings always need OpenAI (Anthropic has no embeddings API), so its key is always required.
  # The Anthropic key is only needed when Anthropic is the primary or the fallback.
  need_anthropic = var.ai_provider == "anthropic" || var.ai_fallback_provider == "anthropic"
}

# ---------- Generated, write-only ----------

ephemeral "random_password" "redis_auth" {
  length  = 48
  special = false
}

ephemeral "random_password" "jwt_access" {
  length  = 64
  special = false
}

ephemeral "random_password" "jwt_refresh" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "redis_auth" {
  name                    = "${var.project_name}/${var.environment}/redis-auth-token"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = local.recovery_window
}

resource "aws_secretsmanager_secret_version" "redis_auth" {
  secret_id                = aws_secretsmanager_secret.redis_auth.id
  secret_string_wo         = ephemeral.random_password.redis_auth.result
  secret_string_wo_version = var.redis_auth_token_version
}

resource "aws_secretsmanager_secret" "jwt_access" {
  name                    = "${var.project_name}/${var.environment}/jwt-secret"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = local.recovery_window
}

resource "aws_secretsmanager_secret_version" "jwt_access" {
  secret_id                = aws_secretsmanager_secret.jwt_access.id
  secret_string_wo         = ephemeral.random_password.jwt_access.result
  secret_string_wo_version = var.jwt_secret_version
}

resource "aws_secretsmanager_secret" "jwt_refresh" {
  name                    = "${var.project_name}/${var.environment}/jwt-refresh-secret"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = local.recovery_window
}

resource "aws_secretsmanager_secret_version" "jwt_refresh" {
  secret_id                = aws_secretsmanager_secret.jwt_refresh.id
  secret_string_wo         = ephemeral.random_password.jwt_refresh.result
  secret_string_wo_version = var.jwt_secret_version
}

# ---------- Provided by a person (containers only) ----------

resource "aws_secretsmanager_secret" "openai_api_key" {
  name                    = "${var.project_name}/${var.environment}/openai-api-key"
  description             = "Set with infra/scripts/put-secret.sh. Terraform never sees the value."
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = local.recovery_window
}

resource "aws_secretsmanager_secret" "anthropic_api_key" {
  count                   = local.need_anthropic ? 1 : 0
  name                    = "${var.project_name}/${var.environment}/anthropic-api-key"
  description             = "Set with infra/scripts/put-secret.sh. Terraform never sees the value."
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = local.recovery_window
}
