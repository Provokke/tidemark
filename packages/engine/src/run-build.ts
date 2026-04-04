import {
  acquireBuildLock,
  buildSchemaName,
  computeBuildId,
  cutover,
  handlerCode,
  liveState,
  registerBuild,
  setBuildStatus,
} from "./builds.js";
import { type IndexerOptions, type RunResult, runIndexer } from "./indexer.js";

export interface RunBuildOptions extends Omit<IndexerOptions, "indexSchema" | "onReady"> {
  /** The handler code that goes into the build id: the CLI's bundle. Defaults to the handlers' source. */
  readonly code?: string;
  /** The live schema the API serves. */
  readonly live?: string;
  /**
   * When to point the live schema at this build: once it is ready (`"when-ready"`), only if the live
   * schema has no build yet (`"if-none"`, the default), or never (deploy it later with `cutover`).
   */
  readonly promote?: "when-ready" | "if-none" | "never";
  /** Told the build id as soon as it is known, and when the build becomes ready. */
  readonly onBuild?: (event: {
    readonly buildId: string;
    readonly status: "indexing" | "ready" | "active";
  }) => void;
}

export interface BuildResult extends RunResult {
  readonly buildId: string;
}

/**
 * Indexes one build of a project: registers it, takes its lock (waiting, as a hot standby, while
 * another process runs the same build), indexes into the build's own schema, marks it ready when it
 * has caught up, and points the live schema at it if asked. A build that fails is marked halted;
 * the live schema keeps serving whatever it served.
 */
export async function runBuild(options: RunBuildOptions): Promise<BuildResult> {
  const { sql } = options;
  const buildId = computeBuildId({
    config: options.tidemark.config,
    schema: options.schema,
    code: options.code ?? handlerCode(options.tidemark.handlers),
  });
  await registerBuild(sql, buildId, options.schema);
  options.onBuild?.({ buildId, status: "indexing" });
  const live = options.live ?? "live";
  const promote = options.promote ?? "if-none";

  const lock = await acquireBuildLock(sql, buildId, {
    wait: true,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (lock === undefined) return { buildId, chains: [] }; // stopped while waiting
  try {
    const result = await runIndexer({
      ...options,
      indexSchema: buildSchemaName(buildId),
      onReady: async () => {
        await setBuildStatus(sql, buildId, "ready");
        options.onBuild?.({ buildId, status: "ready" });
        const state = await liveState(sql, live);
        if (promote === "when-ready" || (promote === "if-none" && state?.activeBuild == null)) {
          await cutover(sql, live, buildId);
          options.onBuild?.({ buildId, status: "active" });
        }
      },
    });
    return { ...result, buildId };
  } catch (error) {
    if (options.signal?.aborted !== true) {
      await setBuildStatus(
        sql,
        buildId,
        "halted",
        error instanceof Error ? error.message : String(error),
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    await lock.release();
  }
}
