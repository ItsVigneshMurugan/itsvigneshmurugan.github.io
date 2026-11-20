---
title: "Following a DynamoDB Request, Step by Step"
date: 2026-11-20T14:00:00+13:00
draft: false
tags: ['dynamodb', 'aws', 'distributed-systems', 'paxos', 'databases']
---

I've been reading the 2022 USENIX paper on how Amazon builds and runs DynamoDB, [*Amazon DynamoDB: A Scalable, Predictably Performant, and Fully Managed NoSQL Database Service*](https://www.usenix.org/system/files/atc22-elhemali.pdf). The part I wanted to keep in my head is the path a single request takes, and what happens to it when something breaks. Prose is easy to forget, so I turned it into something you can step through.

Pick a scenario, then press **Next** or use the arrow keys. Each step has its own link, so you can point someone at a specific moment, like [the leader failing](#leader-fails) or [the write quorum](#put-item-7).

{{< flow data="explainers/dynamodb-request-flow.json" >}}

## What to notice

**The router's three lookups are all cached.** Authentication (IAM and KMS), routing (which storage nodes hold the partition) and admission control (tokens from GAC) are answered locally and refreshed in the background. The paper's lesson is to design for predictability over efficiency: the MemDS refresh happens even on a cache hit, so the metadata service sees the same load whether caches are warm or cold, and a cold cache can't flood it.

**Two out of three is enough.** A write is acknowledged once two of the three replicas, in different Availability Zones, have it in their write-ahead log. That's why one slow or failed replica doesn't block writes.

**Strong versus eventual consistency is a routing decision.** A strongly consistent read must go to the leader. An eventually consistent read can go to any replica, so it may be slightly behind.

**Log replicas buy time.** Rebuilding a full replica takes minutes. A log replica, holding only recent log entries, is ready in seconds and keeps the write quorum intact in the meantime.

**Failure detection is where availability is won or lost.** A new leader has to wait for the old leader's lease to expire before serving. So DynamoDB checks with the other replicas before calling an election, to avoid paying that cost for a gray failure.

## What the diagram leaves out

It shows one partition. Real storage nodes host replicas of thousands of partitions from different tables. It also leaves out secondary indexes, transactions, global tables and streams. The paper doesn't say which replica an eventually consistent read goes to, or where a new log replica is placed, so those parts of the drawing are illustrative.

## Source

Elhemali et al., *Amazon DynamoDB: A Scalable, Predictably Performant, and Fully Managed NoSQL Database Service*, USENIX ATC 2022. Transactions are covered separately in [*Distributed Transactions at Scale in Amazon DynamoDB*](https://www.usenix.org/system/files/atc23-idziorek.pdf) (USENIX ATC 2023).

The step-through format is inspired by Marc Brooker's [Aurora DSQL transaction flow](https://brooker.co.za/dsql-transaction-flow.html).
