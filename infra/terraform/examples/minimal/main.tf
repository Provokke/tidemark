# The smallest real deployment: one chain, alarms by email, deploys from GitHub.
#
#   terraform init && terraform apply -var image_tag=bootstrap -var mainnet_rpc_url=https://... -var alarm_email=you@example.com
#
# then push an image tagged `bootstrap` (or run the deploy workflow) and visit the api_url output.

terraform {
  required_version = ">= 1.9"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "image_tag" {
  type = string
}

variable "mainnet_rpc_url" {
  type      = string
  sensitive = true
}

variable "alarm_email" {
  type    = string
  default = ""
}

variable "github_repository" {
  type    = string
  default = ""
}

module "tidemark" {
  source            = "../../modules/tidemark"
  name              = "erc20-indexer"
  image_tag         = var.image_tag
  rpc_urls          = { MAINNET_RPC_URL = var.mainnet_rpc_url }
  chain_names       = ["mainnet"]
  alarm_email       = var.alarm_email
  github_repository = var.github_repository
  # A demo: let `terraform destroy` remove everything.
  deletion_protection = false
}

output "api_url" {
  value = module.tidemark.api_url
}

output "ecr_repository_url" {
  value = module.tidemark.ecr_repository_url
}

output "deploy_role_arn" {
  value = module.tidemark.deploy_role_arn
}
