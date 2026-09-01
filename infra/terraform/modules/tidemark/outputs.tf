output "api_url" {
  description = "The API's public URL."
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "ecr_repository_url" {
  value = aws_ecr_repository.this.repository_url
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "indexer_service" {
  value = aws_ecs_service.indexer.name
}

output "api_service" {
  value = aws_ecs_service.api.name
}

output "indexer_task_family" {
  value = aws_ecs_task_definition.indexer.family
}

output "api_task_family" {
  value = aws_ecs_task_definition.api.family
}

output "task_subnets" {
  value = aws_subnet.public[*].id
}

output "task_security_group" {
  value = aws_security_group.tasks.id
}

output "db_endpoint" {
  value = aws_db_instance.this.endpoint
}

output "db_secret_arn" {
  description = "Secrets Manager secret with the database username and password."
  value       = local.db_secret
}

output "cache_bucket" {
  value = aws_s3_bucket.cache.bucket
}

output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}

output "deploy_role_arn" {
  description = "For aws-actions/configure-aws-credentials in the deploy workflow."
  value       = one(aws_iam_role.deploy[*].arn)
}
