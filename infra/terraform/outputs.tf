# ===================================
# Outputs (no secret values)
# ===================================

output "alb_dns_name" {
  description = "Public address of the API. Point a DNS record at it."
  value       = aws_lb.main.dns_name
}

output "ecs_cluster" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.main.name
}

output "db_endpoint" {
  description = "Database host"
  value       = aws_db_instance.main.address
}

output "db_master_secret_arn" {
  description = "Secret that holds the database master credentials (managed and rotatable by RDS)"
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "redis_endpoint" {
  description = "Redis primary endpoint (TLS, auth token required)"
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "secret_names_to_fill" {
  description = "Secrets a person must fill in with infra/scripts/put-secret.sh"
  value = compact([
    aws_secretsmanager_secret.openai_api_key.name,
    one(aws_secretsmanager_secret.anthropic_api_key[*].name),
  ])
}

output "migrate_command" {
  description = "Run this once per release, before updating the services"
  value = join(" ", [
    "aws ecs run-task",
    "--cluster ${aws_ecs_cluster.main.name}",
    "--task-definition ${aws_ecs_task_definition.migrate.family}",
    "--launch-type FARGATE",
    "--network-configuration 'awsvpcConfiguration={subnets=[${join(",", aws_subnet.private[*].id)}],securityGroups=[${aws_security_group.ecs_tasks.id}],assignPublicIp=DISABLED}'",
    "--region ${var.aws_region}",
  ])
}
