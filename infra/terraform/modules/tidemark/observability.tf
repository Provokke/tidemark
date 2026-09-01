# ---------------------------------------------------------------- alarms

resource "aws_sns_topic" "alarms" {
  name              = "${var.name}-alarms"
  kms_master_key_id = aws_kms_key.this.id
  tags              = local.tags
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  namespace = "Tidemark/${var.name}"
  alarm = {
    alarm_actions = [aws_sns_topic.alarms.arn]
    ok_actions    = [aws_sns_topic.alarms.arn]
  }
}

resource "aws_cloudwatch_metric_alarm" "realtime_lag" {
  for_each            = toset(var.chain_names)
  alarm_name          = "${var.name}-lag-${each.key}"
  alarm_description   = "${each.key} is more than ${var.realtime_lag_threshold} blocks behind its head"
  namespace           = local.namespace
  metric_name         = "tm_realtime_lag_blocks"
  dimensions          = { chain = each.key }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = var.realtime_lag_threshold
  comparison_operator = "GreaterThanThreshold"
  # No data means the indexer is not reporting: the running-task alarm covers that.
  treat_missing_data = "notBreaching"
  alarm_actions      = local.alarm.alarm_actions
  ok_actions         = local.alarm.ok_actions
  tags               = local.tags
}

resource "aws_cloudwatch_metric_alarm" "indexer_down" {
  alarm_name          = "${var.name}-indexer-not-running"
  alarm_description   = "No indexer task is running (crash loop, halted build, image pull failure)"
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  dimensions          = { ClusterName = aws_ecs_cluster.this.name, ServiceName = aws_ecs_service.indexer.name }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm.alarm_actions
  ok_actions          = local.alarm.ok_actions
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "outbox_dead" {
  alarm_name          = "${var.name}-outbox-dead-letters"
  alarm_description   = "Outbox deliveries are dead; see `tidemark outbox list --status dead`"
  namespace           = local.namespace
  metric_name         = "tm_outbox_deliveries"
  dimensions          = { live = "live", status = "dead" }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm.alarm_actions
  ok_actions          = local.alarm.ok_actions
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "${var.name}-api-5xx"
  alarm_description   = "The API answers with server errors"
  namespace           = "AWS/ApiGateway"
  metric_name         = "5xx"
  dimensions          = { ApiId = aws_apigatewayv2_api.this.id, Stage = "$default" }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm.alarm_actions
  ok_actions          = local.alarm.ok_actions
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "api_latency" {
  alarm_name          = "${var.name}-api-latency-p95"
  alarm_description   = "API p95 latency is over 1 s (the published target is 150 ms for key and indexed queries)"
  namespace           = "AWS/ApiGateway"
  metric_name         = "Latency"
  dimensions          = { ApiId = aws_apigatewayv2_api.this.id, Stage = "$default" }
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 2
  threshold           = 1000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm.alarm_actions
  ok_actions          = local.alarm.ok_actions
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "${var.name}-db-cpu"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.this.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = local.alarm.alarm_actions
  ok_actions          = local.alarm.ok_actions
  tags                = local.tags
}

resource "aws_cloudwatch_metric_alarm" "db_storage" {
  alarm_name          = "${var.name}-db-free-storage"
  alarm_description   = "Under 10% of the maximum storage is free"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.this.identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.db_max_allocated_storage * 1024 * 1024 * 1024 * 0.1
  comparison_operator = "LessThanThreshold"
  alarm_actions       = local.alarm.alarm_actions
  ok_actions          = local.alarm.ok_actions
  tags                = local.tags
}

resource "aws_cloudwatch_dashboard" "this" {
  dashboard_name = var.name
  dashboard_body = jsonencode({
    widgets = [
      {
        type = "metric", x = 0, y = 0, width = 12, height = 6
        properties = {
          title   = "Realtime lag (blocks)"
          region  = local.region
          stat    = "Maximum"
          metrics = [for c in var.chain_names : [local.namespace, "tm_realtime_lag_blocks", "chain", c]]
        }
      },
      {
        type = "metric", x = 12, y = 0, width = 12, height = 6
        properties = {
          title   = "Head and processed block"
          region  = local.region
          stat    = "Maximum"
          metrics = flatten([for c in var.chain_names : [[local.namespace, "tm_head_block", "chain", c], [local.namespace, "tm_processed_block", "chain", c]]])
        }
      },
      {
        type = "metric", x = 0, y = 6, width = 12, height = 6
        properties = {
          title  = "API requests, 5xx and p95 latency"
          region = local.region
          metrics = [
            ["AWS/ApiGateway", "Count", "ApiId", aws_apigatewayv2_api.this.id, "Stage", "$default", { stat = "Sum" }],
            ["AWS/ApiGateway", "5xx", "ApiId", aws_apigatewayv2_api.this.id, "Stage", "$default", { stat = "Sum" }],
            ["AWS/ApiGateway", "Latency", "ApiId", aws_apigatewayv2_api.this.id, "Stage", "$default", { stat = "p95", yAxis = "right" }],
          ]
        }
      },
      {
        type = "metric", x = 12, y = 6, width = 12, height = 6
        properties = {
          title  = "Database"
          region = local.region
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", aws_db_instance.this.identifier, { stat = "Average" }],
            ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", aws_db_instance.this.identifier, { stat = "Maximum", yAxis = "right" }],
          ]
        }
      },
    ]
  })
}
