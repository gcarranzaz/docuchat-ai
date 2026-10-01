# ===================================
# ECS Fargate: API service, worker service, one-off migration task
# ===================================
# All three run the same image. Configuration comes from the environment (plain values below,
# secrets injected by ECS from Secrets Manager); nothing is baked into the image.

resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-${var.environment}"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.project_name}-${var.environment}"
  retention_in_days = var.log_retention_days
  kms_key_id        = null # application logs carry no document content (see docs/AI-DATA.md)
}

locals {
  secret_ref = {
    db_user   = "${aws_db_instance.main.master_user_secret[0].secret_arn}:username::"
    db_pass   = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::"
    redis     = aws_secretsmanager_secret.redis_auth.arn
    jwt       = aws_secretsmanager_secret.jwt_access.arn
    jwt_refr  = aws_secretsmanager_secret.jwt_refresh.arn
    openai    = aws_secretsmanager_secret.openai_api_key.arn
    anthropic = one(aws_secretsmanager_secret.anthropic_api_key[*].arn)
  }

  # Non-secret settings. var.app_environment overrides any of these (budgets, prompt versions...).
  base_environment = {
    NODE_ENV             = "production"
    PORT                 = tostring(var.app_port)
    DB_HOST              = aws_db_instance.main.address
    DB_PORT              = "5432"
    DB_NAME              = var.db_name
    DB_SSL               = "verify"
    DB_SSL_CA_FILE       = "/app/certs/rds-global-bundle.pem"
    REDIS_HOST           = aws_elasticache_replication_group.main.primary_endpoint_address
    REDIS_PORT           = "6379"
    REDIS_TLS            = "true"
    TRUST_PROXY          = "1"
    FRONTEND_URL         = var.frontend_url
    AI_PROVIDER          = var.ai_provider
    AI_FALLBACK_PROVIDER = var.ai_fallback_provider
    EMBEDDING_PROVIDER   = var.embedding_provider == "auto" ? "openai" : var.embedding_provider
    # Slightly under the container stopTimeout (60 s) so the process exits before ECS kills it
    SHUTDOWN_GRACE_MS = "45000"
  }

  environment = [
    for name, value in merge(local.base_environment, var.app_environment) : { name = name, value = value }
  ]

  secrets = concat(
    [
      { name = "DB_USER", valueFrom = local.secret_ref.db_user },
      { name = "DB_PASSWORD", valueFrom = local.secret_ref.db_pass },
      { name = "REDIS_PASSWORD", valueFrom = local.secret_ref.redis },
      { name = "JWT_SECRET", valueFrom = local.secret_ref.jwt },
      { name = "JWT_REFRESH_SECRET", valueFrom = local.secret_ref.jwt_refr },
      { name = "OPENAI_API_KEY", valueFrom = local.secret_ref.openai },
    ],
    local.need_anthropic ? [{ name = "ANTHROPIC_API_KEY", valueFrom = local.secret_ref.anthropic }] : []
  )

  log_config = {
    logDriver = "awslogs"
    options = {
      awslogs-group         = aws_cloudwatch_log_group.app.name
      awslogs-region        = var.aws_region
      awslogs-stream-prefix = "ecs"
    }
  }
}

# ---------- API ----------

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.project_name}-${var.environment}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.fargate_cpu
  memory                   = var.fargate_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name             = "api"
    image            = var.app_image
    essential        = true
    stopTimeout      = 60
    portMappings     = [{ containerPort = var.app_port, protocol = "tcp" }]
    environment      = local.environment
    secrets          = local.secrets
    logConfiguration = local.log_config
    healthCheck = {
      command     = ["CMD-SHELL", "wget -q --spider http://localhost:${var.app_port}/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 20
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_count
  launch_type     = "FARGATE"

  health_check_grace_period_seconds  = 60
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # A bad release rolls itself back instead of taking the service down.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = var.app_port
  }

  depends_on = [aws_lb_listener.http, aws_lb_listener.https]

  # Autoscaling owns the task count after creation
  lifecycle {
    ignore_changes = [desired_count]
  }
}

# ---------- Worker (embeddings, scheduled retention) ----------

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.project_name}-${var.environment}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name             = "worker"
    image            = var.app_image
    essential        = true
    stopTimeout      = 60
    command          = ["node", "dist/workers/start-worker.js"]
    environment      = local.environment
    secrets          = local.secrets
    logConfiguration = local.log_config
  }])
}

resource "aws_ecs_service" "worker" {
  name            = "worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_count
  launch_type     = "FARGATE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = false
  }
}

# ---------- Migrations (run once per release, before the services update) ----------
# aws ecs run-task --cluster <cluster> --task-definition <family> --launch-type FARGATE \
#   --network-configuration "awsvpcConfiguration={subnets=[...],securityGroups=[...]}"
# The exact command is printed by `terraform output migrate_command`.

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.project_name}-${var.environment}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name             = "migrate"
    image            = var.app_image
    essential        = true
    command          = ["node", "dist/config/migrate.js"]
    environment      = local.environment
    secrets          = local.secrets
    logConfiguration = local.log_config
  }])
}
