# ===================================
# IAM: least privilege
# ===================================
# Two roles, deliberately different:
#   execution role  used by ECS itself to pull the image, write logs and inject secrets at start
#   task role       what the application code runs as. It has no permissions: the app only talks to
#                   Postgres, Redis and the AI providers, none of which use IAM. A compromised
#                   container therefore cannot read other secrets or touch other AWS resources.

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

locals {
  injected_secret_arns = compact([
    aws_db_instance.main.master_user_secret[0].secret_arn,
    aws_secretsmanager_secret.redis_auth.arn,
    aws_secretsmanager_secret.jwt_access.arn,
    aws_secretsmanager_secret.jwt_refresh.arn,
    aws_secretsmanager_secret.openai_api_key.arn,
    one(aws_secretsmanager_secret.anthropic_api_key[*].arn),
  ])
}

resource "aws_iam_role" "execution" {
  name               = "${var.project_name}-${var.environment}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    sid       = "ReadInjectedSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.injected_secret_arns
  }

  statement {
    sid       = "DecryptWithAppKey"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.main.arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "read-injected-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

resource "aws_iam_role" "task" {
  name               = "${var.project_name}-${var.environment}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
