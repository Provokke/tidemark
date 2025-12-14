/**
 * A small Prometheus registry: counters, gauges and histograms with labels, and the text exposition
 * format. Every Tidemark package records into the default registry, and `/metrics` serves it.
 */

type Labels = Readonly<Record<string, string | number>>;

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

const escapeLabel = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const escapeHelp = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");

function labelKey(names: readonly string[], labels: Labels): string {
  return names.map((n) => String(labels[n] ?? "")).join("\u0000");
}

function renderLabels(names: readonly string[], values: readonly string[], extra?: [string, string]): string {
  const pairs = names.map((n, i) => `${n}="${escapeLabel(values[i] ?? "")}"`);
  if (extra !== undefined) pairs.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
  return pairs.length === 0 ? "" : `{${pairs.join(",")}}`;
}

const formatNumber = (n: number) =>
  Number.isFinite(n) ? String(n) : n > 0 ? "+Inf" : n < 0 ? "-Inf" : "NaN";

abstract class Metric {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];
  abstract readonly type: "counter" | "gauge" | "histogram";

  constructor(name: string, help: string, labelNames: readonly string[]) {
    if (!NAME.test(name)) throw new Error(`bad metric name ${name}`);
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
  }

  protected check(labels: Labels): void {
    for (const key of Object.keys(labels)) {
      if (!this.labelNames.includes(key)) throw new Error(`${this.name}: unknown label ${key}`);
    }
  }

  abstract render(): string[];
}

export class Counter extends Metric {
  readonly type = "counter";
  readonly #values = new Map<string, { labels: string[]; value: number }>();

  inc(labels: Labels = {}, by = 1): void {
    if (by < 0) throw new Error(`${this.name}: counters only go up`);
    this.check(labels);
    const key = labelKey(this.labelNames, labels);
    const entry = this.#values.get(key) ?? {
      labels: this.labelNames.map((n) => String(labels[n] ?? "")),
      value: 0,
    };
    entry.value += by;
    this.#values.set(key, entry);
  }

  get(labels: Labels = {}): number {
    return this.#values.get(labelKey(this.labelNames, labels))?.value ?? 0;
  }

  /** A handle with the labels resolved once, for hot paths. */
  bind(labels: Labels = {}): { inc(by?: number): void } {
    this.inc(labels, 0);
    const entry = this.#values.get(labelKey(this.labelNames, labels)) as { value: number };
    return {
      inc(by = 1) {
        entry.value += by;
      },
    };
  }

  render(): string[] {
    return [...this.#values.values()].map(
      (e) => `${this.name}${renderLabels(this.labelNames, e.labels)} ${formatNumber(e.value)}`,
    );
  }
}

export class Gauge extends Metric {
  readonly type = "gauge";
  readonly #values = new Map<string, { labels: string[]; value: number }>();

  set(labels: Labels, value: number): void {
    this.check(labels);
    const key = labelKey(this.labelNames, labels);
    this.#values.set(key, { labels: this.labelNames.map((n) => String(labels[n] ?? "")), value });
  }

  inc(labels: Labels = {}, by = 1): void {
    this.set(labels, this.get(labels) + by);
  }

  dec(labels: Labels = {}, by = 1): void {
    this.set(labels, this.get(labels) - by);
  }

  get(labels: Labels = {}): number {
    return this.#values.get(labelKey(this.labelNames, labels))?.value ?? 0;
  }

  render(): string[] {
    return [...this.#values.values()].map(
      (e) => `${this.name}${renderLabels(this.labelNames, e.labels)} ${formatNumber(e.value)}`,
    );
  }
}

export const DEFAULT_BUCKETS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Histogram extends Metric {
  readonly type = "histogram";
  readonly buckets: readonly number[];
  readonly #values = new Map<string, { labels: string[]; counts: number[]; sum: number; count: number }>();

  constructor(
    name: string,
    help: string,
    labelNames: readonly string[],
    buckets: readonly number[] = DEFAULT_BUCKETS,
  ) {
    super(name, help, labelNames);
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: Labels, value: number): void {
    this.check(labels);
    const key = labelKey(this.labelNames, labels);
    let entry = this.#values.get(key);
    if (entry === undefined) {
      entry = {
        labels: this.labelNames.map((n) => String(labels[n] ?? "")),
        counts: this.buckets.map(() => 0),
        sum: 0,
        count: 0,
      };
      this.#values.set(key, entry);
    }
    for (let i = 0; i < this.buckets.length; i++)
      if (value <= (this.buckets[i] as number)) entry.counts[i] = (entry.counts[i] ?? 0) + 1;
    entry.sum += value;
    entry.count++;
  }

  /** A handle with the labels resolved once, for hot paths. */
  bind(labels: Labels = {}): { observe(value: number): void } {
    this.check(labels);
    const key = labelKey(this.labelNames, labels);
    let entry = this.#values.get(key);
    if (entry === undefined) {
      entry = {
        labels: this.labelNames.map((n) => String(labels[n] ?? "")),
        counts: this.buckets.map(() => 0),
        sum: 0,
        count: 0,
      };
      this.#values.set(key, entry);
    }
    const e = entry;
    const buckets = this.buckets;
    return {
      observe(value: number) {
        for (let i = 0; i < buckets.length; i++)
          if (value <= (buckets[i] as number)) e.counts[i] = (e.counts[i] ?? 0) + 1;
        e.sum += value;
        e.count++;
      },
    };
  }

  /** Times `fn` in seconds. */
  async time<T>(labels: Labels, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.observe(labels, (performance.now() - start) / 1000);
    }
  }

  render(): string[] {
    const lines: string[] = [];
    for (const e of this.#values.values()) {
      this.buckets.forEach((le, i) => {
        lines.push(
          `${this.name}_bucket${renderLabels(this.labelNames, e.labels, ["le", formatNumber(le)])} ${e.counts[i] ?? 0}`,
        );
      });
      lines.push(`${this.name}_bucket${renderLabels(this.labelNames, e.labels, ["le", "+Inf"])} ${e.count}`);
      lines.push(`${this.name}_sum${renderLabels(this.labelNames, e.labels)} ${formatNumber(e.sum)}`);
      lines.push(`${this.name}_count${renderLabels(this.labelNames, e.labels)} ${e.count}`);
    }
    return lines;
  }
}

export class Registry {
  readonly #metrics = new Map<string, Metric>();
  readonly #collectors: (() => void | Promise<void>)[] = [];

  #register<M extends Metric>(metric: M): M {
    const existing = this.#metrics.get(metric.name);
    if (existing !== undefined) {
      if (existing.type !== metric.type)
        throw new Error(`metric ${metric.name} exists as a ${existing.type}`);
      return existing as M;
    }
    this.#metrics.set(metric.name, metric);
    return metric;
  }

  counter(name: string, help: string, labelNames: readonly string[] = []): Counter {
    return this.#register(new Counter(name, help, labelNames));
  }

  gauge(name: string, help: string, labelNames: readonly string[] = []): Gauge {
    return this.#register(new Gauge(name, help, labelNames));
  }

  histogram(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    buckets?: readonly number[],
  ): Histogram {
    return this.#register(new Histogram(name, help, labelNames, buckets));
  }

  /** Runs before every scrape: for gauges read from elsewhere (a database count, say). */
  onCollect(fn: () => void | Promise<void>): () => void {
    this.#collectors.push(fn);
    return () => {
      const i = this.#collectors.indexOf(fn);
      if (i >= 0) this.#collectors.splice(i, 1);
    };
  }

  /** The Prometheus text format (version 0.0.4). */
  async render(): Promise<string> {
    await Promise.all(this.#collectors.map(async (fn) => fn()));
    const out: string[] = [];
    for (const metric of [...this.#metrics.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      out.push(
        `# HELP ${metric.name} ${escapeHelp(metric.help)}`,
        `# TYPE ${metric.name} ${metric.type}`,
        ...metric.render(),
      );
    }
    return `${out.join("\n")}\n`;
  }
}

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** The registry every Tidemark package records into. */
export const metrics = new Registry();
