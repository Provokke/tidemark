import { type Interval, type LogFilter, fromPgMultirange, toPgMultirange } from "@tidemark/core";
import { type Sql, advisoryKey, bytesToHex, hexToBytes, migrate } from "@tidemark/pg";
import type { Hex, RpcBlockHeader, RpcLog, RpcReceipt, RpcTrace, RpcTransaction } from "@tidemark/rpc";
import { type FactoryLogSourceSpec, type TraceSourceSpec, factoryHash } from "./sources.js";
import { syncMigrations } from "./migrations.js";

/** Cached data disagrees with what the chain returned for a finalised block. */
export class InconsistentChainDataError extends Error {
  override name = "InconsistentChainDataError";
}

/** A cached log joined with its block, as the engine reads it. */
export interface CachedLog extends RpcLog {
  readonly blockTimestamp: number;
}

const INSERT_CHUNK = 2_000;

interface LogRow {
  chain_id: number;
  block_number: number;
  log_index: number;
  block_hash: Buffer;
  transaction_hash: Buffer;
  transaction_index: number;
  address: Buffer;
  topic0: Buffer | null;
  topic1: Buffer | null;
  topic2: Buffer | null;
  topic3: Buffer | null;
  data: Buffer;
}

function topic(log: RpcLog, i: number): Buffer | null {
  const t = log.topics[i];
  return t === undefined ? null : hexToBytes(t);
}

/** The `tm_sync` schema: cached finalised logs and blocks, and which intervals each filter has. */
export class SyncStore {
  readonly sql: Sql;
  readonly #chains = new Set<number>();

  constructor(sql: Sql) {
    this.sql = sql;
  }

  async migrate(): Promise<string[]> {
    return migrate(this.sql, "sync", syncMigrations);
  }

  /** Creates the chain's partitions if they do not exist yet. */
  async ensureChain(chainId: number): Promise<void> {
    if (this.#chains.has(chainId)) return;
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new RangeError(`not a chain id: ${chainId}`);
    await this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${advisoryKey(`sync-partition:${chainId}`)})`;
      // chainId is a checked integer, so interpolating it into the DDL is safe.
      await tx.unsafe(`
        create table if not exists tm_sync.logs_c${chainId} partition of tm_sync.logs for values in (${chainId});
        create table if not exists tm_sync.blocks_c${chainId} partition of tm_sync.blocks for values in (${chainId});
        create table if not exists tm_sync.traces_c${chainId} partition of tm_sync.traces for values in (${chainId});
      `);
    });
    this.#chains.add(chainId);
  }

  async cachedIntervals(chainId: number, filterHash: string): Promise<Interval[]> {
    const [row] = await this.sql<{ blocks: string }[]>`
      select blocks::text as blocks from tm_sync.intervals
      where chain_id = ${chainId} and filter_hash = ${filterHash}
    `;
    return row === undefined ? [] : fromPgMultirange(row.blocks);
  }

  /** Which of these block numbers have no cached header. */
  async missingHeaders(chainId: number, numbers: readonly number[]): Promise<number[]> {
    if (numbers.length === 0) return [];
    const rows = await this.sql<{ number: bigint }[]>`
      select number from tm_sync.blocks
      where chain_id = ${chainId} and number = any(${numbers.map(String)}::bigint[])
    `;
    const have = new Set(rows.map((r) => Number(r.number)));
    return numbers.filter((n) => !have.has(n));
  }

  /**
   * Stores one fetched range in a single transaction: its logs, the headers of their blocks, and
   * the range added to the filter's cached intervals. A crash leaves either all of it or none, so
   * an interval is never marked cached without its data.
   *
   * Logs another filter already cached are kept (the primary key is the log's position). A header
   * whose hash differs from the cached one for the same finalised block is refused.
   */
  async commitRange(args: {
    filter: LogFilter;
    filterHash: string;
    fromBlock: number;
    toBlock: number;
    logs: readonly RpcLog[];
    headers: readonly RpcBlockHeader[];
  }): Promise<void> {
    await this.commitSourceRange({
      chainId: args.filter.chainId,
      sourceHash: args.filterHash,
      spec: args.filter,
      fromBlock: args.fromBlock,
      toBlock: args.toBlock,
      logs: args.logs,
      headers: args.headers,
    });
  }

  /**
   * The general form of `commitRange` for every source kind: logs, headers and traces for a block
   * range, and the range added to the source's cached intervals, in one transaction.
   */
  async commitSourceRange(args: {
    chainId: number;
    sourceHash: string;
    spec: unknown;
    fromBlock: number;
    toBlock: number;
    logs?: readonly RpcLog[];
    headers?: readonly RpcBlockHeader[];
    traces?: readonly RpcTrace[];
  }): Promise<void> {
    const { chainId, sourceHash: filterHash, fromBlock, toBlock } = args;
    const logs = args.logs ?? [];
    const headers = args.headers ?? [];
    const traces = args.traces ?? [];
    const filter = args.spec as never;
    await this.ensureChain(chainId);

    await this.sql.begin(async (tx) => {
      for (let i = 0; i < logs.length; i += INSERT_CHUNK) {
        const rows: LogRow[] = logs.slice(i, i + INSERT_CHUNK).map((log) => ({
          chain_id: chainId,
          block_number: log.blockNumber,
          log_index: log.logIndex,
          block_hash: hexToBytes(log.blockHash),
          transaction_hash: hexToBytes(log.transactionHash),
          transaction_index: log.transactionIndex,
          address: hexToBytes(log.address),
          topic0: topic(log, 0),
          topic1: topic(log, 1),
          topic2: topic(log, 2),
          topic3: topic(log, 3),
          data: hexToBytes(log.data),
        }));
        await tx`insert into tm_sync.logs ${tx(rows)} on conflict do nothing`;
      }

      for (let i = 0; i < headers.length; i += INSERT_CHUNK) {
        const rows = headers.slice(i, i + INSERT_CHUNK).map((h) => ({
          chain_id: chainId,
          number: h.number,
          hash: hexToBytes(h.hash),
          parent_hash: hexToBytes(h.parentHash),
          timestamp: h.timestamp,
          logs_bloom: hexToBytes(h.logsBloom),
        }));
        await tx`insert into tm_sync.blocks ${tx(rows)} on conflict do nothing`;
        // Read back what is stored: a header another writer cached first must have the same hash.
        // The insert waited for any conflicting writer to commit, so the read sees its row.
        const stored = await tx<{ number: bigint; hash: Buffer }[]>`
          select number, hash from tm_sync.blocks
          where chain_id = ${chainId} and number = any(${rows.map((r) => String(r.number))}::bigint[])
        `;
        const expected = new Map(rows.map((r) => [String(r.number), r.hash]));
        const conflicts = stored.filter(
          (row) => !row.hash.equals(expected.get(String(row.number)) ?? Buffer.alloc(0)),
        );
        if (conflicts.length > 0) {
          throw new InconsistentChainDataError(
            `chain ${chainId}: block ${conflicts[0]?.number} has a different hash than the cached finalised block`,
          );
        }
      }

      for (let i = 0; i < traces.length; i += INSERT_CHUNK) {
        const rows = traceRows(chainId, traces.slice(i, i + INSERT_CHUNK));
        await tx`insert into tm_sync.traces ${tx(rows)} on conflict do nothing`;
      }

      const range = toPgMultirange([[fromBlock, toBlock]]);
      await tx`
        insert into tm_sync.intervals (chain_id, filter_hash, filter, blocks)
        values (${chainId}, ${filterHash}, ${tx.json(filter)}, ${range}::int8multirange)
        on conflict (chain_id, filter_hash) do update
          set blocks = tm_sync.intervals.blocks + excluded.blocks, updated_at = now()
      `;
    });
  }

  /** Records factory children; a child seen twice keeps its earliest announcement. */
  async addFactoryChildren(
    chainId: number,
    hash: string,
    children: readonly { address: Hex; createdBlock: number }[],
  ): Promise<void> {
    for (let i = 0; i < children.length; i += INSERT_CHUNK) {
      const rows = children.slice(i, i + INSERT_CHUNK).map((c) => ({
        chain_id: chainId,
        factory_hash: hash,
        address: hexToBytes(c.address),
        created_block: c.createdBlock,
      }));
      await this.sql`
        insert into tm_sync.factory_children ${this.sql(rows)}
        on conflict (chain_id, factory_hash, address) do update
          set created_block = least(tm_sync.factory_children.created_block, excluded.created_block)
      `;
    }
  }

  /** A factory's children announced at or below `throughBlock`, by lowercase address. */
  async factoryChildren(
    chainId: number,
    hash: string,
    throughBlock = Number.MAX_SAFE_INTEGER,
  ): Promise<Map<string, number>> {
    const rows = await this.sql<{ address: Buffer; created_block: bigint }[]>`
      select address, created_block from tm_sync.factory_children
      where chain_id = ${chainId} and factory_hash = ${hash} and created_block <= ${throughBlock}
    `;
    return new Map(rows.map((r) => [bytesToHex(r.address), Number(r.created_block)]));
  }

  /** Cached logs of a factory source: from its children, at or after each child's announcement. */
  async readFactoryLogs(
    source: FactoryLogSourceSpec,
    fromBlock: number,
    toBlock: number,
  ): Promise<CachedLog[]> {
    const sql = this.sql;
    const chainId = source.factory.chainId;
    const conditions = [
      sql`l.chain_id = ${chainId}`,
      sql`l.block_number between ${fromBlock} and ${toBlock}`,
    ];
    source.topics.forEach((allowed, i) => {
      if (allowed !== null) {
        conditions.push(
          sql`${sql.unsafe(`l.topic${i}`)} = any(${allowed.map((h) => hexToBytes(h))}::bytea[])`,
        );
      }
    });
    const where = conditions.reduce((acc, c) => sql`${acc} and ${c}`);
    const rows = await sql<(Omit<LogRow, "block_number"> & { block_number: bigint; timestamp: bigint })[]>`
      select l.*, b.timestamp
      from tm_sync.logs l
      join tm_sync.factory_children c
        on c.chain_id = l.chain_id and c.factory_hash = ${factoryHash(source.factory)}
       and c.address = l.address and c.created_block <= l.block_number
      join tm_sync.blocks b on b.chain_id = l.chain_id and b.number = l.block_number
      where ${where}
      order by l.block_number, l.log_index
    `;
    return rows.map(toCachedLog);
  }

  /** Cached headers for these block numbers, in order; missing ones are left out. */
  async readBlocks(chainId: number, numbers: readonly number[]): Promise<RpcBlockHeader[]> {
    if (numbers.length === 0) return [];
    const rows = await this.sql<
      { number: bigint; hash: Buffer; parent_hash: Buffer; timestamp: bigint; logs_bloom: Buffer | null }[]
    >`
      select number, hash, parent_hash, timestamp, logs_bloom from tm_sync.blocks
      where chain_id = ${chainId} and number = any(${numbers.map(String)}::bigint[]) order by number
    `;
    return rows.map((r) => ({
      number: Number(r.number),
      hash: bytesToHex(r.hash),
      parentHash: bytesToHex(r.parent_hash),
      timestamp: Number(r.timestamp),
      logsBloom: r.logs_bloom === null ? "0x" : bytesToHex(r.logs_bloom),
    }));
  }

  /** Cached traces of a trace source in a block range, with block timestamps, in chain order. */
  async readTraces(
    source: TraceSourceSpec,
    fromBlock: number,
    toBlock: number,
  ): Promise<(RpcTrace & { blockTimestamp: number })[]> {
    const rows = await this.sql<(TraceRow & { timestamp: bigint })[]>`
      select t.*, b.timestamp from tm_sync.traces t
      join tm_sync.blocks b on b.chain_id = t.chain_id and b.number = t.block_number
      where t.chain_id = ${source.chainId} and t.block_number between ${fromBlock} and ${toBlock}
        and t."to" = any(${source.to.map((a) => hexToBytes(a))}::bytea[])
      order by t.block_number, t.transaction_index, t.trace_address
    `;
    return rows
      .map((r) => ({ ...fromTraceRow(r), blockTimestamp: Number(r.timestamp) }))
      .filter((t) => source.selectors === null || source.selectors.includes(t.input.slice(0, 10) as Hex));
  }

  async getTransactions(
    chainId: number,
    hashes: readonly Hex[],
  ): Promise<Map<string, { transaction: RpcTransaction; receipt: RpcReceipt }>> {
    if (hashes.length === 0) return new Map();
    const bytes = hashes.map((h) => hexToBytes(h));
    const rows = await this.sql<Record<string, unknown>[]>`
      select t.*, r.status, r.gas_used, r.cumulative_gas_used, r.effective_gas_price, r.contract_address
      from tm_sync.transactions t join tm_sync.receipts r on r.chain_id = t.chain_id and r.transaction_hash = t.hash
      where t.chain_id = ${chainId} and t.hash = any(${bytes}::bytea[])
    `;
    const big = (v: unknown) => (v === null ? null : BigInt(v as string));
    return new Map(
      rows.map((r) => {
        const hash = bytesToHex(r.hash as Buffer);
        const blockHash = bytesToHex(r.block_hash as Buffer);
        const blockNumber = Number(r.block_number as bigint);
        return [
          hash,
          {
            transaction: {
              hash,
              blockNumber,
              blockHash,
              transactionIndex: r.transaction_index as number,
              from: bytesToHex(r.from as Buffer),
              to: r.to === null ? null : bytesToHex(r.to as Buffer),
              value: BigInt(r.value as string),
              input: bytesToHex(r.input as Buffer),
              nonce: Number(r.nonce as bigint),
              gas: BigInt(r.gas as string),
              gasPrice: big(r.gas_price),
              maxFeePerGas: big(r.max_fee_per_gas),
              maxPriorityFeePerGas: big(r.max_priority_fee_per_gas),
              type: r.type as string,
            },
            receipt: {
              transactionHash: hash,
              blockNumber,
              blockHash,
              status: r.status as "success" | "reverted",
              gasUsed: BigInt(r.gas_used as string),
              cumulativeGasUsed: BigInt(r.cumulative_gas_used as string),
              effectiveGasPrice: big(r.effective_gas_price),
              contractAddress: r.contract_address === null ? null : bytesToHex(r.contract_address as Buffer),
            },
          },
        ];
      }),
    );
  }

  /** Caches transactions and receipts. Only for finalised blocks: the cache is never invalidated. */
  async putTransactions(
    chainId: number,
    items: readonly { transaction: RpcTransaction; receipt: RpcReceipt }[],
  ): Promise<void> {
    if (items.length === 0) return;
    const opt = (v: bigint | null) => (v === null ? null : v.toString());
    await this.sql.begin(async (tx) => {
      for (let i = 0; i < items.length; i += INSERT_CHUNK) {
        const chunk = items.slice(i, i + INSERT_CHUNK);
        await tx`insert into tm_sync.transactions ${tx(
          chunk.map(({ transaction: t }) => ({
            chain_id: chainId,
            hash: hexToBytes(t.hash),
            block_number: t.blockNumber,
            block_hash: hexToBytes(t.blockHash),
            transaction_index: t.transactionIndex,
            from: hexToBytes(t.from),
            to: t.to === null ? null : hexToBytes(t.to),
            value: t.value.toString(),
            input: hexToBytes(t.input),
            nonce: t.nonce,
            gas: t.gas.toString(),
            gas_price: opt(t.gasPrice),
            max_fee_per_gas: opt(t.maxFeePerGas),
            max_priority_fee_per_gas: opt(t.maxPriorityFeePerGas),
            type: t.type,
          })),
        )} on conflict do nothing`;
        await tx`insert into tm_sync.receipts ${tx(
          chunk.map(({ receipt: r }) => ({
            chain_id: chainId,
            transaction_hash: hexToBytes(r.transactionHash),
            block_number: r.blockNumber,
            block_hash: hexToBytes(r.blockHash),
            status: r.status,
            gas_used: r.gasUsed.toString(),
            cumulative_gas_used: r.cumulativeGasUsed.toString(),
            effective_gas_price: opt(r.effectiveGasPrice),
            contract_address: r.contractAddress === null ? null : hexToBytes(r.contractAddress),
          })),
        )} on conflict do nothing`;
      }
    });
  }

  async getCachedRead(chainId: number, block: number, requestHash: string): Promise<unknown> {
    const [row] = await this.sql<{ result: unknown }[]>`
      select result from tm_sync.rpc_cache where chain_id = ${chainId} and block_number = ${block} and request_hash = ${requestHash}
    `;
    return row?.result;
  }

  async putCachedRead(chainId: number, block: number, requestHash: string, result: unknown): Promise<void> {
    await this.sql`
      insert into tm_sync.rpc_cache (chain_id, block_number, request_hash, result)
      values (${chainId}, ${block}, ${requestHash}, ${this.sql.json(result as never)}) on conflict do nothing
    `;
  }

  /**
   * Cached logs matching `filter` in a block range, with their block timestamps, in chain order.
   * Only meaningful over intervals the filter has cached.
   */
  async readLogs(filter: LogFilter, fromBlock: number, toBlock: number): Promise<CachedLog[]> {
    const sql = this.sql;
    const bytes = (list: readonly Hex[]) => sql`${list.map((h) => hexToBytes(h))}::bytea[]`;
    const conditions = [
      sql`l.chain_id = ${filter.chainId}`,
      sql`l.block_number between ${fromBlock} and ${toBlock}`,
    ];
    if (filter.address !== null) conditions.push(sql`l.address = any(${bytes(filter.address)})`);
    filter.topics.forEach((allowed, i) => {
      if (allowed !== null) conditions.push(sql`${sql.unsafe(`l.topic${i}`)} = any(${bytes(allowed)})`);
    });
    const where = conditions.reduce((acc, c) => sql`${acc} and ${c}`);

    const rows = await sql<(Omit<LogRow, "block_number"> & { block_number: bigint; timestamp: bigint })[]>`
      select l.*, b.timestamp
      from tm_sync.logs l
      join tm_sync.blocks b on b.chain_id = l.chain_id and b.number = l.block_number
      where ${where}
      order by l.block_number, l.log_index
    `;
    return rows.map(toCachedLog);
  }
}

function toCachedLog(
  r: Omit<LogRow, "block_number"> & { block_number: bigint; timestamp: bigint },
): CachedLog {
  return {
    blockNumber: Number(r.block_number),
    blockHash: bytesToHex(r.block_hash),
    transactionHash: bytesToHex(r.transaction_hash),
    transactionIndex: r.transaction_index,
    logIndex: r.log_index,
    address: bytesToHex(r.address),
    topics: [r.topic0, r.topic1, r.topic2, r.topic3].filter((t): t is Buffer => t !== null).map(bytesToHex),
    data: bytesToHex(r.data),
    blockTimestamp: Number(r.timestamp),
  };
}

interface TraceRow {
  chain_id: number;
  block_number: number | bigint;
  transaction_index: number;
  block_hash: Buffer;
  transaction_hash: Buffer;
  trace_address: number[];
  call_type: string;
  from: Buffer;
  to: Buffer;
  input: Buffer;
  output: Buffer | null;
  value: string;
  gas_used: string | null;
}

function traceRows(chainId: number, traces: readonly RpcTrace[]): TraceRow[] {
  return traces.map((t) => ({
    chain_id: chainId,
    block_number: t.blockNumber,
    transaction_index: t.transactionIndex,
    block_hash: hexToBytes(t.blockHash),
    transaction_hash: hexToBytes(t.transactionHash),
    trace_address: [...t.traceAddress],
    call_type: t.callType,
    from: hexToBytes(t.from),
    to: hexToBytes(t.to),
    input: hexToBytes(t.input),
    output: t.output === null ? null : hexToBytes(t.output),
    value: t.value.toString(),
    gas_used: t.gasUsed === null ? null : t.gasUsed.toString(),
  }));
}

function fromTraceRow(r: TraceRow): RpcTrace {
  return {
    blockNumber: Number(r.block_number),
    blockHash: bytesToHex(r.block_hash),
    transactionHash: bytesToHex(r.transaction_hash),
    transactionIndex: r.transaction_index,
    traceAddress: r.trace_address,
    type: "call",
    callType: r.call_type,
    from: bytesToHex(r.from),
    to: bytesToHex(r.to),
    input: bytesToHex(r.input),
    output: r.output === null ? null : bytesToHex(r.output),
    value: BigInt(r.value),
    gasUsed: r.gas_used === null ? null : BigInt(r.gas_used),
    error: null,
  };
}
