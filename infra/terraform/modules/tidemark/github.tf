# ---------------------------------------------------------------- deploys from GitHub Actions (OIDC)

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.github_repository != "" && var.create_github_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  tags           = local.tags
}

locals {
  github_provider_arn = var.create_github_oidc_provider ? one(aws_iam_openid_connect_provider.github[*].arn) : "arn:${local.partition}:iam::${local.account}:oidc-provider/token.actions.githubusercontent.com"
}

data "aws_iam_policy_document" "github_assume" {
  count = var.github_repository == "" ? 0 : 1
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:${var.github_deploy_ref}"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  count              = var.github_repository == "" ? 0 : 1
  name_prefix        = "${var.name}-deploy-"
  assume_role_policy = data.aws_iam_policy_document.github_assume[0].json
  tags               = local.tags
}

data "aws_iam_policy_document" "deploy" {
  count = var.github_repository == "" ? 0 : 1
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:InitiateLayerUpload",
      "ecr:PutImage", "ecr:UploadLayerPart", "ecr:DescribeImages",
    ]
    resources = [aws_ecr_repository.this.arn]
  }
  statement {
    actions   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
    resources = ["*"]
  }
  statement {
    actions = ["ecs:RunTask", "ecs:DescribeTasks", "ecs:UpdateService", "ecs:DescribeServices"]
    resources = [
      "arn:${local.partition}:ecs:${local.region}:${local.account}:task-definition/${var.name}-*",
      "arn:${local.partition}:ecs:${local.region}:${local.account}:task/${var.name}/*",
      aws_ecs_service.indexer.id,
      aws_ecs_service.api.id,
    ]
  }
  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
  }
  statement {
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.this.arn]
  }
  statement {
    actions   = ["logs:GetLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this["indexer"].arn}:*"]
  }
}

resource "aws_iam_role_policy" "deploy" {
  count  = var.github_repository == "" ? 0 : 1
  role   = aws_iam_role.deploy[0].id
  policy = data.aws_iam_policy_document.deploy[0].json
}
