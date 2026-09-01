variable "name" {
  description = "Prefix for every resource name."
  type        = string
  default     = "tidemark"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.name))
    error_message = "name must be 2-31 lowercase letters, digits and dashes, starting with a letter."
  }
}

variable "image_tag" {
  description = "Tag of the project image in this module's ECR repository (the project built FROM the tidemark image)."
  type        = string
}

variable "rpc_urls" {
  description = "Environment variable name to RPC URL, as the project's config reads them (e.g. { BASE_RPC_URL = \"https://...\" }). Stored as SSM SecureStrings."
  type        = map(string)
  sensitive   = true
}

variable "chain_names" {
  description = "The project's chain names, for per-chain lag alarms."
  type        = list(string)
  default     = []
}

variable "environment" {
  description = "Extra plain environment variables for both services."
  type        = map(string)
  default     = {}
}

variable "api_key_hashes" {
  description = "Comma-separated SHA-256 hex digests of accepted API keys. Empty leaves the API open."
  type        = string
  default     = ""
  sensitive   = true
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.small"
}

variable "db_engine_version" {
  type    = string
  default = "17"
}

variable "db_allocated_storage" {
  description = "GiB."
  type        = number
  default     = 50
}

variable "db_max_allocated_storage" {
  description = "GiB, for storage autoscaling."
  type        = number
  default     = 500
}

variable "db_multi_az" {
  type    = bool
  default = false
}

variable "deletion_protection" {
  description = "Protect the database and keep a final snapshot; also keeps the cache bucket on destroy."
  type        = bool
  default     = true
}

variable "indexer_cpu" {
  type    = number
  default = 512
}

variable "indexer_memory" {
  type    = number
  default = 1024
}

variable "indexer_standby" {
  description = "Run a second indexer task that waits on the build lock and takes over if the first stops."
  type        = bool
  default     = false
}

variable "api_cpu" {
  type    = number
  default = 256
}

variable "api_memory" {
  type    = number
  default = 512
}

variable "api_min_count" {
  type    = number
  default = 1
}

variable "api_max_count" {
  type    = number
  default = 4
}

variable "api_rate_limit" {
  description = "API Gateway steady-state requests per second."
  type        = number
  default     = 200
}

variable "api_burst_limit" {
  type    = number
  default = 400
}

variable "alarm_email" {
  description = "Email for alarm notifications; empty for none (subscribe to the SNS topic yourself)."
  type        = string
  default     = ""
}

variable "realtime_lag_threshold" {
  description = "Blocks behind the head before the lag alarm fires."
  type        = number
  default     = 10
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "github_repository" {
  description = "owner/repo allowed to deploy through GitHub OIDC; empty for no deploy role."
  type        = string
  default     = ""
}

variable "github_deploy_ref" {
  description = "The git ref allowed to deploy."
  type        = string
  default     = "refs/heads/main"
}

variable "create_github_oidc_provider" {
  description = "Create the account's GitHub OIDC provider (only one can exist per account)."
  type        = bool
  default     = true
}

variable "otel_collector_image" {
  type    = string
  default = "public.ecr.aws/aws-observability/aws-otel-collector:v0.43.3"
}

variable "tags" {
  type    = map(string)
  default = {}
}
