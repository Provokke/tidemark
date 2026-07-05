import type { Abi, AbiEvent, AbiParameter } from "viem";
import { toEventSignature } from "viem";

/** A file to write, relative to the project root. */
export interface ProjectFile {
  readonly path: string;
  readonly content: string;
}

export interface ContractInput {
  /** Contract name in the config, e.g. `Token`. */
  readonly name: string;
  readonly abi: Abi;
  readonly address: `0x${string}`;
  readonly startBlock: number;
}

export interface ProjectInput {
  readonly name: string;
  readonly chain: { readonly name: string; readonly id: number; readonly rpcEnv: string };
  readonly contracts: readonly ContractInput[];
  /** Version range for the @tidemark packages. */
  readonly tidemarkVersion: string;
}

type ColumnKind = "hex" | "bigint" | "integer" | "boolean" | "text" | "json";

interface Column {
  readonly key: string;
  readonly kind: ColumnKind;
  /** Expression for the value, from `event`. */
  readonly value: string;
}

interface EventTable {
  readonly contract: string;
  readonly handlerKey: string;
  readonly table: string;
  readonly variable: string;
  readonly columns: readonly Column[];
}

const DYNAMIC = /^(string|bytes|tuple.*|.*\[\d*\])$/;
const RESERVED = new Set(["id", "blockNumber", "timestamp", "transactionHash", "logIndex", "logAddress"]);
const JS_RESERVED = new Set([
  "default",
  "class",
  "function",
  "delete",
  "new",
  "this",
  "return",
  "var",
  "let",
  "const",
]);

const camel = (s: string) =>
  s
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ?? "").toUpperCase())
    .replace(/^[A-Z]/, (c) => c.toLowerCase());
const snake = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase();

/** How a decoded event argument is stored. */
export function columnKind(param: AbiParameter, indexed: boolean): ColumnKind {
  const type = param.type;
  // Indexed dynamic values are only their keccak hash in the log.
  if (indexed && DYNAMIC.test(type)) return "hex";
  if (type.endsWith("]") || type.startsWith("tuple")) return "json";
  if (type === "address" || type.startsWith("bytes")) return "hex";
  if (type === "bool") return "boolean";
  if (type === "string") return "text";
  const int = /^(u?)int(\d*)$/.exec(type);
  if (int !== null) {
    const bits = Number(int[2] === "" ? 256 : int[2]);
    // Postgres integer is int4: uint up to 16 bits and int up to 32 fit.
    return (int[1] === "u" && bits <= 16) || (int[1] === "" && bits <= 32) ? "integer" : "bigint";
  }
  return "json";
}

function eventTables(
  contract: ContractInput,
  used: Set<string>,
): { tables: EventTable[]; skipped: string[] } {
  const events = contract.abi.filter((item): item is AbiEvent => item.type === "event");
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  const tables: EventTable[] = [];
  const skipped: string[] = [];
  for (const event of events) {
    if (event.anonymous === true) {
      skipped.push(`${contract.name}:${event.name} (anonymous events have no signature to filter on)`);
      continue;
    }
    const overloaded = (counts.get(event.name) ?? 0) > 1;
    const signature = toEventSignature(event);
    const handlerKey = `${contract.name}:${overloaded ? signature : event.name}`;
    let base = snake(`${contract.name}_${event.name}`);
    if (overloaded)
      base += `_${snake(event.inputs.map((i) => i.type.replace(/[^A-Za-z0-9]/g, "")).join("_")) || "0"}`;
    let table = base;
    for (let n = 2; used.has(table); n++) table = `${base}_${n}`;
    used.add(table);

    const columns: Column[] = [
      { key: "id", kind: "text", value: "`${event.transaction.hash}-${event.log.logIndex}`" },
    ];
    const keys = new Set(columns.map((c) => c.key));
    event.inputs.forEach((input, i) => {
      const argName = input.name === undefined || input.name === "" ? undefined : input.name;
      let key = camel(argName ?? `arg${i}`);
      if (key === "" || RESERVED.has(key) || JS_RESERVED.has(key)) key = `${key || "arg"}_`;
      while (keys.has(key)) key = `${key}_`;
      keys.add(key);
      const kind = columnKind(input, input.indexed === true);
      const access = argName === undefined ? `event.args[${i}]` : `event.args.${argName}`;
      columns.push({ key, kind, value: kind === "json" ? `toJson(${access})` : access });
    });
    columns.push(
      { key: "logAddress", kind: "hex", value: "event.log.address" },
      { key: "blockNumber", kind: "bigint", value: "event.block.number" },
      { key: "timestamp", kind: "bigint", value: "event.block.timestamp" },
      { key: "transactionHash", kind: "hex", value: "event.transaction.hash" },
    );
    tables.push({ contract: contract.name, handlerKey, table, variable: camel(table), columns });
  }
  return { tables, skipped };
}

const columnBuilder: Record<ColumnKind, string> = {
  hex: "t.hex()",
  bigint: "t.bigint()",
  integer: "t.integer()",
  boolean: "t.boolean()",
  text: "t.text()",
  json: "t.json()",
};

function abiModule(contract: ContractInput): string {
  return `// The ABI of ${contract.name}, as fetched. \`as const\` keeps the literal types handlers are typed from.\nexport const ${camel(contract.name)}Abi = ${JSON.stringify(contract.abi, null, 2)} as const;\n`;
}

/** Every file of a project that indexes every event of the given contracts into one table each. */
export function generateProject(input: ProjectInput): { files: ProjectFile[]; skipped: string[] } {
  const used = new Set<string>();
  const all = input.contracts.map((c) => eventTables(c, used));
  const tables = all.flatMap((x) => x.tables);
  const skipped = all.flatMap((x) => x.skipped);

  const config = `import { defineConfig } from "@tidemark/engine";
${input.contracts.map((c) => `import { ${camel(c.name)}Abi } from "./abis/${c.name}";`).join("\n")}

export default defineConfig({
  chains: {
    ${input.chain.name}: {
      id: ${input.chain.id},
      // Several URLs fail over in order: rpc: [primary, backup].
      rpc: process.env.${input.chain.rpcEnv} ?? "",
      finality: "tag",
    },
  },
  contracts: {
${input.contracts
  .map(
    (c) => `    ${c.name}: {
      chain: "${input.chain.name}",
      abi: ${camel(c.name)}Abi,
      address: "${c.address}",
      startBlock: ${c.startBlock},
    },`,
  )
  .join("\n")}
  },
});
`;

  const schema = `import { onchainTable, t } from "@tidemark/schema";
${tables
  .map(
    (tb) => `
/** ${tb.handlerKey} */
export const ${tb.variable} = onchainTable("${tb.table}", {
${tb.columns.map((c) => `  ${c.key}: ${columnBuilder[c.kind]}${c.key === "id" ? ".primaryKey()" : c.kind === "json" || c.kind === "text" ? "" : ".notNull()"},`).join("\n")}
});
`,
  )
  .join("")}`;

  const usesJson = tables.some((tb) => tb.columns.some((c) => c.kind === "json"));
  const handlers = `import { tidemark } from "tidemark:registry";
import {${tables.map((tb) => ` ${tb.variable}`).join(",")} } from "../tidemark.schema";
${
  usesJson
    ? `
/** Arrays and tuples are stored as JSON; JSON has no bigint, so big numbers become strings. */
const toJson = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v)));
`
    : ""
}${tables
    .map(
      (tb) => `
tidemark.on("${tb.handlerKey}", async ({ event, context }) => {
  await context.db.insert(${tb.variable}).values({
${tb.columns.map((c) => `    ${c.key}: ${c.value},`).join("\n")}
  });
});
`,
    )
    .join("")}`;

  const files: ProjectFile[] = [
    { path: "tidemark.config.ts", content: config },
    { path: "tidemark.schema.ts", content: tables.length === 0 ? `export {};\n` : schema },
    { path: "src/index.ts", content: tables.length === 0 ? `import "tidemark:registry";\n` : handlers },
    ...input.contracts.map((c) => ({ path: `abis/${c.name}.ts`, content: abiModule(c) })),
    ...commonFiles(input),
  ];
  return { files, skipped };
}

function commonFiles(input: ProjectInput): ProjectFile[] {
  const v = input.tidemarkVersion;
  return [
    {
      path: "package.json",
      content: `${JSON.stringify(
        {
          name: input.name,
          private: true,
          type: "module",
          scripts: {
            dev: "tidemark dev",
            start: "tidemark start --serve",
            serve: "tidemark serve",
            codegen: "tidemark codegen",
            typecheck: "tidemark codegen && tsc --noEmit",
          },
          dependencies: {
            "@tidemark/cli": v,
            "@tidemark/engine": v,
            "@tidemark/schema": v,
          },
          devDependencies: { "@tidemark/testing": v, "@types/node": "^24.0.0", typescript: "^6.0.3" },
        },
        null,
        2,
      )}\n`,
    },
    {
      path: "tsconfig.json",
      content: `${JSON.stringify(
        {
          compilerOptions: {
            target: "es2024",
            module: "preserve",
            moduleResolution: "bundler",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            verbatimModuleSyntax: true,
            types: ["node"],
          },
          include: ["**/*.ts"],
          exclude: ["node_modules", ".tidemark"],
        },
        null,
        2,
      )}\n`,
    },
    {
      path: ".env.example",
      content: `# Copy to .env.local and fill in.\n${input.chain.rpcEnv}=https://...\nDATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres\n`,
    },
    { path: ".gitignore", content: "node_modules/\n.tidemark/\n.env.local\ntidemark-env.d.ts\ngenerated/\n" },
    {
      path: "Dockerfile",
      content: `# The project on the tidemark image: what Compose, Helm and the AWS module run.
FROM ghcr.io/provokke/tidemark:${input.tidemarkVersion.replace(/^\^/, "")}
COPY --chown=node:node . /opt/tidemark/project
# A project with dependencies beyond @tidemark/* installs them next to it.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --ignore-scripts; fi
# Fail the image build, not the deployment, if the project does not bundle.
RUN tidemark build
`,
    },
    { path: ".dockerignore", content: "node_modules\n.tidemark\n.env\n.env.local\ngenerated\n" },
    {
      path: "README.md",
      content: `# ${input.name}

A [Tidemark](https://github.com/Provokke/tidemark) project.

\`\`\`bash
cp .env.example .env.local   # then set ${input.chain.rpcEnv} and DATABASE_URL
pnpm install
pnpm dev                     # indexes, serves the API on http://127.0.0.1:42069, reloads on save
\`\`\`

- \`tidemark.config.ts\`: chains and contracts.
- \`tidemark.schema.ts\`: tables. Each becomes a GraphQL type and a SQL table.
- \`src/index.ts\`: handlers. \`tidemark\` from \`tidemark:registry\` is typed from the config;
  run \`pnpm codegen\` once so your editor knows it.
`,
    },
  ];
}

/** The ERC-20 template: balances, transfers and allowances of one token. */
export function erc20Template(
  input: Omit<ProjectInput, "contracts"> & { address: `0x${string}`; startBlock: number },
): ProjectFile[] {
  const abi = `export const erc20Abi = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Approval",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "spender", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;
`;
  const config = `import { defineConfig } from "@tidemark/engine";
import { erc20Abi } from "./abis/ERC20";

export default defineConfig({
  chains: {
    ${input.chain.name}: { id: ${input.chain.id}, rpc: process.env.${input.chain.rpcEnv} ?? "", finality: "tag" },
  },
  contracts: {
    Token: {
      chain: "${input.chain.name}",
      abi: erc20Abi,
      address: (process.env.TOKEN_ADDRESS ?? "${input.address}") as \`0x\${string}\`,
      startBlock: ${input.startBlock},
    },
  },
});
`;
  const schema = `import { index, onchainTable, relations, t } from "@tidemark/schema";

export const account = onchainTable("account", {
  id: t.hex().primaryKey(),
  balance: t.bigint().notNull(),
  transfersIn: t.integer().notNull(),
  transfersOut: t.integer().notNull(),
});

export const transfer = onchainTable(
  "transfer",
  {
    id: t.text().primaryKey(),
    from: t.hex().notNull(),
    to: t.hex().notNull(),
    value: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    timestamp: t.timestamp().notNull(),
  },
  (tr) => ({ byFrom: index().on(tr.from), byTo: index().on(tr.to) }),
);

export const allowance = onchainTable(
  "allowance",
  {
    id: t.text().primaryKey(),
    owner: t.hex().notNull(),
    spender: t.hex().notNull(),
    value: t.bigint().notNull(),
  },
  (a) => ({ byOwner: index().on(a.owner) }),
);

export const accountRelations = relations(account, ({ many }) => ({
  sent: many(transfer, { fields: ["id"], references: ["from"] }),
  received: many(transfer, { fields: ["id"], references: ["to"] }),
}));
`;
  const handlers = `import { tidemark } from "tidemark:registry";
import { account, allowance, transfer } from "../tidemark.schema";

const ZERO = "0x0000000000000000000000000000000000000000";

tidemark.on("Token:Transfer", async ({ event, context }) => {
  const { from, to, value } = event.args;
  await context.db.insert(transfer).values({
    id: \`\${event.transaction.hash}-\${event.log.logIndex}\`,
    from,
    to,
    value,
    blockNumber: event.block.number,
    timestamp: event.block.timestamp,
  });
  if (from !== ZERO) {
    await context.db
      .insert(account)
      .values({ id: from, balance: -value, transfersIn: 0, transfersOut: 1 })
      .onConflictDoUpdate((row) => ({ balance: row.balance - value, transfersOut: row.transfersOut + 1 }));
  }
  await context.db
    .insert(account)
    .values({ id: to, balance: value, transfersIn: 1, transfersOut: 0 })
    .onConflictDoUpdate((row) => ({ balance: row.balance + value, transfersIn: row.transfersIn + 1 }));
});

tidemark.on("Token:Approval", async ({ event, context }) => {
  const { owner, spender, value } = event.args;
  await context.db
    .insert(allowance)
    .values({ id: \`\${owner}-\${spender}\`, owner, spender, value })
    .onConflictDoUpdate(() => ({ value }));
});
`;
  return [
    { path: "abis/ERC20.ts", content: abi },
    { path: "tidemark.config.ts", content: config },
    { path: "tidemark.schema.ts", content: schema },
    { path: "src/index.ts", content: handlers },
    ...commonFiles({ ...input, contracts: [] }),
  ];
}
