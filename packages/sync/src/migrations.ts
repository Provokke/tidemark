import type { Migration } from "@tidemark/pg";

/**
 * The shared sync cache. Finalised raw chain data, keyed independently of any build, so a new
 * build whose filters overlap an old one reuses what is cached instead of calling the RPC.
 *
 * `logs` and `blocks` are list-partitioned by chain; `ensureChain` creates each chain's partition.
 * Range sub-partitioning by block, for cheap compaction to S3, would come later.
 */
export const syncMigrations: readonly Migration[] = [
  {
    id: "0001_sync_cache",
    sql: `
      create schema if not exists tm_sync;

      create table tm_sync.intervals (
        chain_id bigint not null,
        filter_hash text not null,
        filter jsonb not null,
        blocks int8multirange not null default '{}',
        updated_at timestamptz not null default now(),
        primary key (chain_id, filter_hash)
      );

      create table tm_sync.logs (
        chain_id bigint not null,
        block_number bigint not null,
        log_index integer not null,
        block_hash bytea not null,
        transaction_hash bytea not null,
        transaction_index integer not null,
        address bytea not null,
        topic0 bytea,
        topic1 bytea,
        topic2 bytea,
        topic3 bytea,
        data bytea not null,
        primary key (chain_id, block_number, log_index)
      ) partition by list (chain_id);

      create index logs_by_address on tm_sync.logs (chain_id, address, topic0, block_number);
      create index logs_by_topic on tm_sync.logs (chain_id, topic0, block_number);

      create table tm_sync.blocks (
        chain_id bigint not null,
        number bigint not null,
        hash bytea not null,
        parent_hash bytea not null,
        timestamp bigint not null,
        logs_bloom bytea,
        primary key (chain_id, number)
      ) partition by list (chain_id);
    `,
  },
  {
    id: "0002_sources",
    sql: `
      -- Children a factory announced, with the block that announced them. A child's logs count
      -- from that block on.
      create table tm_sync.factory_children (
        chain_id bigint not null,
        factory_hash text not null,
        address bytea not null,
        created_block bigint not null,
        primary key (chain_id, factory_hash, address)
      );

      -- Call traces, one row per call. trace_address is the call's position in its transaction's
      -- call tree; sorting by it (arrays compare element by element) gives depth-first order.
      create table tm_sync.traces (
        chain_id bigint not null,
        block_number bigint not null,
        transaction_index integer not null,
        block_hash bytea not null,
        transaction_hash bytea not null,
        trace_address integer[] not null,
        call_type text not null,
        "from" bytea not null,
        "to" bytea not null,
        input bytea not null,
        output bytea,
        value numeric(78,0) not null,
        gas_used numeric(78,0),
        primary key (chain_id, block_number, transaction_index, trace_address)
      ) partition by list (chain_id);
      create index traces_by_to on tm_sync.traces (chain_id, "to", block_number);

      create table tm_sync.transactions (
        chain_id bigint not null,
        hash bytea not null,
        block_number bigint not null,
        block_hash bytea not null,
        transaction_index integer not null,
        "from" bytea not null,
        "to" bytea,
        value numeric(78,0) not null,
        input bytea not null,
        nonce bigint not null,
        gas numeric(78,0) not null,
        gas_price numeric(78,0),
        max_fee_per_gas numeric(78,0),
        max_priority_fee_per_gas numeric(78,0),
        type text not null,
        primary key (chain_id, hash)
      );

      create table tm_sync.receipts (
        chain_id bigint not null,
        transaction_hash bytea not null,
        block_number bigint not null,
        block_hash bytea not null,
        status text not null,
        gas_used numeric(78,0) not null,
        cumulative_gas_used numeric(78,0) not null,
        effective_gas_price numeric(78,0),
        contract_address bytea,
        primary key (chain_id, transaction_hash)
      );

      -- Results of eth_call and friends at finalized blocks, so a re-index reads them without RPC.
      create table tm_sync.rpc_cache (
        chain_id bigint not null,
        block_number bigint not null,
        request_hash text not null,
        result jsonb not null,
        primary key (chain_id, block_number, request_hash)
      );
    `,
  },
];
