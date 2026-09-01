/**
 * Checks for the deployment files that need no cloud: they parse, they reference only metrics
 * the code really exports, images and actions are pinned, and versions agree.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const yaml = (path: string) => parse(read(path), { merge: true }) as Record<string, unknown>;

function walk(dir: string, filter: (path: string) => boolean): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "dist" || name === ".terraform") return [];
    return statSync(join(root, path)).isDirectory() ? walk(path, filter) : filter(path) ? [path] : [];
  });
}

/** Every metric name the packages register, with the series a histogram adds. */
function exportedMetrics(): Set<string> {
  const names = new Set<string>();
  for (const file of walk("packages", (p) => /\/src\/.*\.ts$/.test(p))) {
    for (const m of read(file).matchAll(/metrics\.(counter|gauge|histogram)\(\s*"(tm_[a-z0-9_]+)"/g)) {
      const [, kind, name] = m as unknown as [string, string, string];
      names.add(name);
      if (kind === "histogram")
        for (const suffix of ["_bucket", "_sum", "_count"]) names.add(`${name}${suffix}`);
    }
  }
  return names;
}

const metricRefs = (text: string) => new Set([...text.matchAll(/\btm_[a-z0-9_]+\b/g)].map((m) => m[0]));

describe("monitoring files", () => {
  const exported = exportedMetrics();

  it("finds the metrics the code exports", () => {
    for (const name of [
      "tm_events_total",
      "tm_realtime_lag_blocks",
      "tm_api_requests_total",
      "tm_outbox_deliveries",
      "tm_rpc_requests_total",
    ]) {
      expect(exported).toContain(name);
    }
  });

  it("alerts, dashboards and alarms use only metrics that exist", () => {
    const sources = {
      "prometheus alerts": read("infra/compose/prometheus/alerts.yml"),
      "grafana dashboard": read("infra/compose/grafana/dashboards/tidemark.json"),
      terraform: walk("infra/terraform", (p) => p.endsWith(".tf"))
        .map(read)
        .join("\n")
        .replace(/"\^(tm_[a-z0-9_]+)\$"/g, '"$1"'),
    };
    for (const [where, text] of Object.entries(sources)) {
      const unknown = [...metricRefs(text)].filter(
        (name) => !exported.has(name) && !name.startsWith("tm_build_"),
      );
      expect({ where, unknown }).toEqual({ where, unknown: [] });
    }
  });

  it("alert rules are complete", () => {
    const rules = (
      yaml("infra/compose/prometheus/alerts.yml").groups as { rules: Record<string, unknown>[] }[]
    ).flatMap((g) => g.rules);
    expect(rules.length).toBeGreaterThanOrEqual(8);
    for (const rule of rules) {
      expect(rule).toMatchObject({
        alert: expect.any(String),
        expr: expect.any(String),
        labels: { severity: expect.stringMatching(/^(critical|warning)$/) },
      });
      expect((rule.annotations as { summary?: string }).summary).toBeTruthy();
    }
  });

  it("the dashboard is well-formed and uses the provisioned data source", () => {
    const dashboard = JSON.parse(read("infra/compose/grafana/dashboards/tidemark.json")) as {
      panels: { id: number; datasource?: { uid: string }; targets?: { expr: string }[] }[];
    };
    const ids = dashboard.panels.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const uid = (
      yaml("infra/compose/grafana/provisioning/datasources/prometheus.yml").datasources as { uid: string }[]
    )[0]?.uid;
    for (const panel of dashboard.panels.filter((p) => p.targets !== undefined))
      expect(panel.datasource?.uid).toBe(uid);
  });
});

describe("compose", () => {
  const compose = yaml("infra/compose/docker-compose.yml") as {
    services: Record<string, { image?: string; command?: string[] }>;
  };

  it("has the stack, with pinned images", () => {
    expect(Object.keys(compose.services).sort()).toEqual([
      "api",
      "grafana",
      "indexer",
      "migrate",
      "postgres",
      "prometheus",
    ]);
    for (const [name, service] of Object.entries(compose.services)) {
      expect({ name, image: service.image }).toEqual({
        name,
        image: expect.stringMatching(/:[^:]*\d[^:]*$/),
      });
      expect(service.image).not.toMatch(/:latest$/);
    }
  });

  it("scrapes the ports the services serve metrics on", () => {
    const targets = (
      yaml("infra/compose/prometheus/prometheus.yml").scrape_configs as {
        static_configs: { targets: string[] }[];
      }[]
    ).flatMap((s) => s.static_configs.flatMap((c) => c.targets));
    expect(targets).toEqual(["indexer:9464", "api:42069"]);
    expect(compose.services.indexer?.command).toEqual(["start", "--metrics-port", "9464"]);
    expect(compose.services.api?.command).toEqual(["serve", "--port", "42069"]);
  });
});

describe("supply chain", () => {
  it("pins every GitHub Action to a commit, with the version alongside", () => {
    for (const file of walk(".github/workflows", (p) => p.endsWith(".yml"))) {
      const text = read(file);
      yaml(file); // parses
      for (const m of text.matchAll(/uses:\s*(\S+)(.*)$/gm)) {
        const [, ref, rest] = m as unknown as [string, string, string];
        if (ref.startsWith("./")) continue;
        expect({ file, ref }).toEqual({ file, ref: expect.stringMatching(/@[0-9a-f]{40}$/) });
        expect({ file, ref, comment: rest.trim() }).toEqual({
          file,
          ref,
          comment: expect.stringMatching(/^# v\d+/),
        });
      }
    }
  });

  it("builds the image as a non-root user on a pinned base", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toMatch(/^ARG NODE_IMAGE=node:\d+\.\d+\.\d+-/m);
    expect(dockerfile).toMatch(/^USER node$/m);
  });

  it("keeps the chart, the image and the packages on one version", () => {
    const chart = yaml("infra/helm/tidemark/Chart.yaml") as { version: string; appVersion: string };
    const values = yaml("infra/helm/tidemark/values.yaml") as { image: { tag: string } };
    const cli = JSON.parse(read("packages/cli/package.json")) as { version: string };
    expect([chart.version, chart.appVersion, values.image.tag]).toEqual([
      cli.version,
      cli.version,
      cli.version,
    ]);
    expect(read("infra/compose/docker-compose.yml")).toContain(`ghcr.io/provokke/tidemark:${cli.version}`);
  });
});
