# ===================================
# Encryption key
# ===================================
# One customer-managed key for RDS storage, the RDS-managed master password, ElastiCache and every
# secret. A customer-managed key (not the AWS-managed default) so that access is auditable in
# CloudTrail and can be revoked by IAM policy: a role that cannot kms:Decrypt cannot read the data
# even if it is granted the underlying resource.

resource "aws_kms_key" "main" {
  description             = "${var.project_name}-${var.environment}: data, cache and secrets"
  enable_key_rotation     = true
  deletion_window_in_days = var.environment == "prod" ? 30 : 7
}

resource "aws_kms_alias" "main" {
  name          = "alias/${var.project_name}-${var.environment}"
  target_key_id = aws_kms_key.main.key_id
}
