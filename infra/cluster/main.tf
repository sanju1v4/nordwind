# Nordwind production-style setup on one EC2 server running k3s (lightweight Kubernetes).
#
#   - EC2 server with NO inbound ports: admin access and deploys only through AWS Systems Manager (SSM)
#   - The server's IAM role gives pods S3 access: no AWS access keys inside the cluster
#   - Amazon ECR repositories with immutable tags (every image = one Git commit) and vulnerability scans
#   - GitHub Actions deploys with short-lived OIDC credentials: no AWS keys stored in GitHub
#   - A private S3 bucket holding each release's manifests
#
#   cd infra\cluster
#   terraform init
#   terraform plan  -var "github_repo=<user>/nordwind" -var "documents_bucket=<bucket from infra\terraform>"
#   terraform apply -var ...   (same vars)
#
# Cost: mainly the server: c7i-flex.large in eu-north-1 is ~$0.09/hour (~$66/month if it never stops),
# plus ~$6/month for the disk and public IP. Stop it whenever you're not using it (compute billing stops):
#   aws ec2 stop-instances --instance-ids <id> --profile nordwind

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = "nordwind", ManagedBy = "terraform", Stack = "cluster" }
  }
}

variable "region" {
  type    = string
  default = "eu-north-1" # your project's only allowed Region
}

variable "github_repo" {
  description = "GitHub repository allowed to deploy, as owner/name (e.g. sanju/nordwind)."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repo))
    error_message = "Use the form owner/name, e.g. sanju/nordwind."
  }
}

variable "documents_bucket" {
  description = "Name of the documents bucket created in infra/terraform (terraform output bucket)."
  type        = string
}

variable "instance_type" {
  # 2 vCPU / 4 GB fits k3s + Nordwind + Prometheus + Grafana. Free-tier eligible, which an AWS
  # Free-plan account requires (t3.medium is not eligible there). Check: aws ec2 describe-instance-types
  # --instance-types <type> --query "InstanceTypes[].FreeTierEligible"
  description = "EC2 instance type for the k3s server."
  type        = string
  default     = "c7i-flex.large"
}

variable "volume_size_gb" {
  type    = number
  default = 30
}

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  registry   = "${local.account_id}.dkr.ecr.${var.region}.amazonaws.com"
  repos      = ["nordwind-api", "nordwind-web"]
  burstable  = startswith(var.instance_type, "t")
}

resource "random_id" "suffix" {
  byte_length = 4
}

# ---------------------------------------------------------------------------
# Container registry
# ---------------------------------------------------------------------------
resource "aws_ecr_repository" "app" {
  for_each             = toset(local.repos)
  name                 = each.key
  image_tag_mutability = "IMMUTABLE" # a tag (= commit SHA) can never be overwritten (case study O2)
  force_delete         = true        # lets "terraform destroy" remove repos that still hold images
  image_scanning_configuration {
    scan_on_push = true # known-vulnerability scan of every pushed image
  }
  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  for_each   = aws_ecr_repository.app
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the 20 most recent images (enough to roll back), delete older ones"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 20 }
      action       = { type = "expire" }
    }]
  })
}

# ---------------------------------------------------------------------------
# Release bucket: GitHub Actions uploads rendered manifests here; the server downloads them.
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "deploy" {
  bucket        = "nordwind-deploy-${random_id.suffix.hex}"
  force_destroy = true # only release artifacts: safe to delete with the stack
}

resource "aws_s3_bucket_public_access_block" "deploy" {
  bucket                  = aws_s3_bucket.deploy.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "deploy" {
  bucket = aws_s3_bucket.deploy.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "deploy" {
  bucket = aws_s3_bucket.deploy.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "deploy" {
  bucket = aws_s3_bucket.deploy.id
  rule {
    id     = "expire-old-releases"
    status = "Enabled"
    filter {
      prefix = "releases/"
    }
    expiration {
      days = 30
    }
  }
}

resource "aws_s3_bucket_policy" "deploy" {
  bucket     = aws_s3_bucket.deploy.id
  depends_on = [aws_s3_bucket_public_access_block.deploy]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.deploy.arn, "${aws_s3_bucket.deploy.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# ---------------------------------------------------------------------------
# The server
# ---------------------------------------------------------------------------
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

# Always the latest Amazon Linux 2023 (SSM agent and AWS CLI preinstalled).
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

data "aws_s3_bucket" "documents" {
  bucket = var.documents_bucket
}

# No ingress rules at all: nothing on the internet can connect to this server.
# Outbound is open: k3s install, image pulls, Neon, AI providers, S3, SSM.
resource "aws_security_group" "node" {
  name        = "nordwind-k3s-${random_id.suffix.hex}"
  description = "Nordwind k3s node: no inbound access (SSM only), all outbound"
  vpc_id      = data.aws_vpc.default.id

  egress {
    description = "All outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_iam_role" "node" {
  name = "nordwind-k3s-node-${random_id.suffix.hex}"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore" # Session Manager + Run Command
}

resource "aws_iam_role_policy_attachment" "ecr_read" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# What the app (and only what the app) needs. Pods reach these credentials through the instance metadata
# service. Trade-off of a single-node k3s: every pod could use this role. On EKS you'd give each pod its
# own role instead (IRSA / EKS Pod Identity).
resource "aws_iam_role_policy" "node_app" {
  name = "nordwind-app"
  role = aws_iam_role.node.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "DocumentsReadWriteDelete"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${data.aws_s3_bucket.documents.arn}/workspaces/*"
      },
      {
        Sid      = "ReadReleases"
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.deploy.arn}/releases/*"
      },
      {
        Sid       = "ListReleases"
        Effect    = "Allow"
        Action    = ["s3:ListBucket"]
        Resource  = aws_s3_bucket.deploy.arn
        Condition = { StringLike = { "s3:prefix" = ["releases/*"] } }
      },
      {
        Sid      = "ReadAppConfig"
        Effect   = "Allow"
        Action   = ["ssm:GetParametersByPath", "ssm:GetParameters", "ssm:GetParameter"]
        Resource = "arn:aws:ssm:${var.region}:${local.account_id}:parameter/nordwind/*"
      },
    ]
  })
}

resource "aws_iam_instance_profile" "node" {
  name = "nordwind-k3s-node-${random_id.suffix.hex}"
  role = aws_iam_role.node.name
}

resource "aws_instance" "node" {
  ami                         = data.aws_ssm_parameter.al2023.insecure_value
  instance_type               = var.instance_type
  subnet_id                   = data.aws_subnets.default.ids[0]
  vpc_security_group_ids      = [aws_security_group.node.id]
  iam_instance_profile        = aws_iam_instance_profile.node.name
  associate_public_ip_address = true # outbound internet without a NAT gateway (~$35/month saved)

  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    registry = local.registry
    region   = var.region
  })
  user_data_replace_on_change = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required" # IMDSv2 only (protects against SSRF credential theft)
    http_put_response_hop_limit = 2          # one extra hop so containers can get the node role's credentials
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.volume_size_gb
    encrypted             = true
    delete_on_termination = true
  }

  # "standard": when the CPU credit balance runs out, the server slows down instead of costing extra.
  dynamic "credit_specification" {
    for_each = local.burstable ? [1] : []
    content {
      cpu_credits = "standard"
    }
  }

  tags = { Name = "nordwind-k3s" }

  lifecycle {
    ignore_changes = [ami] # a newer Amazon Linux image shouldn't replace a running server
  }
}

# ---------------------------------------------------------------------------
# GitHub Actions -> AWS without stored keys (OIDC)
# ---------------------------------------------------------------------------
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1", "1c58a3a8518e8759bf075b76b750d4f2df264fcd"]
}

# Only workflows running on the main branch of YOUR repository can assume this role.
resource "aws_iam_role" "deploy" {
  name                 = "nordwind-github-deploy-${random_id.suffix.hex}"
  max_session_duration = 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:ref:refs/heads/main"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "deploy" {
  name = "nordwind-deploy"
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrLogin"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "EcrPush"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
        ]
        Resource = [for r in aws_ecr_repository.app : r.arn]
      },
      {
        Sid      = "UploadRelease"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.deploy.arn}/releases/*"
      },
      {
        Sid    = "RunDeployOnTheServer"
        Effect = "Allow"
        Action = ["ssm:SendCommand"]
        Resource = [
          aws_instance.node.arn,
          "arn:aws:ssm:${var.region}::document/AWS-RunShellScript",
        ]
      },
      {
        Sid      = "ReadDeployResult"
        Effect   = "Allow"
        Action   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations"]
        Resource = "*"
      },
    ]
  })
}

# ---------------------------------------------------------------------------
# Outputs: paste these into GitHub (Settings > Secrets and variables > Actions > Variables)
# ---------------------------------------------------------------------------
output "github_variables" {
  description = "Repository variables for .github/workflows/ci.yml"
  value = {
    AWS_REGION          = var.region
    AWS_DEPLOY_ROLE_ARN = aws_iam_role.deploy.arn
    ECR_REGISTRY        = local.registry
    DEPLOY_BUCKET       = aws_s3_bucket.deploy.bucket
    INSTANCE_ID         = aws_instance.node.id
  }
}

output "instance_id" {
  value = aws_instance.node.id
}

output "open_app_tunnel" {
  description = "Run on your PC (needs the Session Manager plugin), then open http://localhost:8080"
  value       = "aws ssm start-session --profile nordwind --region ${var.region} --target ${aws_instance.node.id} --document-name AWS-StartPortForwardingSession --parameters portNumber=80,localPortNumber=8080"
}

output "shell_on_server" {
  value = "aws ssm start-session --profile nordwind --region ${var.region} --target ${aws_instance.node.id}"
}
