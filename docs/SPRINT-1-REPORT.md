# Sprint 1 report: live Graph provider and standardized-schema proof

Result: **PASS on the corrected gate** (section "Correction after Codex audit", D18).
Ethereum mandatory gate met on five provider-validated identities; Base kept as secondary with
both configured targets verified and thin coverage. The first verifier's results recorded in
the earlier sections are superseded, not because the live data changed but because that
verifier trusted registry labels and required only one successful Base target. All times
America/Toronto unless marked UTC. Written for the independent Codex audit.

## Identity

| Field                  | Value                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Branch                 | `sprint-1/graph-live-proof`, created from the audited Sprint 0 SHA                                                                                                                                                                         |
| Starting SHA           | `3989149223016158ded59e71f80d7b2c7d3a0683`                                                                                                                                                                                                 |
| Feature commit         | `b09da96e9c9a578e635389f7054a222d69168578`, `feat(graph): add standardized live-query probe`                                                                                                                                               |
| Documentation commit   | `e02fc1904536aa5ab0b058087b6f56bcc8784377`, `docs: record sprint 1 live proof`; audited by Codex with changes requested                                                                                                                    |
| Correction commit      | `b5c824e054f2a4fd8d8de1f69ff40677243937da`, `fix(graph): enforce live gate integrity`                                                                                                                                                      |
| Corrected-proof commit | `docs: record corrected sprint 1 proof`, the commit that introduces this revision; SHA in the handoff                                                                                                                                      |
| Final SHA              | in the handoff                                                                                                                                                                                                                             |
| Preflight              | 5 Sept 21:14: `origin/sprint-0/charter-readiness` at the audited SHA, `main` at `3011b5b5…`, worktree clean, repository public, `GRAPH_API_KEY` present and non-empty in the ignored `.env` by an emptiness test that never read the value |

## Official sources consulted

Accessed 5 September 2026 between 21:15 and 21:20 (2026-09-06 01:15 to 01:20 UTC) through
an automated fetch that returns an extracted summary. Statements attributed to a page are as
extracted; the gateway behaviour was then verified live.

| Source                                                                                  | What it established                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `https://thegraph.com/docs/en/subgraphs/existing-subgraphs/standard-subgraphs/`         | Standardized subgraphs are "open, reusable GraphQL schemas that normalize on-chain data across every protocol of the same type"; Messari maintains them; ten families including Lending/CDP v3.1.0; `schemaVersion`, `subgraphVersion`, `methodologyVersion` semantics; links to `https://github.com/messari/subgraphs` and its `docs/SCHEMA.md` |
| `https://thegraph.com/docs/en/subgraphs/existing-subgraphs/explorer/`                   | Explorer page pattern `https://thegraph.com/explorer/subgraphs/[SUBGRAPH_ID]?view=About&chain=[NETWORK]` showing Subgraph ID, current deployment ID and query URL                                                                                                                                                                                |
| `https://thegraph.com/docs/en/gateways/subgraphs/consumer-side/serving-queries/`        | `POST /api/subgraphs/id/{subgraph_id}` and `POST /api/deployments/id/{deployment_id}`; `Authorization: Bearer <API_KEY>` as the primary method; the page shows a placeholder hostname, so the public gateway host was verified empirically                                                                                                       |
| `https://thegraph.com/docs/en/subgraphs/querying/graphql-api/`                          | `_meta { block { number hash timestamp } deployment hasIndexingErrors }`; `first`, `skip`, `orderBy`, `orderDirection`                                                                                                                                                                                                                           |
| `https://raw.githubusercontent.com/messari/subgraphs/master/deployment/deployment.json` | The Messari deployment registry (375,977 bytes, downloaded to a scratch directory outside the repository, not committed); source of every candidate's public Subgraph ID and registry versions                                                                                                                                                   |
| Graph Explorer pages                                                                    | Listed per selected deployment in the results tables below as `https://thegraph.com/explorer/subgraphs/<id>`. They are rendered client-side and were not fetched by the implementer; the gateway responses are the verification                                                                                                                  |

## Discovery, 90-minute box

Started 21:15, live sweep 21:17, selection complete by 21:25. Elapsed about ten minutes.

The registry lists 164 Ethereum and Base deployments with a decentralized-network query ID.
The Lending/CDP family is the largest coherent set (28 Ethereum, 5 Base) and was chosen. All
33 Lending/CDP candidates and, for comparison, all 11 DEX AMM candidates were queried live
with the one common document. Every candidate is recorded below with its live evidence.
Counts describe the sweep at 21:17; a deployment's freshness can change afterwards.

### The common query

Checked in at `packages/graph-evidence/src/query.ts`. SHA-256 of the exact document:
`780080c478815b08437d6c8bd0b814c895a9a7be9547da61befa128c0ed62306`.

```graphql
query CasStandardizedTvl($snapshots: Int!) {
  _meta {
    block {
      number
      hash
      timestamp
    }
    deployment
    hasIndexingErrors
  }
  protocols(first: 1) {
    id
    name
    slug
    network
    type
    schemaVersion
    subgraphVersion
    methodologyVersion
    totalValueLockedUSD
  }
  financialsDailySnapshots(first: $snapshots, orderBy: timestamp, orderDirection: desc) {
    id
    timestamp
    blockNumber
    totalValueLockedUSD
  }
}
```

It reads only fields the Messari `Protocol` interface and `FinancialsDailySnapshot` entity
expose in every version encountered (1.3.x, 2.0.1, 3.0.1, 3.1.0, 4.0.x). No field was
invented and no protocol-specific branch exists. Only the Subgraph ID varies between calls.
`$snapshots` is 4, enough for a 24-hour baseline with margin.

### Candidate evidence

Live sweep on 5 September 2026 at 21:17 (01:17 UTC). "Common query unchanged" is whether
the document above returned `_meta`, one protocol and at least two snapshots without error.
Freshness rule: the latest snapshot at most 48 hours old.

| Deployment                      | Chain    | Family  | Subgraph ID                                    | Deployment ID                                    | Schema / subgraph / methodology | `_meta` block, timestamp        | Indexing errors | Latest snapshot      | Common query unchanged | Result                                                                              |
| ------------------------------- | -------- | ------- | ---------------------------------------------- | ------------------------------------------------ | ------------------------------- | ------------------------------- | --------------- | -------------------- | ---------------------- | ----------------------------------------------------------------------------------- |
| `aave-v3-ethereum`              | ethereum | lending | `JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk` | `QmcXE5QVcBcvcaJddPxd8mFs6W9xt7STmwfgguoiM6ddAd` | 3.1.0 / 2.4.1 / 1.1.0           | 25914958, 2026-09-06T01:17:23Z  | false           | 2026-09-06T01:16:59Z | yes                    | SELECTED                                                                            |
| `spark-lend-ethereum`           | ethereum | lending | `GbKdmBe4ycCYCQLQSjqGg6UHYoYfbyJyq5WrG35pv1si` | `QmTVumjhubXWP8MeDx5g114MRX99E4Gie5mFqVurttF99X` | 3.1.0 / 2.4.0 / 1.0.0           | 25914959, 2026-09-06T01:17:35Z  | false           | 2026-09-06T01:15:59Z | yes                    | SELECTED                                                                            |
| `makerdao-ethereum`             | ethereum | lending | `8sE6rTNkPhzZXZC6c8UQy2ghFTu5PPdGauwUBm4t7HZ1` | `QmYZq1vyFUgFYqyHJgFg2kYfRuYj2U4aXnxrKhZ7t2ApWy` | 2.0.1 / 2.4.1 / 1.1.0           | 25914959, 2026-09-06T01:17:35Z  | false           | 2026-09-06T01:00:23Z | yes                    | SELECTED                                                                            |
| `compound-v3-ethereum`          | ethereum | lending | `AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9` | `QmNrQoow7pjM3biRnnhzeCaDYhuEbDyjKCpFeNv2oGXnuK` | 3.1.0 / 2.3.0 / 1.0.0           | 25914958, 2026-09-06T01:17:23Z  | false           | 2026-09-06T00:32:35Z | yes                    | SELECTED                                                                            |
| `liquity-ethereum`              | ethereum | lending | `2D2dFCLjUt3MfFgTKW8cBxiRQ3Adss7KUtYh2rTcFVY`  | `QmWEnV6povhA9Eq9Y315LsjJg7qwv169r1ZGw9o2uT24eZ` | 2.0.1 / 1.4.0 / 1.0.1           | 25914958, 2026-09-06T01:17:23Z  | false           | 2026-09-05T22:29:11Z | yes                    | SELECTED                                                                            |
| `seamless-protocol-base`        | base     | lending | `2u4mWUV4xS19ef1MbnxZHWLLMwdPxtVifH46JbonXwXP` | `QmPSmTkJPSKLFn46YdgwMKV5K2c9a3pkWnzDCC4ccCLAXE` | 3.1.0 / 1.0.0 / 1.0.0           | 50934052, 2026-09-06T01:17:31Z  | false           | 2026-09-05T18:13:07Z | yes                    | SELECTED                                                                            |
| `moonwell-base`                 | base     | lending | `33ex1ExmYQtwGVwri1AP3oMFPGSce6YbocBP7fWbsBrg` | `QmeE6TgfRmK2iLAgCLBeXuxJQ2VXLFAeHVMTvmnECiFw7y` | 2.0.1 / 1.0.0 / 1.0.0           | 50934053, 2026-09-06T01:17:33Z  | false           | 2026-09-06T01:16:15Z | yes                    | SELECTED                                                                            |
| `compound-v2-ethereum`          | ethereum | lending | `4TbqVA8p2DoBd5qDbPMwmDZv3CsJjWtxo8nVSqF2tA9a` | `QmZ2LVu8b1J9F92CDRnDKX4CcM21zSNjb9ogdRfMxVCFrg` | 2.0.1 / 1.9.0 / 1.0.0           | 25914958, 2026-09-06T01:17:23Z  | false           | 2026-09-06T01:12:47Z | yes                    | NOT SELECTED: passes, held as backup                                                |
| `goldfinch-ethereum`            | ethereum | lending | `GRwpFCPYyQPdz84sCnKemzrNvgFPuKkFLcRLR6jsRxHr` | `Qma4UYCL7S7cLq3yqGNWzWWDHjZM49mtiTMT1TzMMPMJo2` | 2.0.1 / 1.4.4 / 1.0.1           | 25914958, 2026-09-06T01:17:23Z  | false           | 2026-09-05T19:41:47Z | yes                    | NOT SELECTED: passes, held as backup                                                |
| `iron-bank-ethereum`            | ethereum | lending | `5YoxED3bbWV9byvn3x3S3ebZ3idrQmQmsJhL5LMyY26v` | `QmYDS1MwYNjciXpJVtuuhb9KoPd6CCKLVYnhW3ofzm6yt1` | 2.0.1 / 1.2.0 / 1.0.0           | 25914958, 2026-09-06T01:17:23Z  | false           | 2026-09-05T02:49:35Z | yes                    | NOT SELECTED: passes, held as backup                                                |
| `maple-finance-v2-ethereum`     | ethereum | lending | `94swSaaFChsQoZzb9Vc7Lo6FWFV6YZUMNSdFVTMAeRgj` | `QmVxMhEzFyPHoGzK7E4HQLVv9E8HzPB8hSpqVL9evtqh2K` | 3.0.1 / 1.0.1 / 1.0.0           | 25914958, 2026-09-06T01:17:23Z  | false           | 2026-09-06T00:55:23Z | yes                    | NOT SELECTED: passes, held as backup                                                |
| `morpho-aave-v2-ethereum`       | ethereum | lending | `DsznTYxGdsqxWB6a474rSksvB7qWSth5Ff1PcxW28vZy` | `QmcPfXRyCWdpEV9yVeUSdwPo2cCUxc8anYsDyrgwY35cCJ` | 3.0.1 / 1.2.0 / 1.0.0           | 25914958, 2026-09-06T01:17:23Z  | false           | 2026-09-04T15:25:23Z | yes                    | NOT SELECTED: passes, held as backup                                                |
| `aave-v2-ethereum`              | ethereum | lending | `C2zniPn45RnLDGzVeGZCx2Sw3GXrbc9gL4ZfL8B8Em2j` | `QmdwBHGxokamYsLfMVk6fXfry3Ss9emEiTy6wptd1ecysG` | 3.1.0 / 2.2.0 / 1.1.0           | 25914958, 2026-09-06T01:17:23Z  | false           | 2026-09-06T01:16:59Z | yes                    | NOT SELECTED: Aave version, same protocol family as Aave v3                         |
| `aave-amm-ethereum`             | ethereum | lending | `41ooPWnDYKwckqyG1mvg7ZEndy5zMemXinx6uQxscrBS` | `QmP2GnFgjLvB4RBX6eZMicfaJ9uUvY4iTe2eMM1padTsPt` | 3.1.0 / 2.2.0 / 1.1.0           | 25914958, 2026-09-06T01:17:23Z  | false           | 2026-09-05T14:29:11Z | yes                    | NOT SELECTED: Aave market, same protocol family as Aave v3                          |
| `rari-fuse-ethereum`            | ethereum | lending | `kecp6SPMvbB4GTqg9r5PXvztYriexj5F3ZCaATpjmb2`  | `QmdRFSobiBMoKKyNZnwahtn8uzPFxat86qg1Mu7KobJcSb` | 2.0.1 / 1.2.0 / 1.0.0           | 25914958, 2026-09-06T01:17:23Z  | false           | 2026-09-05T15:39:11Z | yes                    | REJECTED: protocol defunct since 2022; reported TVL implausible                     |
| `dforce-ethereum`               | ethereum | lending | `6PaB6tKFqrL6YoAELEhFGU6Gc39cEynLbo6ETZMF3sCy` | `QmP6bTNozTjdcv9nXvRRzoCV1f3bMh4cuWBDfafARHrQqC` | 2.0.1 / 1.3.0 / 1.0.0           | 25914958, 2026-09-06T01:17:23Z  | false           | 2026-09-03T03:49:35Z | yes                    | REJECTED: latest snapshot 70 h old, fails 48 h freshness                            |
| `uwu-lend-ethereum`             | ethereum | lending | `CZBD7e8VGvNa6WkBHZAaC688bsZ35UvAM1AuDdVng2aE` | `QmUVAKNmyUCZxtn4MrUzSxswavk8gBAMLJaisSQRyyezi4` | 3.1.0 / 2.2.0 / 1.0.0           | 25914958, 2026-09-06T01:17:23Z  | false           | 2026-09-02T05:28:11Z | yes                    | REJECTED: latest snapshot 92 h old, fails 48 h freshness                            |
| `zerolend-ethereum`             | ethereum | lending | `4Zf4doH54RDit9KVsfCp3MkjrP3szhJZwvw2z5PHczx9` | `QmZnr6yqBW59GfPqAZsVWKU6RF4ZeJuSx2pZUa3K7RDdzs` | 3.1.0 / 1.0.0 / 1.0.0           | 25914958, 2026-09-06T01:17:23Z  | false           | 2026-08-26T01:47:11Z | yes                    | REJECTED: latest snapshot 264 h old, fails 48 h freshness; head TVL 0               |
| `truefi-ethereum`               | ethereum | lending | `39F8fYCvLYmutjqpzEwx3dcEJTtFFVupvBzJqkEzftA7` | `QmRtThzzq3zyGLbzVfNEUycjfddfJodLDZZcNQGYr8tNkL` | 2.0.1 / 1.0.5 / 1.0.0           | 25914957, 2026-09-06T01:17:11Z  | false           | 2026-08-22T20:51:23Z | yes                    | REJECTED: latest snapshot 340 h old, fails 48 h freshness                           |
| `morpho-aave-v3-ethereum`       | ethereum | lending | `FKe6ANnWmGPE6hajGLoTgPrVF2jYPHiRu2Jwcg9ZmG9A` | `QmVpuZKrjhjHx2hCtpGNaW29ZYq4Xt2GyPLpiMDP2YTAHE` | 3.0.1 / 1.0.0 / 1.0.0           | 25914959, 2026-09-06T01:17:35Z  | false           | 2026-07-24T13:32:23Z | yes                    | REJECTED: latest snapshot 1044 h old, fails 48 h freshness                          |
| `maple-finance-v1-ethereum`     | ethereum | lending | `J9dtvE11PWNZH74frWyx9QZonyC1Db2UWDMUegmT3zkG` | `QmSThLAKsPhzGffqKwcZnteqA2CR6HbQCtHygVojErwiEN` | 1.3.0 / 1.1.4 / 1.1.0           | 25914959, 2026-09-06T01:17:35Z  | false           | 2025-12-04T00:00:00Z | yes                    | REJECTED: latest snapshot 6625 h old, fails 48 h freshness                          |
| `qidao-ethereum`                | ethereum | lending | `BmQSQaXsivq866kUobQSbyxycjk3D7CiaczKgu3P9ifB` | `QmYzy7RCMhHqDLxWiNY32AExrosJ1chadGfYeEWve15kfU` | 1.3.0 / 1.0.0 / 1.0.1           | 25914958, 2026-09-06T01:17:23Z  | false           | 2025-12-09T18:38:59Z | yes                    | REJECTED: latest snapshot 6487 h old, fails 48 h freshness                          |
| `notional-finance-ethereum`     | ethereum | lending | `2t4T7bts8ZQCpGcVq9VSzDyPVCQc5Y7TFwZKfmXKeSVx` | `QmV1KtTWiHKMM58s7zVt3WPZLxCudJLD54gHEBomzrquSn` | 2.0.1 / 1.0.2 / 1.1.0           | 25914957, 2026-09-06T01:17:11Z  | false           | 2024-06-19T19:55:47Z | yes                    | REJECTED: latest snapshot 19397 h old, fails 48 h freshness                         |
| `aave-rwa-ethereum`             | ethereum | lending | `C8ynQrjVKcmqxb9fWrLvSCBFNf2ChFkxCg7Q8gknJrza` | `Qmae88RwkEQbfGezrNtSqM3BmZYTid5phZzRUJ8k3yVDWZ` | 3.1.0 / 2.2.0 / 1.1.0           | 25914958, 2026-09-06T01:17:23Z  | false           | 2024-04-03T09:56:11Z | yes                    | REJECTED: latest snapshot 21255 h old, fails 48 h freshness                         |
| `aave-arc-ethereum`             | ethereum | lending | `5hyqnEzjZbwFBU1rk4JBknCeiF2Mj93qBzsyQfpAa3QA` | `QmdsSNTCMe1zYjWWb78W7JjeMZbn7cHKBHm3iNxRwqaLwT` | 3.1.0 / 2.2.0 / 1.1.0           | 25914958, 2026-09-06T01:17:23Z  | false           | 2024-02-06T20:11:11Z | yes                    | REJECTED: latest snapshot 22613 h old, fails 48 h freshness                         |
| `euler-finance-ethereum`        | ethereum | lending | `95nyAWFFaiz6gykko3HtBCyhRuP5vZzuKYsZiLxHxLhr` | `QmfTzwSoE3krDFMfYT9XTdwLcdMYBmMwyPqA1FHTMkmsVs` | 1.3.0 / 1.4.0 / 1.2.3           | 25914958, 2026-09-06T01:17:23Z  | false           | 2023-03-13T11:43:59Z | yes                    | REJECTED: latest snapshot 30542 h old, fails 48 h freshness                         |
| `cream-finance-ethereum`        | ethereum | lending | `43NeT7UTACLUkohKBaG7auvkhsj4Kwux9kNTJr6sFdNe` | `QmTHjj9Tdy5zCtJn3KvGQam8RaQ3ZncMAgDZL8y9BFxBqY` | 2.0.1 / 1.2.0 / 1.0.0           | 25914958, 2026-09-06T01:17:23Z  | false           | 2021-10-27T12:38:30Z | yes                    | REJECTED: latest snapshot 42589 h old, fails 48 h freshness                         |
| `abracadabra-ethereum`          | ethereum | lending | `GLAu42kvVs7ixfXcmkAsRiS7Xt1NCpgkKsnz3qiriuvV` | n/a                                              | n/a                             | n/a                             | n/a             | n/a                  | no                     | REJECTED: gateway reported bad indexers (unavailable or bad response)               |
| `inverse-finance-ethereum`      | ethereum | lending | `EXuutY6qkZbXjYeJZdiDBf2imJswTNdfm8YZCqhAthfW` | n/a                                              | n/a                             | n/a                             | n/a             | n/a                  | no                     | REJECTED: gateway reported bad indexers (unavailable or bad response)               |
| `morpho-compound-ethereum`      | ethereum | lending | `9dTy23tkahyiap1THgwnJuMwxNHVnQM57jFQQiUzjcY6` | n/a                                              | n/a                             | n/a                             | n/a             | n/a                  | no                     | REJECTED: gateway reported bad indexers (unavailable or bad response)               |
| `aave-v3-base`                  | base     | lending | `D7mapexM5ZsQckLJai2FawTKXJ7CqYGKM8PErnS3cJi9` | n/a                                              | n/a                             | n/a                             | n/a             | n/a                  | no                     | REJECTED: subgraph not found, no indexer allocations                                |
| `compound-v3-base`              | base     | lending | `AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9` | `QmNrQoow7pjM3biRnnhzeCaDYhuEbDyjKCpFeNv2oGXnuK` | 3.1.0 / 2.3.0 / 1.0.0           | 25914958, 2026-09-06T01:17:23Z  | false           | 2026-09-06T00:32:35Z | yes                    | REJECTED: registry ID is the Ethereum Compound v3 subgraph; reports network MAINNET |
| `qidao-base`                    | base     | lending | `9NHJ9k31qaGCYXppm9isJTiEoiB6v3tJDnR6SrQrxcjw` | `QmeivVyBQ8DpY5zBnzgHviy8fS5UnuCaVBNXVPUvyEKc7G` | 1.3.0 / 1.0.2 / 1.0.1           | 50934054, 2026-09-06T01:17:35Z  | false           | 2026-08-27T11:50:11Z | yes                    | REJECTED: latest snapshot 230 h old, fails 48 h freshness                           |
| `uniswap-v3-ethereum`           | ethereum | dex-amm | `4cKy6QQMc5tpfdx8yxfYeb9TLZmgLQe44ddW1G7NwkA6` | `Qmc9TiHtLDgsbgqvyfXKiyndZDnjWdrfdvETgarZbg3StY` | 4.0.0 / 1.6.2 / 1.0.0           | 25914959, 2026-09-06T01:17:35Z  | false           | 2026-09-06T00:00:11Z | yes                    | NOT SELECTED: DEX AMM family, outside the chosen set; query succeeded unchanged     |
| `sushiswap-v3-ethereum`         | ethereum | dex-amm | `2tGWMrDha4164KkFAfkU3rDCtuxGb4q1emXmFdLLzJ8x` | `QmZ8GrfP8hsJxiQnD6LyBuVWUQCeJgaCboc5BKpHcsNjXG` | 4.0.0 / 1.1.3 / 1.0.0           | 25914959, 2026-09-06T01:17:35Z  | false           | 2026-09-06T00:00:23Z | yes                    | NOT SELECTED: DEX AMM family, outside the chosen set; query succeeded unchanged     |
| `sushiswap-ethereum`            | ethereum | dex-amm | `77jZ9KWeyi3CJ96zkkj5s1CojKPHt6XJKjLFzsDCd8Fd` | `Qmc9f8kuGoE8D3ME38ns2MCodYtSA4gHgyFRojdyK88tL6` | 1.3.2 / 1.2.2 / 1.0.0           | 25914959, 2026-09-06T01:17:35Z  | false           | 2026-09-06T01:17:35Z | yes                    | NOT SELECTED: DEX AMM family, outside the chosen set; query succeeded unchanged     |
| `curve-finance-ethereum`        | ethereum | dex-amm | `3fy93eAT56UJsRCEht8iFhfi6wjHWXtZ9dnnbQmvFopF` | `QmRpHzsesvv7VTrKjEuutiZ7xEfDfd6jH4mgSeDDbUDVRN` | 1.3.0 / 1.1.3 / 1.0.0           | 25914958, 2026-09-06T01:17:23Z  | false           | 2026-09-06T01:17:11Z | yes                    | NOT SELECTED: DEX AMM family, outside the chosen set; query succeeded unchanged     |
| `bancor-v3-ethereum`            | ethereum | dex-amm | `4Q4eEMDBjYM8JGsvnWCafFB5wCu6XntmsgxsxwYSnMib` | `QmWY3ijmFJZkPge1zhCHdCQiuk5GFMZPijMup97nLPDmpo` | 1.3.0 / 1.0.4 / 1.0.0           | 25914958, 2026-09-06T01:17:23Z  | false           | 2026-09-06T01:16:59Z | yes                    | NOT SELECTED: DEX AMM family, outside the chosen set; query succeeded unchanged     |
| `uniswap-v3-base`               | base     | dex-amm | `FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS` | `QmawEzRNeDyaTgjPKb1eRrbyzxczgSHUYzvTMaMnN8jyuh` | 4.0.1 / 1.0.2 / 1.0.0           | 50934055, 2026-09-06T01:17:37Z  | false           | 2026-09-06T00:00:01Z | yes                    | NOT SELECTED: DEX AMM family, outside the chosen set; query succeeded unchanged     |
| `saddle-finance-ethereum`       | ethereum | dex-amm | `H36tAWQeYVioE4hHtaKJEMJMxwzVJWjfg2mimva2wcUj` | `QmPpNXZS6SfP7LYFgV1aHRwqSGrZRHB3piFMtz6qKsVH7o` | 1.3.0 / 1.1.7 / 1.0.0           | 502182010, 2026-09-06T01:17:38Z | false           | 2026-09-06T01:16:42Z | yes                    | REJECTED: reports network ARBITRUM_ONE, registry says ethereum                      |
| `uniswap-v2-swap-ethereum`      | ethereum | dex-amm | `3onEbd9MLfXTTWAfP91yqsKr7C68VCT2ZiF7EoQiQAFj` | `QmZCXBToPx7Tymkv7wexog35WYqQo8Q2BPVGZvJ11KmKCq` | 1.3.2 / 1.1.1 / 1.0.0           | 25914959, 2026-09-06T01:17:35Z  | false           | n/a                  | no                     | REJECTED: no financial snapshots returned                                           |
| `balancer-v2-ethereum`          | ethereum | dex-amm | `794H6CNzdGF5YfBK9nPsUgGn7EBbdJSCTjgcKPEPyFnn` | n/a                                              | n/a                             | n/a                             | n/a             | n/a                  | no                     | REJECTED: gateway reported bad indexers (unavailable or bad response)               |
| `pancakeswap-v3-ethereum`       | ethereum | dex-amm | `JAGXF8B14mpB8QGKnwhKTs5JxsQZBJQvbDGFcWwL7gbm` | n/a                                              | n/a                             | n/a                             | n/a             | n/a                  | no                     | REJECTED: subgraph not found, no indexer allocations                                |
| `substream-uniswap-v2-ethereum` | ethereum | dex-amm | `J2oP9UNBjsnuDDW1fAoHKskyrNLFNBB2badQU6UvEtJp` | n/a                                              | n/a                             | n/a                             | n/a             | n/a                  | no                     | REJECTED: subgraph not found, no indexer allocations                                |

Selection rule applied: Lending/CDP family; common query unchanged; reported `network`
matches the chain; no indexing errors; latest snapshot within 48 hours; non-zero, plausible
TVL; distinct protocols preferred over versions or markets of one protocol; five for
Ethereum ranked by TVL and freshness. Aave v2, Aave AMM and Aave ARC/RWA are versions or
markets of Aave, so they do not count as distinct protocols.

## Counts, stated exactly

| Measure                                                             | Count                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Candidates swept live                                               | 44 (33 Lending/CDP: 28 Ethereum, 5 Base; 11 DEX AMM: 10 Ethereum, 1 Base)       |
| Candidates on which the common query succeeded unchanged            | 35                                                                              |
| Selected deployments                                                | 7 (5 Ethereum, 2 Base)                                                          |
| Distinct protocols among the selected deployments                   | 7 (Aave v3, Spark, MakerDAO, Compound v3, Liquity; Seamless Protocol, Moonwell) |
| Distinct protocols on Ethereum with a valid signal at the probe run | 5                                                                               |
| Protocol entities read                                              | 7, one `Protocol` entity per deployment                                         |
| Snapshot entities read at the probe run                             | 28, four `FinancialsDailySnapshot` entities per deployment                      |
| Schema versions across the selected set                             | 2 (3.1.0 and 2.0.1), same query and adapter                                     |

No deployment, market or entity is described here as a separate protocol unless it is one.

## Live probe run

Command, with the key loaded into the shell from the ignored `.env` and never echoed:

```bash
set -a && . ./.env && set +a && corepack pnpm --filter @cas/graph-evidence probe:live
```

Run at 21:50:41 on 5 September 2026 (2026-09-06T01:50:42Z). Exit code 0. Redacted output
lines, exactly as printed:

```
CAS Chainwatch live Graph probe. query sha256=780080c478815b08437d6c8bd0b814c895a9a7be9547da61befa128c0ed62306
Queried at 2026-09-06T01:50:42.036Z through the configured gateway (credentials redacted).
Ethereum gate: PASS (5 distinct protocols with a valid signal across 5 deployments; minimum 5)
Base secondary: PASS (2 distinct protocols with a valid signal across 2 deployments; reported, does not affect the exit code)
Details written to <repo>/output/graph-probe/2026-09-06T01-50-43-047Z.json (ignored by Git).
```

### Ethereum results

All five deployments answered at block 25915123, block timestamp 2026-09-06T01:50:35Z,
`hasIndexingErrors=false`, reported `network=MAINNET`. The current observation is the
protocol head at that block; the baseline is the daily financial snapshot the window rule
selected. Elapsed windows are measured and are not 24 hours.

| Protocol    | Subgraph ID                                    | Deployment ID                                    | Schema / subgraph / methodology | Baseline snapshot (UTC) | Elapsed | Current TVL (USD)                   | Baseline TVL (USD)                  | Delta      |
| ----------- | ---------------------------------------------- | ------------------------------------------------ | ------------------------------- | ----------------------- | ------- | ----------------------------------- | ----------------------------------- | ---------- |
| Aave v3     | `JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk` | `QmcXE5QVcBcvcaJddPxd8mFs6W9xt7STmwfgguoiM6ddAd` | 3.1.0 / 2.4.1 / 1.1.0           | 2026-09-04T23:59:47Z    | 25h 50m | 24825509165.28344367916987689258337 | 24390607628.64157812685081285171331 | +1.783069% |
| Spark       | `GbKdmBe4ycCYCQLQSjqGg6UHYoYfbyJyq5WrG35pv1si` | `QmTVumjhubXWP8MeDx5g114MRX99E4Gie5mFqVurttF99X` | 3.1.0 / 2.4.0 / 1.0.0           | 2026-09-04T23:58:11Z    | 25h 52m | 6537378959.191946976475450480029108 | 6567499122.884807083548118459841748 | -0.458624% |
| MakerDAO    | `8sE6rTNkPhzZXZC6c8UQy2ghFTu5PPdGauwUBm4t7HZ1` | `QmYZq1vyFUgFYqyHJgFg2kYfRuYj2U4aXnxrKhZ7t2ApWy` | 2.0.1 / 2.4.1 / 1.1.0           | 2026-09-04T23:00:35Z    | 26h 50m | 5004824558.845052077626540603111979 | 4982441776.684958058506420524407173 | +0.449233% |
| Compound v3 | `AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9` | `QmNrQoow7pjM3biRnnhzeCaDYhuEbDyjKCpFeNv2oGXnuK` | 3.1.0 / 2.3.0 / 1.0.0           | 2026-09-04T23:58:47Z    | 25h 51m | 1872250300.147126233741360739005338 | 1865466552.265404811605434119041474 | +0.363648% |
| Liquity     | `2D2dFCLjUt3MfFgTKW8cBxiRQ3Adss7KUtYh2rTcFVY`  | `QmWEnV6povhA9Eq9Y315LsjJg7qwv169r1ZGw9o2uT24eZ` | 2.0.1 / 1.4.0 / 1.0.1           | 2026-09-04T23:58:35Z    | 25h 52m | 188117247.1529877651978258637050038 | 193848916.0000438101041822542668727 | -2.956771% |

Explorer pages: `https://thegraph.com/explorer/subgraphs/<Subgraph ID>` for each row.

**Ethereum proof result: PASS.** Five distinct protocols, live provider-backed, one query,
one adapter, complete provenance, gate minimum five.

### Base results and gate

Investigation window: 21:17 (first Base queries in the sweep) to 21:50 (probe run), about
33 minutes of the four-hour box. Not extended. No protocol-specific fork written.

Both deployments answered at block 50935047, block timestamp 2026-09-06T01:50:41Z,
`hasIndexingErrors=false`, reported `network=BASE`.

| Protocol          | Subgraph ID                                    | Deployment ID                                    | Schema / subgraph / methodology | Baseline snapshot (UTC) | Elapsed | Current TVL (USD)                  | Baseline TVL (USD)                  | Delta      |
| ----------------- | ---------------------------------------------- | ------------------------------------------------ | ------------------------------- | ----------------------- | ------- | ---------------------------------- | ----------------------------------- | ---------- |
| Seamless Protocol | `2u4mWUV4xS19ef1MbnxZHWLLMwdPxtVifH46JbonXwXP` | `QmPSmTkJPSKLFn46YdgwMKV5K2c9a3pkWnzDCC4ccCLAXE` | 3.1.0 / 1.0.0 / 1.0.0           | 2026-09-04T22:50:41Z    | 27h 00m | 8784223.5777026434711507877405759  | 8781706.33693495351465605546116409  | +0.028664% |
| Moonwell          | `33ex1ExmYQtwGVwri1AP3oMFPGSce6YbocBP7fWbsBrg` | `QmeE6TgfRmK2iLAgCLBeXuxJQ2VXLFAeHVMTvmnECiFw7y` | 2.0.1 / 1.0.0 / 1.0.0           | 2026-09-04T23:58:55Z    | 25h 51m | 49824501.3860144771267983592103261 | 51726498.42463972858573934725446898 | -3.677026% |

Gate criteria from the charter, each checked:

| Criterion                                                    | Result                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Same query document and response adapter                     | yes, byte-identical document, same adapter                                                        |
| Compatible standardized schema versions                      | yes, Lending/CDP 3.1.0 and 2.0.1, both also present in the Ethereum set                           |
| No indexing-error flag                                       | yes, both false                                                                                   |
| Usable current and baseline observations                     | yes, windows 27h 00m and 25h 51m                                                                  |
| Explicit block and query provenance                          | yes, block 50935047 with hash and timestamp, deployment IDs, query hash, UTC query time           |
| Sufficiently recent data under the documented freshness rule | yes, current observation 0 h old at query time; latest snapshots 7.1 h and 0.0 h old at the sweep |

**Base gate result: KEPT, with thin coverage.** Two live Lending/CDP deployments pass. The
largest Base lending deployment in the registry, Aave v3 Base, has no indexer allocations,
and the registry's Compound v3 Base entry is a copy of the Ethereum Subgraph ID. The project
owner may override the keep under D17 if two deployments is judged insufficient for the MVP.

## Implementation

`@cas/graph-evidence` (`docs/ARCHITECTURE.md` section 9) and the Sprint 1 contracts in
`@cas/contracts`: `ChainId`, `ProtocolIdentity`, `GraphQueryProvenance`,
`ProtocolTvlObservation`, `TvlDeltaSignal`, all with `DataOrigin` `live` on live results.
Built on Node's global `fetch`; no GraphQL client, no decimal package, no `tsx`. The probe is
compiled by `tsc` and the emitted JavaScript is run with `node`.

TVL-delta rule: observations sorted by timestamp; the current observation is the newest; the
baseline is the observation between 12 and 48 hours before it whose age is closest to
24 hours; zero, negative, missing, non-finite and malformed values are rejected; raw decimal
strings are retained; the percentage is exact scaled-BigInt arithmetic truncated, not
rounded, to six fraction digits, and that truncation is the only precision loss.

## Dependencies added

| Package        | Version | Published (UTC)      | Age at install | Why                                                                        |
| -------------- | ------- | -------------------- | -------------- | -------------------------------------------------------------------------- |
| `@types/node`  | 24.13.3 | 2026-07-08T06:48:03Z | 59 days        | Node typings for `fetch`, `node:crypto`, `node:fs`, `process`; catalog pin |
| `undici-types` | 7.18.2  | 2026-01-06T15:57:40Z | 242 days       | Sole dependency of `@types/node`; transitive                               |

Both satisfy D13's 24-hour release-age gate with no exception. The remaining lockfile lines
are Vitest and Vite resolution keys re-recorded with the new peer; no other package changed.

## Tests and commands

| Command                                                    | Result                                                                                                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm test` (default, no network, no secret)      | at `e02fc190`: 42 tests. After the correction: 86 tests, 80 in `@cas/graph-evidence` across eight files, 5 in `@cas/contracts`, 1 in `@cas/worker` |
| `corepack pnpm graph:test:live`                            | 3 tests passed with the local credential; fails without it                                                                                         |
| `corepack pnpm graph:probe`                                | exit 0, output in the correction section                                                                                                           |
| `env -u GRAPH_API_KEY corepack pnpm graph:probe`           | exit 2, "GRAPH_API_KEY is missing"                                                                                                                 |
| `corepack pnpm typecheck`, `lint`, `build`, `format:check` | green on the working copy before each commit                                                                                                       |

The unit tests cover: a valid standardized response; observations out of order; percentage
calculation and truncation; zero, negative and malformed baselines; missing snapshot fields;
GraphQL errors with HTTP 200; non-2xx responses; timeout; `hasIndexingErrors`; missing
credential; credential and URL redaction; and a structural proof that the live path has no
fixture or replay fallback. Final verification with exit codes, the clean-checkout run and
the CI URL are in the handoff.

## Ranked watchlist candidates for D2 (not a resolution)

D2 stays unresolved for the project owner. Ranked by live coverage evidence in the
Lending/CDP family on Ethereum, using the sweep and probe results above:

1. Aave v3 (3.1.0, fresh, largest TVL, selected)
2. Spark (3.1.0, fresh, selected)
3. MakerDAO (2.0.1, fresh, selected)
4. Compound v3 (3.1.0, fresh, selected)
5. Liquity (2.0.1, fresh, selected)
6. Compound v2 (2.0.1, fresh, backup)
7. Iron Bank (2.0.1, snapshot 22.5 h old at the sweep, backup)
8. Goldfinch (2.0.1, fresh, backup)
9. Maple Finance v2 (3.0.1, fresh, backup)
10. Morpho Aave v2 (3.0.1, snapshot 33.9 h old at the sweep, small TVL, backup)

Excluded from ranking on evidence: Aave v2 and Aave AMM (same protocol as Aave v3), Rari
Fuse (defunct, implausible TVL), dForce, UwU Lend, ZeroLend, TrueFi, Morpho Aave v3, Maple
v1, QiDAO, Notional, Aave ARC and RWA, Euler v1, Cream (stale), Abracadabra, Inverse Finance
and Morpho Compound (no usable indexer).

## Limitations and unresolved risks

- Base coverage is two deployments. The chain is kept by the rule, and the coverage is thin.
- The selected set mixes schema versions 3.1.0 and 2.0.1. The common query reads only fields
  stable across those versions; a future Messari schema change would fail loudly in the
  adapter rather than silently.
- The registry contains errors (Compound v3 Base pointing at Ethereum; Saddle reporting
  Arbitrum) and defunct protocols with plausible-looking data (Rari Fuse). The live network
  field and the freshness rule caught these; TVL plausibility was judged manually.
- TVL values are the standardized subgraphs' own USD computations. No independent price
  check was made.
- `_meta.block.timestamp` was returned by every live deployment; if an indexer omitted it,
  the adapter would use the latest snapshot as the current observation instead.
- The gateway hostname is not stated on the serving-queries page; `gateway.thegraph.com` was
  verified empirically and remains configurable.
- Explorer pages were not fetched. Their URLs are listed for the human auditor.
- About 60 gateway queries were used in the sprint.

## Correction after Codex audit

Codex audited `e02fc190` and requested changes: the executable gate had counted configured
labels rather than provider-returned facts, accepted one successful Base target as a pass,
validated the gateway URL by regular expression, left response-body read errors
unstructured, and let a future-dated observation pass as fresh. The correction commit
`b5c824e0` (`fix(graph): enforce live gate integrity`) addresses each point; this section
records the rerun on the corrected gate. Earlier sections of this report are kept as the
history of the first run and are superseded by what follows.

### What changed in the verifier

| Concern                  | Before                                                                                      | After                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider identity        | Configured slug substituted into the result; `network`, `type` and `schemaVersion` optional | Adapter requires provider `name`, `slug`, `network`, `type`, `schemaVersion`; provider identity and configured target carried side by side (`ProtocolIdentity` versus `targetChain`/`targetSlug` in provenance)                                                |
| Registry expectations    | Registry schema version recorded for information only                                       | Each target declares expected provider `network`, `type` and `schemaVersion` from the verified sweep; registry uniqueness of subgraph IDs and labels asserted at load                                                                                          |
| Live metadata validation | None before counting                                                                        | Live `network`, normalized chain, `type`, `schemaVersion`, subgraph ID and deployment ID compared with expectations; a mismatch is a structured, redacted failure with target label, field, expected, received and subgraph ID                                 |
| Network normalization    | Reported network printed, not checked                                                       | Only `MAINNET` and `BASE` recognized; anything else fails validation                                                                                                                                                                                           |
| Distinctness             | Counted configured protocol labels                                                          | Counted jointly over provider identity (chain, slug, name), subgraph ID and deployment ID; duplicates reported, never counted twice                                                                                                                            |
| Base threshold           | One valid target passed                                                                     | Every configured Base target must verify, with two distinct identities, subgraph IDs and deployment IDs; one of two is FAIL/DROP                                                                                                                               |
| Gateway URL              | Regular expression, `https` prefix only                                                     | `new URL()`: `https:` only; no username, password, query string or fragment; hostname required; trailing slashes normalized; rejected values never echoed; provenance records sanitized origin and path and claims the gateway only for `gateway.thegraph.com` |
| Body-read failures       | Uncaught during `response.text()`                                                           | Abort during the body read is a `timeout`; other read failures are `network`                                                                                                                                                                                   |
| Freshness                | Only the stale side checked; negative age passed                                            | 48-hour limit plus a 120-second clock-skew tolerance; a future-dated observation beyond it fails                                                                                                                                                               |
| Exit contract            | Same                                                                                        | 0 Ethereum gate pass, 1 fail, 2 credential missing or registry invalid; Base printed as PASS/KEEP or FAIL/DROP and never changes the exit code                                                                                                                 |

Commands: `corepack pnpm graph:probe` and `corepack pnpm graph:test:live` at the workspace
root delegate to the package scripts. Tests: 80 unit tests in `@cas/graph-evidence` across
eight files, covering the twenty-two required cases (identity, distinctness, thresholds,
URL security, provenance sanitization, body-read classification, freshness boundaries, exit
codes, and the earlier decimal, delta, redaction and no-credential behaviour).

### Corrected live rerun

Command, with the key loaded into the shell from the ignored `.env` and never echoed:

```bash
set -a && . ./.env && set +a && corepack pnpm graph:probe
```

Run at 23:03:10 on 5 September 2026 (2026-09-06T03:03:10Z). Exit code 0. Query SHA-256
`780080c478815b08437d6c8bd0b814c895a9a7be9547da61befa128c0ed62306`, unchanged. Endpoint
recorded in provenance: `the-graph-gateway https://gateway.thegraph.com/api`. Gate lines,
exactly as printed:

```
Ethereum gate: PASS (5 valid of 5 configured; 5 distinct provider identities, 5 distinct subgraph IDs, 5 distinct deployment IDs; minimum 5)
Base secondary: PASS/KEEP (2 valid of 2 configured; 2 distinct provider identities, 2 distinct subgraph IDs, 2 distinct deployment IDs; minimum 2, all configured targets required) [does not affect the exit code]
```

Every Ethereum target was served at block 25915485 (2026-09-06T03:02:59Z) and every Base
target at block 50937221 (2026-09-06T03:03:09Z), all with `hasIndexingErrors=false`. The
current observation is the protocol head at that block; freshness age is the query time
minus that block time. Validation result is "match" when every expected field equalled the
provider value.

| Target label             | Provider name     | Provider slug       | Network | Type    | Schema | Subgraph ID                                    | Deployment ID                                    | Snapshot timestamps (UTC)                                                              | Baseline (UTC)       | Elapsed | Current TVL (USD)                   | Baseline TVL (USD)                  | Delta      | Freshness   | Validation |
| ------------------------ | ----------------- | ------------------- | ------- | ------- | ------ | ---------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- | -------------------- | ------- | ----------------------------------- | ----------------------------------- | ---------- | ----------- | ---------- |
| `aave-v3-ethereum`       | Aave v3           | `aave-v3`           | MAINNET | LENDING | 3.1.0  | `JCNWRypm7FYwV8fx5HhzZPSFaMxgkPuw4TnR3Gpi81zk` | `QmcXE5QVcBcvcaJddPxd8mFs6W9xt7STmwfgguoiM6ddAd` | 2026-09-06T03:02:59Z, 2026-09-05T23:59:23Z, 2026-09-04T23:59:47Z, 2026-09-03T23:59:47Z | 2026-09-04T23:59:47Z | 27h 03m | 24831061425.60497178908210760835774 | 24390607628.64157812685081285171331 | +1.805833% | fresh, 11 s | match      |
| `spark-lend-ethereum`    | Spark Lend        | `spark-lend`        | MAINNET | LENDING | 3.1.0  | `GbKdmBe4ycCYCQLQSjqGg6UHYoYfbyJyq5WrG35pv1si` | `QmTVumjhubXWP8MeDx5g114MRX99E4Gie5mFqVurttF99X` | 2026-09-06T02:58:59Z, 2026-09-05T23:47:35Z, 2026-09-04T23:58:11Z, 2026-09-03T23:55:23Z | 2026-09-04T23:58:11Z | 27h 04m | 6535204523.31132468093621432403089  | 6567499122.884807083548118459841748 | -0.491733% | fresh, 12 s | match      |
| `makerdao-ethereum`      | MakerDAO          | `makerdao`          | MAINNET | LENDING | 2.0.1  | `8sE6rTNkPhzZXZC6c8UQy2ghFTu5PPdGauwUBm4t7HZ1` | `QmYZq1vyFUgFYqyHJgFg2kYfRuYj2U4aXnxrKhZ7t2ApWy` | 2026-09-06T03:00:35Z, 2026-09-05T23:00:47Z, 2026-09-04T23:00:35Z, 2026-09-03T23:00:23Z | 2026-09-04T23:00:35Z | 28h 02m | 5005479787.161439319218165346030041 | 4982441776.684958058506420524407173 | +0.462383% | fresh, 12 s | match      |
| `compound-v3-ethereum`   | Compound III      | `compound-v3`       | MAINNET | LENDING | 3.1.0  | `AwoxEZbiWLvv6e3QdvdMZw4WDURdGbvPfHmZRc8Dpfz9` | `QmNrQoow7pjM3biRnnhzeCaDYhuEbDyjKCpFeNv2oGXnuK` | 2026-09-06T03:02:47Z, 2026-09-05T23:28:23Z, 2026-09-04T23:58:47Z, 2026-09-03T23:54:23Z | 2026-09-04T23:58:47Z | 27h 04m | 1876288732.494113778731974471046054 | 1865466552.265404811605434119041474 | +0.580132% | fresh, 12 s | match      |
| `liquity-ethereum`       | Liquity           | `liquity`           | MAINNET | LENDING | 2.0.1  | `2D2dFCLjUt3MfFgTKW8cBxiRQ3Adss7KUtYh2rTcFVY`  | `QmWEnV6povhA9Eq9Y315LsjJg7qwv169r1ZGw9o2uT24eZ` | 2026-09-06T01:33:35Z, 2026-09-05T22:29:11Z, 2026-09-04T23:58:35Z, 2026-09-03T20:05:47Z | 2026-09-04T23:58:35Z | 27h 04m | 188117247.1529877651978258637050038 | 193848916.0000438101041822542668727 | -2.956771% | fresh, 12 s | match      |
| `seamless-protocol-base` | Seamless Protocol | `seamless-protocol` | BASE    | LENDING | 3.1.0  | `2u4mWUV4xS19ef1MbnxZHWLLMwdPxtVifH46JbonXwXP` | `QmPSmTkJPSKLFn46YdgwMKV5K2c9a3pkWnzDCC4ccCLAXE` | 2026-09-06T02:31:23Z, 2026-09-05T18:13:07Z, 2026-09-04T22:50:41Z, 2026-09-03T21:06:35Z | 2026-09-04T22:50:41Z | 28h 12m | 8784205.2173735728743907877405759   | 8781706.33693495351465605546116409  | +0.028455% | fresh, 2 s  | match      |
| `moonwell-base`          | Moonwell          | `moonwell`          | BASE    | LENDING | 2.0.1  | `33ex1ExmYQtwGVwri1AP3oMFPGSce6YbocBP7fWbsBrg` | `QmeE6TgfRmK2iLAgCLBeXuxJQ2VXLFAeHVMTvmnECiFw7y` | 2026-09-06T03:01:13Z, 2026-09-05T23:51:51Z, 2026-09-04T23:58:55Z, 2026-09-03T23:59:39Z | 2026-09-04T23:58:55Z | 27h 04m | 49470626.43078311010569889341364989 | 51726498.42463972858573934725446898 | -4.361153% | fresh, 2 s  | match      |

The provider slugs differ from the registry slugs for every target (for example `aave-v3`
versus `aave-v3-ethereum`). The corrected adapter preserves the provider value and the gate
counts on it; the first verifier would have reported the registry value. No live schema
change was found, so no registry expectation was updated.

**Ethereum gate outcome: PASS.** Five valid of five, five distinct provider identities,
subgraph IDs and deployment IDs, every target `MAINNET` and `LENDING` with its declared
schema version, every target with a valid two-point delta and fresh current observation.

**Base gate outcome: PASS/KEEP.** Both configured targets verified, two distinct provider
identities, subgraph IDs and deployment IDs, both `BASE` and `LENDING` with their declared
schema versions. Coverage remains two deployments; the keep is recorded truthfully under the
stricter rule and stays subject to the project owner's confirmation on coverage grounds.

**D17 disposition:** its gate definition and recorded results are superseded by D18; its
schema family, provider interface and deployment selection stand.

`corepack pnpm graph:test:live`: 3 tests passed on the same evidence. `env -u GRAPH_API_KEY
corepack pnpm graph:probe`: exit 2. The key value occurred zero times in the probe and test
logs, checked in-shell without printing it.

## Confirmation

No secret and no raw provider response was committed. The key exists only in the ignored
`.env` (mode 600) and was never printed, hashed, measured or read by the implementer. Raw
sweep output stayed in a scratch directory outside the repository; the probe's detail files
are under the ignored `output/` path with mode 600. The report records block numbers,
timestamps, identifiers, provider identity fields and TVL figures only.
