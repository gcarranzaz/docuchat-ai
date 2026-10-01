# DocuChat Terraform Infrastructure

This directory contains Terraform configurations for deploying DocuChat to AWS using best practices for production-ready infrastructure.

## Architecture Overview

The infrastructure includes:

- **VPC with Public and Private Subnets** across 2 availability zones
- **Application Load Balancer** for distributing traffic
- **ECS Fargate** for running containerized applications
- **RDS PostgreSQL** with pgvector extension for vector storage
- **ElastiCache Redis** for job queues (BullMQ)
- **Secrets Manager** for secure credential storage
- **CloudWatch** for logging and monitoring
- **Auto Scaling** based on CPU and memory utilization
- **ECR** for Docker image storage

## Prerequisites

1. **AWS Account** with appropriate permissions
2. **AWS CLI** installed and configured
3. **Terraform** >= 1.0 installed
4. **Docker** installed (for building images)
5. **PostgreSQL** knowledge for database setup

### Install Terraform

```bash
# macOS
brew install terraform

# Windows (Chocolatey)
choco install terraform

# Linux
wget https://releases.hashicorp.com/terraform/1.6.0/terraform_1.6.0_linux_amd64.zip
unzip terraform_1.6.0_linux_amd64.zip
sudo mv terraform /usr/local/bin/
```

### Configure AWS CLI

```bash
aws configure
# Enter your AWS Access Key ID
# Enter your AWS Secret Access Key
# Default region: us-east-1
# Default output format: json
```

## Initial Setup

### 1. Create terraform.tfvars

```bash
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars` and fill in your values:

```hcl
environment  = "prod"
aws_region   = "us-east-1"

# Database credentials
db_password = "YOUR_STRONG_DB_PASSWORD"

# API Keys
openai_api_key = "sk-your-openai-api-key"
jwt_secret = "your-32-char-random-secret"
jwt_refresh_secret = "your-32-char-random-refresh-secret"

# ECR image URL (will be created, update after first apply)
app_image = "ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com/docuchat-prod:latest"
```

**IMPORTANT:** Never commit `terraform.tfvars` to version control!

### 2. Generate Secure Secrets

```bash
# Generate JWT secrets (32 characters)
openssl rand -base64 32
openssl rand -base64 32

# Generate database password
openssl rand -base64 24
```

### 3. Configure Remote State (Optional but Recommended for Production)

Create an S3 bucket and DynamoDB table for storing Terraform state:

```bash
# Create S3 bucket for state
aws s3 mb s3://docuchat-terraform-state --region us-east-1

# Enable versioning
aws s3api put-bucket-versioning \
  --bucket docuchat-terraform-state \
  --versioning-configuration Status=Enabled

# Enable encryption
aws s3api put-bucket-encryption \
  --bucket docuchat-terraform-state \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      }
    }]
  }'

# Create DynamoDB table for state locking
aws dynamodb create-table \
  --table-name docuchat-terraform-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1
```

Then uncomment the `backend` block in `main.tf`:

```hcl
backend "s3" {
  bucket         = "docuchat-terraform-state"
  key            = "prod/terraform.tfstate"
  region         = "us-east-1"
  encrypt        = true
  dynamodb_table = "docuchat-terraform-locks"
}
```

## Deployment

### Step 1: Initialize Terraform

```bash
cd infra/terraform
terraform init
```

This will download the required AWS provider plugins.

### Step 2: Review the Plan

```bash
terraform plan
```

Review the resources that will be created. You should see:
- 1 VPC
- 2 Public Subnets
- 2 Private Subnets
- 2 NAT Gateways
- 1 RDS Instance
- 1 ElastiCache cluster
- 1 ECS Cluster
- 1 Application Load Balancer
- And more...

### Step 3: Apply Infrastructure

```bash
terraform apply
```

Type `yes` when prompted. This will take approximately 10-15 minutes.

### Step 4: Note the Outputs

After successful apply, you'll see outputs including:

```
alb_dns_name = "docuchat-alb-prod-1234567890.us-east-1.elb.amazonaws.com"
ecr_repository_url = "123456789012.dkr.ecr.us-east-1.amazonaws.com/docuchat-prod"
application_url = "http://docuchat-alb-prod-1234567890.us-east-1.elb.amazonaws.com"
```

### Step 5: Build and Push Docker Image

```bash
# Get the ECR repository URL from terraform output
ECR_URL=$(terraform output -raw ecr_repository_url)

# Login to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin $ECR_URL

# Build the Docker image
cd ../../backend
docker build -t docuchat:latest .

# Tag the image
docker tag docuchat:latest $ECR_URL:latest

# Push to ECR
docker push $ECR_URL:latest
```

### Step 6: Update ECS Service

After pushing the image, update the `app_image` variable in `terraform.tfvars`:

```hcl
app_image = "123456789012.dkr.ecr.us-east-1.amazonaws.com/docuchat-prod:latest"
```

Then apply the changes:

```bash
terraform apply
```

### Step 7: Run Database Migrations

Connect to the database and run migrations:

```bash
# Get database endpoint from Terraform
DB_HOST=$(terraform output -raw db_endpoint | cut -d: -f1)
DB_NAME=$(terraform output -raw db_name)

# SSH into an ECS task or use a bastion host
# Then run migrations
npm run db:migrate
```

Alternatively, create a one-time ECS task for migrations.

### Step 8: Verify Deployment

```bash
# Get the application URL
APP_URL=$(terraform output -raw application_url)

# Check health endpoint
curl $APP_URL/health

# You should see:
# {"status":"ok","timestamp":"2024-01-15T10:30:00.000Z"}
```

## Post-Deployment

### Enable HTTPS

1. Request an ACM certificate:

```bash
aws acm request-certificate \
  --domain-name api.yourdomain.com \
  --validation-method DNS \
  --region us-east-1
```

2. Validate the certificate using DNS records

3. Add HTTPS listener to ALB (modify `main.tf`):

```hcl
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS-1-2-2017-01"
  certificate_arn   = "arn:aws:acm:us-east-1:ACCOUNT_ID:certificate/CERT_ID"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# Redirect HTTP to HTTPS
resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
```

### Set Up Custom Domain

1. Create Route53 hosted zone:

```bash
aws route53 create-hosted-zone \
  --name yourdomain.com \
  --caller-reference $(date +%s)
```

2. Add A record pointing to ALB:

```hcl
resource "aws_route53_record" "api" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "api.yourdomain.com"
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}
```

### Enable pgvector Extension

Connect to RDS and enable the extension:

```sql
-- Connect to the database
psql -h <db-endpoint> -U docuchat_admin -d docuchat

-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Verify
SELECT * FROM pg_extension WHERE extname = 'vector';
```

## Monitoring and Maintenance

### View Logs

```bash
# View ECS logs
aws logs tail /ecs/docuchat-prod --follow

# View specific log stream
aws logs get-log-events \
  --log-group-name /ecs/docuchat-prod \
  --log-stream-name ecs/docuchat-container/TASK_ID
```

### Monitor ECS Service

```bash
# Check service status
aws ecs describe-services \
  --cluster docuchat-cluster-prod \
  --services docuchat-service-prod

# Check task status
aws ecs list-tasks \
  --cluster docuchat-cluster-prod \
  --service-name docuchat-service-prod
```

### Scale ECS Service Manually

```bash
# Scale to 5 tasks
aws ecs update-service \
  --cluster docuchat-cluster-prod \
  --service docuchat-service-prod \
  --desired-count 5
```

### Database Backups

RDS automatically creates daily backups. To create a manual snapshot:

```bash
aws rds create-db-snapshot \
  --db-instance-identifier docuchat-db-prod \
  --db-snapshot-identifier docuchat-manual-snapshot-$(date +%Y%m%d)
```

## Cost Optimization

### Development/Testing Environment

For non-production environments, modify `terraform.tfvars`:

```hcl
environment = "dev"

# Smaller instances
db_instance_class = "db.t3.micro"
redis_node_type = "cache.t3.micro"
redis_num_cache_nodes = 1

# Fewer tasks
app_count = 1
autoscaling_min_capacity = 1
autoscaling_max_capacity = 2

# Single AZ
availability_zones = ["us-east-1a"]
```

Estimated monthly cost for dev: **~$50-80**

### Production Environment

Current configuration estimated monthly cost: **~$250-400**

Breakdown:
- ECS Fargate (2 tasks): ~$60
- RDS (db.t3.small, Multi-AZ): ~$90
- ElastiCache (2 nodes): ~$50
- NAT Gateway (2 AZs): ~$70
- ALB: ~$20
- Data transfer: ~$10-50
- OpenAI API (varies by usage)

## Troubleshooting

### ECS Tasks Not Starting

```bash
# Check task failures
aws ecs describe-tasks \
  --cluster docuchat-cluster-prod \
  --tasks $(aws ecs list-tasks --cluster docuchat-cluster-prod --service-name docuchat-service-prod --query 'taskArns[0]' --output text)

# Common issues:
# - Image not found: Push Docker image to ECR
# - Secret access denied: Check IAM policies
# - Health check failing: Verify /health endpoint
```

### Database Connection Issues

```bash
# Test connection from ECS task
aws ecs execute-command \
  --cluster docuchat-cluster-prod \
  --task TASK_ID \
  --container docuchat-container \
  --interactive \
  --command "/bin/sh"

# Then inside the container:
psql -h $DB_HOST -U $DB_USER -d $DB_NAME
```

### Redis Connection Issues

```bash
# Test Redis connection
redis-cli -h <redis-endpoint> -p 6379 ping
# Should return: PONG
```

## Cleanup

To destroy all resources:

```bash
# WARNING: This will delete EVERYTHING including the database!
terraform destroy
```

For production, you may want to:
1. Create a final DB snapshot manually
2. Backup any important data
3. Export CloudWatch logs
4. Then run `terraform destroy`

## Security Best Practices

1. **Never commit secrets** to version control
2. **Use AWS Secrets Manager** for all sensitive values
3. **Enable MFA** on AWS accounts
4. **Rotate credentials** regularly
5. **Enable CloudTrail** for audit logging
6. **Use VPC Flow Logs** for network monitoring
7. **Enable GuardDuty** for threat detection
8. **Regular security updates** - rebuild Docker images with updated dependencies

## Resources

- [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)
- [Terraform AWS Provider Docs](https://registry.terraform.io/providers/hashicorp/aws/latest/docs)
- [ECS Best Practices](https://docs.aws.amazon.com/AmazonECS/latest/bestpracticesguide/)
- [RDS PostgreSQL Best Practices](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_BestPractices.html)

## Support

For issues or questions:
1. Check the [main README](../../README.md)
2. Review [ARCHITECTURE.md](../../ARCHITECTURE.md)
3. Check AWS CloudWatch logs
4. Contact your DevOps team
