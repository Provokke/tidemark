import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AnyHandler, Config } from "@tidemark/engine";
import { type Plugin, build } from "esbuild";

/** Where a project's files are, by convention, relative to its root. */
export interface ProjectPaths {
  readonly root: string;
  readonly config: string;
  readonly schema: string;
  readonly handlers: string;
  /** Bundles, by content hash. */
  readonly outDir: string;
}

export function projectPaths(root: string): ProjectPaths {
  const at = (...candidates: string[]) => {
    const found = candidates.map((c) => join(root, c)).find((p) => existsSync(p));
    return found ?? join(root, candidates[0] as string);
  };
  return {
    root,
    config: at("tidemark.config.ts", "tidemark.config.mts", "tidemark.config.js", "tidemark.config.mjs"),
    schema: at("tidemark.schema.ts", "tidemark.schema.mts", "tidemark.schema.js", "tidemark.schema.mjs"),
    handlers: at("src/index.ts", "src/index.mts", "src/index.js", "src/index.mjs"),
    outDir: join(root, ".tidemark", "build"),
  };
}

export interface LoadedProject {
  readonly paths: ProjectPaths;
  readonly config: Config;
  readonly schema: Record<string, unknown>;
  readonly tidemark: { readonly config: Config; readonly handlers: ReadonlyMap<string, AnyHandler> };
  /** The bundled handler code: what goes into the build id. */
  readonly code: string;
  /** Hash of the bundle. */
  readonly bundleHash: string;
  /** The project files the bundle was built from, for watching. */
  readonly inputs: readonly string[];
}

export class ProjectError extends Error {
  override name = "ProjectError";
}

const REGISTRY = "tidemark:registry";
let loads = 0;
const ENTRY = "tidemark:entry";

/**
 * Bundles a project (config, schema and handlers) with esbuild and imports it.
 *
 * Handlers import `tidemark` from the virtual module `tidemark:registry`, which this provides: it
 * creates the registry from the project's config. Packages stay external (they load from the
 * project's node_modules at run time), so the bundle holds only the project's own code, and its
 * hash, with the engine version, config and schema, is what identifies a build.
 */
export async function loadProject(root: string): Promise<LoadedProject> {
  const paths = projectPaths(resolve(root));
  for (const [what, path] of [
    ["config", paths.config],
    ["schema", paths.schema],
    ["handlers", paths.handlers],
  ] as const) {
    if (!existsSync(path))
      throw new ProjectError(`no ${what} file: expected ${relative(process.cwd(), path)}`);
  }

  const virtual: Plugin = {
    name: "tidemark-virtual",
    setup(b) {
      b.onResolve({ filter: /^tidemark:(registry|entry)$/ }, (args) => ({
        path: args.path,
        namespace: "tidemark",
      }));
      b.onLoad({ filter: /.*/, namespace: "tidemark" }, (args) => {
        const spec = (p: string) => JSON.stringify(p);
        if (args.path === REGISTRY) {
          return {
            resolveDir: paths.root,
            loader: "js",
            contents: [
              `import config from ${spec(paths.config)};`,
              // Not validated here: codegen and build must work without RPC URLs in the environment.
              // The indexer validates the config before it starts.
              `import { createTidemark } from "@tidemark/engine";`,
              `export const tidemark = createTidemark(config);`,
            ].join("\n"),
          };
        }
        return {
          resolveDir: paths.root,
          loader: "js",
          contents: [
            `import config from ${spec(paths.config)};`,
            `import * as schema from ${spec(paths.schema)};`,
            `import { tidemark } from ${spec(REGISTRY)};`,
            `import ${spec(paths.handlers)};`,
            `export { config, schema, tidemark };`,
          ].join("\n"),
        };
      });
    },
  };

  let result;
  try {
    result = await build({
      entryPoints: [ENTRY],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      packages: "external",
      sourcemap: "external",
      sourcesContent: true,
      write: false,
      metafile: true,
      logLevel: "silent",
      absWorkingDir: paths.root,
      outfile: join(paths.outDir, "bundle", "index.mjs"),
      plugins: [virtual],
    });
  } catch (error) {
    const errors = (
      error as {
        errors?: { text: string; location?: { file: string; line: number; column: number } | null }[];
      }
    ).errors;
    if (errors !== undefined) {
      throw new ProjectError(
        errors
          .map((e) =>
            e.location == null
              ? e.text
              : `${e.location.file}:${e.location.line}:${e.location.column}: ${e.text}`,
          )
          .join("\n"),
      );
    }
    throw error;
  }

  const js = result.outputFiles.find((f) => f.path.endsWith(".mjs"));
  const map = result.outputFiles.find((f) => f.path.endsWith(".map"));
  if (js === undefined) throw new ProjectError("esbuild produced no output");
  const code = js.text;
  const bundleHash = createHash("sha256").update(code).digest("hex").slice(0, 16);
  // One directory per bundle, so a reload imports a fresh module rather than the cached one.
  const dir = join(paths.outDir, bundleHash);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "index.mjs"), code);
  if (map !== undefined) await writeFile(join(dir, "index.mjs.map"), map.text);

  // A fresh module instance per load: Node caches modules by URL, and the config must be evaluated
  // against the environment as it is now (a reload after editing .env, or a test that sets it).
  const url = `${pathToFileURL(join(dir, "index.mjs")).href}?load=${++loads}`;
  const mod = (await import(url)) as {
    config: Config;
    schema: Record<string, unknown>;
    tidemark: LoadedProject["tidemark"];
  };
  const inputs = Object.keys(result.metafile.inputs)
    .filter((p) => !p.startsWith("tidemark:"))
    .map((p) => resolve(paths.root, p));
  return {
    paths,
    config: mod.config,
    schema: { ...mod.schema },
    tidemark: mod.tidemark,
    code,
    bundleHash,
    inputs,
  };
}
