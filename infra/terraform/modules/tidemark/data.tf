# ---------------------------------------------------------------- database

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
  tags       = local.tags
}

resource "aws_db_parameter_group" "this" {
  name   = "${var.name}-pg17"
  family = "postgres17"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
  tags = local.tags
}

resource "aws_db_instance" "this" {
  identifier            = var.name
  engine                = "postgres"
  engine_version        = var.db_engine_version
  instance_class        = var.db_instance_class
  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.this.arn
  db_name               = "tidemark"
  username              = "tidemark"
  # RDS keeps the password in Secrets Manager, encrypted with our key, and rotates it.
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.this.key_id
  db_subnet_group_name          = aws_db_subnet_group.this.name
  vpc_security_group_ids        = [aws_security_group.db.id]
  parameter_group_name          = aws_db_parameter_group.this.name
  multi_az                      = var.db_multi_az
  publicly_accessible           = false
  backup_retention_period       = 7
  copy_tags_to_snapshot         = true
  deletion_protection           = var.deletion_protection
  skip_final_snapshot           = !var.deletion_protection
  final_snapshot_identifier     = var.deletion_protection ? "${var.name}-final" : null
  auto_minor_version_upgrade    = true
  tags                          = local.tags
}

# ---------------------------------------------------------------- secrets

resource "aws_ssm_parameter" "rpc" {
  for_each = nonsensitive(toset(keys(var.rpc_urls)))
  name     = "/${var.name}/${each.key}"
  type     = "SecureString"
  key_id   = aws_kms_key.this.arn
  value    = var.rpc_urls[each.key]
  tags     = local.tags
}

resource "aws_ssm_parameter" "api_keys" {
  count  = nonsensitive(var.api_key_hashes == "") ? 0 : 1
  name   = "/${var.name}/TIDEMARK_API_KEY_HASHES"
  type   = "SecureString"
  key_id = aws_kms_key.this.arn
  value  = var.api_key_hashes
  tags   = local.tags
}

# ---------------------------------------------------------------- images and the cache bucket

resource "aws_ecr_repository" "this" {
  name                 = var.name
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.this.arn
  }
  tags = local.tags
}

resource "aws_ecr_lifecycle_policy" "this" {
  repository = aws_ecr_repository.this.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 30 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}

# Sync cache exports (`tidemark cache export s3://...`): a new deployment seeds from one.
resource "aws_s3_bucket" "cache" {
  bucket_prefix = "${var.name}-cache-"
  force_destroy = !var.deletion_protection
  tags          = local.tags
}

resource "aws_s3_bucket_public_access_block" "cache" {
  bucket                  = aws_s3_bucket.cache.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "cache" {
  bucket = aws_s3_bucket.cache.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cache" {
  bucket = aws_s3_bucket.cache.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.this.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "cache" {
  bucket = aws_s3_bucket.cache.id
  rule {
    id     = "age"
    status = "Enabled"
    filter {}
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "cache_bucket" {
  statement {
    sid       = "TlsOnly"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.cache.arn, "${aws_s3_bucket.cache.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "cache" {
  bucket = aws_s3_bucket.cache.id
  policy = data.aws_iam_policy_document.cache_bucket.json
}
