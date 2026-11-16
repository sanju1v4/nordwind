# Nordwind document storage: one private, encrypted S3 bucket in your project Region (eu-north-1) + a least-privilege IAM user
# for local development. Run from this folder:
#   terraform init
#   terraform plan
#   terraform apply
#   terraform output -raw secret_access_key     (copy into E:\Nordwind\.env, never into Git)

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
    tags = { Project = "nordwind", ManagedBy = "terraform" }
  }
}

variable "region" {
  type    = string
  default = "eu-north-1" # Stockholm: your project's Region (new AWS experience allows only this one). EU data residency.
}

variable "allowed_origins" {
  description = "Web app origins allowed to upload directly from the browser (pre-signed PUT)."
  type        = list(string)
  default     = ["http://localhost:5173"]
}

# Bucket names are global across all AWS accounts, so add a random suffix.
resource "random_id" "suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "documents" {
  bucket = "nordwind-documents-${random_id.suffix.hex}"
}

# Case study S4: nothing in this bucket can ever be made public, not even by mistake in code.
resource "aws_s3_bucket_public_access_block" "documents" {
  bucket                  = aws_s3_bucket.documents.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# ACLs switched off entirely: access is decided only by IAM and the bucket policy.
resource "aws_s3_bucket_ownership_controls" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Encryption at rest for every object.
resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Versioning stays OFF on purpose: when a customer deletes a document, it must really be gone (GDPR, case study S13).

# The browser uploads straight to S3 with a pre-signed URL, so S3 must accept PUT from our web origin.
resource "aws_s3_bucket_cors_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = var.allowed_origins
    allowed_headers = ["content-type"]
    max_age_seconds = 3000
  }
}

# Clean up half-finished multipart uploads so they don't cost money forever.
resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id
  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# Refuse any request that doesn't use HTTPS.
resource "aws_s3_bucket_policy" "documents" {
  bucket     = aws_s3_bucket.documents.id
  depends_on = [aws_s3_bucket_public_access_block.documents]
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.documents.arn, "${aws_s3_bucket.documents.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

# ---------- Access for the app (local development) ----------
# Least privilege: read, write and delete objects under workspaces/ in THIS bucket. Nothing else.
# In production on EKS you'd use an IAM role for the pod (IRSA / EKS Pod Identity) instead of access keys.
resource "aws_iam_user" "app_dev" {
  name = "nordwind-app-dev-${random_id.suffix.hex}"
}

resource "aws_iam_user_policy" "app_dev" {
  name = "nordwind-documents-access"
  user = aws_iam_user.app_dev.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
      Resource = "${aws_s3_bucket.documents.arn}/workspaces/*"
    }]
  })
}

resource "aws_iam_access_key" "app_dev" {
  user = aws_iam_user.app_dev.name
}

output "bucket" {
  value = aws_s3_bucket.documents.bucket
}

output "region" {
  value = var.region
}

output "access_key_id" {
  value = aws_iam_access_key.app_dev.id
}

output "secret_access_key" {
  value     = aws_iam_access_key.app_dev.secret
  sensitive = true
}
