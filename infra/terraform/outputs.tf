# ===================================
# Terraform Outputs
# ===================================

# Networking
output "vpc_id" {
  description = "ID of the VPC"
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "IDs of the public subnets"
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "IDs of the private subnets"
  value       = aws_subnet.private[*].id
}

# Load Balancer
output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer"
  value       = aws_lb.main.dns_name
}

output "alb_zone_id" {
  description = "Zone ID of the Application Load Balancer"
  value       = aws_lb.main.zone_id
}

output "application_url" {
  description = "URL to access the application"
  value       = "http://${aws_lb.main.dns_name}"
}

# Database
output "db_endpoint" {
  description = "RDS PostgreSQL endpoint"
  value       = aws_db_instance.docuchat.endpoint
  sensitive   = true
}

output "db_name" {
  description = "Database name"
  value       = aws_db_instance.docuchat.db_name
}

output "db_port" {
  description = "Database port"
  value       = aws_db_instance.docuchat.port
}

# Redis
output "redis_endpoint" {
  description = "ElastiCache Redis endpoint"
  value       = "${aws_elasticache_cluster.redis.cache_nodes[0].address}:${aws_elasticache_cluster.redis.cache_nodes[0].port}"
  sensitive   = true
}

output "redis_host" {
  description = "Redis host address"
  value       = aws_elasticache_cluster.redis.cache_nodes[0].address
}

output "redis_port" {
  description = "Redis port"
  value       = aws_elasticache_cluster.redis.cache_nodes[0].port
}

# ECS
output "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "Name of the ECS service"
  value       = aws_ecs_service.app.name
}

output "ecs_task_definition_arn" {
  description = "ARN of the ECS task definition"
  value       = aws_ecs_task_definition.app.arn
}

# ECR
output "ecr_repository_url" {
  description = "URL of the ECR repository"
  value       = aws_ecr_repository.app.repository_url
}

output "ecr_repository_name" {
  description = "Name of the ECR repository"
  value       = aws_ecr_repository.app.name
}

# Secrets Manager
output "secrets_arns" {
  description = "ARNs of Secrets Manager secrets"
  value = {
    openai_api_key = aws_secretsmanager_secret.openai_api_key.arn
    jwt_secret     = aws_secretsmanager_secret.jwt_secret.arn
    database       = aws_secretsmanager_secret.database.arn
  }
  sensitive = true
}

# CloudWatch
output "cloudwatch_log_group" {
  description = "Name of the CloudWatch log group"
  value       = aws_cloudwatch_log_group.ecs.name
}

# Security Groups
output "security_group_ids" {
  description = "IDs of the security groups"
  value = {
    alb       = aws_security_group.alb.id
    ecs_tasks = aws_security_group.ecs_tasks.id
    rds       = aws_security_group.rds.id
    redis     = aws_security_group.redis.id
  }
}

# Deployment Information
output "deployment_instructions" {
  description = "Instructions for deploying the application"
  value = <<-EOT

    ==========================================
    DocuChat Deployment Complete!
    ==========================================

    Application URL: http://${aws_lb.main.dns_name}

    Next Steps:

    1. Build and push Docker image:
       aws ecr get-login-password --region ${var.aws_region} | docker login --username AWS --password-stdin ${aws_ecr_repository.app.repository_url}
       docker build -t ${aws_ecr_repository.app.repository_url}:latest ./backend
       docker push ${aws_ecr_repository.app.repository_url}:latest

    2. Update ECS service to use the new image:
       aws ecs update-service --cluster ${aws_ecs_cluster.main.name} --service ${aws_ecs_service.app.name} --force-new-deployment

    3. Monitor deployment:
       aws ecs describe-services --cluster ${aws_ecs_cluster.main.name} --services ${aws_ecs_service.app.name}

    4. View logs:
       aws logs tail ${aws_cloudwatch_log_group.ecs.name} --follow

    5. Set up DNS (Optional):
       - Create a Route53 hosted zone for your domain
       - Add an A record pointing to the ALB:
         Name: api.yourdomain.com
         Type: A (Alias)
         Target: ${aws_lb.main.dns_name}

    6. Enable HTTPS (Optional):
       - Request an ACM certificate for your domain
       - Add HTTPS listener to the ALB
       - Update security groups to allow port 443

    ==========================================

  EOT
}
