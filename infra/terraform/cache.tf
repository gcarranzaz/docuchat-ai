# ===================================
# Redis (ElastiCache): rate limits, answer cache, job queue
# ===================================

resource "aws_elasticache_subnet_group" "main" {
  name       = "${var.project_name}-${var.environment}"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${var.project_name}-${var.environment}"
  description          = "${var.project_name} ${var.environment} Redis"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.redis_node_type
  port           = 6379

  num_cache_clusters         = var.redis_nodes
  automatic_failover_enabled = var.redis_nodes > 1
  multi_az_enabled           = var.redis_nodes > 1

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  # Encrypted in transit (the app sets REDIS_TLS=true) and at rest, and password protected.
  transit_encryption_enabled = true
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.main.arn

  # The token is write-only: Terraform sends it to AWS but never stores it in state. The same
  # ephemeral value is written to Secrets Manager in secrets.tf. Bump redis_auth_token_version to rotate.
  auth_token_wo         = ephemeral.random_password.redis_auth.result
  auth_token_wo_version = var.redis_auth_token_version

  snapshot_retention_limit = 1
  apply_immediately        = var.environment != "prod"
}
