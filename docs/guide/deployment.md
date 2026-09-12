# Deployment

A project ships as an image: `FROM ghcr.io/provokke/tidemark:1.0.1`, with the project copied to
`/opt/tidemark/project`. `create-tidemark` writes that Dockerfile. The image runs as `node`, logs JSON,
and its entrypoint is `tidemark`.

## Docker Compose

`infra/compose` runs Postgres 17, a migration job, the indexer, the API, Prometheus (with the alert
rules) and Grafana (with the dashboard) on one machine:

```bash
cd infra/compose
cp .env.example .env    # RPC URLs, passwords
TIDEMARK_PROJECT=/path/to/my-indexer docker compose up -d
```

## AWS

`infra/terraform/modules/tidemark` is a low-fixed-cost deployment with no NAT gateway:

- RDS Postgres 17 (`db.t4g.small`, gp3, KMS, TLS required, managed password);
- two ARM64 Fargate services (indexer, with an optional standby; API, autoscaled), each with an
  OpenTelemetry sidecar that turns `/metrics` into CloudWatch metrics;
- API Gateway (HTTP API) through a VPC link and Cloud Map, so there is no load balancer;
- ECR, an S3 bucket for cache exports, SSM SecureStrings for RPC URLs;
- CloudWatch alarms to SNS (lag per chain, indexer not running, outbox dead letters, API 5xx and
  latency, database CPU and storage) and a dashboard;
- an IAM role for GitHub Actions through OIDC.

```hcl
module "tidemark" {
  source            = "github.com/Provokke/tidemark//infra/terraform/modules/tidemark?ref=v1.0.1"
  name              = "my-indexer"
  image_tag         = "bootstrap"
  rpc_urls          = { BASE_RPC_URL = var.base_rpc_url }
  chain_names       = ["base"]
  alarm_email       = "ops@example.com"
  github_repository = "me/my-indexer"
}
```

`.github/workflows/deploy.yml` deploys:

1. It builds the project image for ARM64 and pushes it to the module's ECR repository.
2. It runs `tidemark deploy --exit-when-live` as a one-off task, which indexes from cache and goes live
   once caught up.
3. It moves both services to the new image.

API Gateway's 30-second limit means live queries use long-poll there.

### What it costs

An estimate from published us-east-1 prices, for a demo with idle chain traffic; measure your own
after the first deploy.

| Item                                                         | Per month   |
| ------------------------------------------------------------ | ----------- |
| RDS `db.t4g.small`, single-AZ, 50 GB gp3, backups            | ~$30        |
| Fargate ARM: indexer 0.5 vCPU / 1 GB, API 0.25 vCPU / 0.5 GB | ~$22        |
| Public IPv4 for two tasks                                    | ~$7         |
| CloudWatch logs (14 days), alarms, custom metrics            | ~$3–6       |
| KMS, Secrets Manager, S3, ECR, API Gateway at demo traffic   | ~$3         |
| **Total**                                                    | **~$65–70** |

Cheaper: `db.t4g.micro` (about −$15), Fargate Spot for the API. Aurora Serverless v2 costs more at idle
but is the path to scale.

## Kubernetes

`infra/helm/tidemark`:

- the indexer is a Deployment with a `Recreate` strategy (a second replica is a standby);
- the API is a Deployment with an HPA;
- a migration Job runs as a pre-install/pre-upgrade hook;
- an optional Ingress and ServiceMonitor;
- pods run as non-root with a read-only root filesystem.

Bring Postgres (CloudNativePG works well) and put its URL in the `tidemark-database` secret.

```bash
helm install indexer infra/helm/tidemark --set image.repository=ghcr.io/me/my-indexer --set image.tag=1.0.1
```
