# ---------------------------------------------------------------- logs and roles

resource "aws_cloudwatch_log_group" "this" {
  for_each          = toset(["indexer", "api", "metrics", "apigateway"])
  name              = "/${var.name}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.this.arn
  tags              = local.tags
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Pulls the image and reads the secrets the tasks start with.
resource "aws_iam_role" "execution" {
  name_prefix        = "${var.name}-exec-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution" {
  statement {
    actions   = ["ssm:GetParameters"]
    resources = concat([for p in aws_ssm_parameter.rpc : p.arn], aws_ssm_parameter.api_keys[*].arn)
  }
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.db_secret]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.this.arn]
  }
}

resource "aws_iam_role_policy" "execution" {
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# What the running tasks may do: the cache bucket, and metrics into CloudWatch.
resource "aws_iam_role" "task" {
  name_prefix        = "${var.name}-task-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
  tags               = local.tags
}

data "aws_iam_policy_document" "task" {
  statement {
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.cache.arn}/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.cache.arn]
  }
  statement {
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.this.arn]
  }
  statement {
    sid       = "MetricsAsEmbeddedLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.this["metrics"].arn}:*"]
  }
}

resource "aws_iam_role_policy" "task" {
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

# ---------------------------------------------------------------- tasks

locals {
  environment = concat(
    [
      { name = "PGHOST", value = aws_db_instance.this.address },
      { name = "PGPORT", value = tostring(aws_db_instance.this.port) },
      { name = "PGDATABASE", value = "tidemark" },
      { name = "PGSSLMODE", value = "require" },
      { name = "TIDEMARK_LOG_FORMAT", value = "json" },
      { name = "HOST", value = "0.0.0.0" },
    ],
    [for k, v in var.environment : { name = k, value = v }],
  )
  secrets = concat(
    [
      { name = "PGUSER", valueFrom = "${local.db_secret}:username::" },
      { name = "PGPASSWORD", valueFrom = "${local.db_secret}:password::" },
    ],
    [for k, p in aws_ssm_parameter.rpc : { name = k, valueFrom = p.arn }],
    [for p in aws_ssm_parameter.api_keys : { name = "TIDEMARK_API_KEY_HASHES", valueFrom = p.arn }],
  )
  # The OpenTelemetry collector scrapes /metrics next door and writes CloudWatch metrics (EMF).
  otel_config = { for role, port in { indexer = local.metrics, api = local.api_port } : role => yamlencode({
    receivers = {
      prometheus = {
        config = {
          scrape_configs = [{
            job_name        = "tidemark-${role}"
            scrape_interval = "30s"
            static_configs  = [{ targets = ["127.0.0.1:${port}"] }]
          }]
        }
      }
    }
    exporters = {
      awsemf = {
        namespace               = "Tidemark/${var.name}"
        log_group_name          = aws_cloudwatch_log_group.this["metrics"].name
        dimension_rollup_option = "NoDimensionRollup"
        metric_declarations = [
          { dimensions = [["chain"]], metric_name_selectors = ["^tm_realtime_lag_blocks$", "^tm_processed_block$", "^tm_head_block$", "^tm_finalized_block$", "^tm_reorgs_total$"] },
          { dimensions = [["live", "status"]], metric_name_selectors = ["^tm_outbox_deliveries$"] },
          { dimensions = [[]], metric_name_selectors = ["^tm_live_queries$", "^tm_sql_rejected_total$"] },
        ]
      }
    }
    service = { pipelines = { metrics = { receivers = ["prometheus"], exporters = ["awsemf"] } } }
  }) }
  otel_container = { for role in ["indexer", "api"] : role => {
    name        = "otel"
    image       = var.otel_collector_image
    essential   = false
    environment = [{ name = "AOT_CONFIG_CONTENT", value = local.otel_config[role] }]
    logConfiguration = {
      logDriver = "awslogs"
      options   = { awslogs-group = aws_cloudwatch_log_group.this[role].name, awslogs-region = local.region, awslogs-stream-prefix = "otel" }
    }
  } }
}

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
  tags = local.tags
}

resource "aws_ecs_task_definition" "indexer" {
  family                   = "${var.name}-indexer"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.indexer_cpu
  memory                   = var.indexer_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([
    {
      name         = "indexer"
      image        = local.image
      essential    = true
      command      = ["start", "--metrics-port", tostring(local.metrics)]
      environment  = local.environment
      secrets      = local.secrets
      portMappings = [{ containerPort = local.metrics, protocol = "tcp" }]
      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:${local.metrics}/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
      logConfiguration = {
        logDriver = "awslogs"
        options   = { awslogs-group = aws_cloudwatch_log_group.this["indexer"].name, awslogs-region = local.region, awslogs-stream-prefix = "indexer" }
      }
    },
    local.otel_container["indexer"],
  ])
  tags = local.tags
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([
    {
      name         = "api"
      image        = local.image
      essential    = true
      command      = ["serve", "--port", tostring(local.api_port)]
      environment  = concat(local.environment, [{ name = "TIDEMARK_PUBLIC_METRICS", value = "true" }])
      secrets      = local.secrets
      portMappings = [{ containerPort = local.api_port, protocol = "tcp" }]
      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:${local.api_port}/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
      logConfiguration = {
        logDriver = "awslogs"
        options   = { awslogs-group = aws_cloudwatch_log_group.this["api"].name, awslogs-region = local.region, awslogs-stream-prefix = "api" }
      }
    },
    local.otel_container["api"],
  ])
  tags = local.tags
}

# ---------------------------------------------------------------- services

resource "aws_ecs_service" "indexer" {
  name            = "${var.name}-indexer"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.indexer.arn
  # A second task waits on the build's advisory lock, as a hot standby.
  desired_count                      = var.indexer_standby ? 2 : 1
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  propagate_tags                     = "SERVICE"
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  # The deploy workflow registers new revisions and points the service at them.
  lifecycle {
    ignore_changes = [task_definition]
  }
  tags = local.tags
}

resource "aws_service_discovery_private_dns_namespace" "this" {
  name = "${var.name}.internal"
  vpc  = aws_vpc.this.id
  tags = local.tags
}

resource "aws_service_discovery_service" "api" {
  name = "api"
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.this.id
    routing_policy = "MULTIVALUE"
    dns_records {
      ttl  = 10
      type = "SRV"
    }
  }
  health_check_custom_config {}
  tags = local.tags
}

resource "aws_ecs_service" "api" {
  name                               = "${var.name}-api"
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.api.arn
  desired_count                      = var.api_min_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  propagate_tags                     = "SERVICE"
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true
  }
  service_registries {
    registry_arn   = aws_service_discovery_service.api.arn
    container_name = "api"
    container_port = local.api_port
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
  tags = local.tags
}

resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_min_count
  max_capacity       = var.api_max_count
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${var.name}-api-cpu"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  policy_type        = "TargetTrackingScaling"
  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# ---------------------------------------------------------------- ingress: API Gateway, no load balancer

resource "aws_apigatewayv2_api" "this" {
  name          = var.name
  protocol_type = "HTTP"
  description   = "Tidemark API (GraphQL, SQL, live queries by long-poll)"
  tags          = local.tags
}

resource "aws_apigatewayv2_vpc_link" "this" {
  name               = var.name
  subnet_ids         = aws_subnet.public[*].id
  security_group_ids = [aws_security_group.vpc_link.id]
  tags               = local.tags
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  connection_type        = "VPC_LINK"
  connection_id          = aws_apigatewayv2_vpc_link.this.id
  integration_uri        = aws_service_discovery_service.api.arn
  payload_format_version = "1.0"
  timeout_milliseconds   = 30000
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_rate_limit  = var.api_rate_limit
    throttling_burst_limit = var.api_burst_limit
  }
  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.this["apigateway"].arn
    format = jsonencode({
      requestId          = "$context.requestId", ip = "$context.identity.sourceIp", method = "$context.httpMethod",
      path               = "$context.path", status = "$context.status", latency = "$context.responseLatency",
      integrationLatency = "$context.integrationLatency", bytes = "$context.responseLength"
    })
  }
  tags = local.tags
}
