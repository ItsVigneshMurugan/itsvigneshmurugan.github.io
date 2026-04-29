---
title: "Scoping Down IAM Policies Using Access Analyser and Action-Level Tracking"
date: 2026-04-28T00:00:00Z
draft: false
summary: "How to use AWS IAM Access Analyser and action-level service tracking to systematically remove unused permissions from any IAM role, and where these tools fall short."
tags: ['aws', 'iam', 'security', 'least-privilege', 'access-analyser', 'infrastructure']
---

Wildcard IAM policies grow organically — someone adds `s3:*` to unblock a feature, then `cloudformation:*`, then `states:*`. Before long the role has hundreds of permissions it may never use. Every unused permission is an attack surface.

Scoping these down manually by reading SDK calls is tedious. AWS gives you two tools that, combined, do most of the work.

---

## The Two Tools

### 1. IAM Access Analyser — Unused Access

Create an `ACCOUNT_UNUSED_ACCESS` analyser in each account:

```bash
aws accessanalyzer create-analyzer \
  --analyzer-name unused-access \
  --type ACCOUNT_UNUSED_ACCESS \
  --configuration '{"unusedAccess":{"unusedAccessAge":90}}'
```

Then pull findings for a role:

```bash
aws accessanalyzer list-findings-v2 \
  --analyzer-arn arn:aws:accessanalyzer:ap-southeast-2:123456789012:analyzer/unused-access \
  --filter '{"resourceType":{"eq":["AWS::IAM::Role"]},"resource":{"contains":["my-app-role"]}}'

aws accessanalyzer get-finding-v2 \
  --analyzer-arn arn:aws:accessanalyzer:ap-southeast-2:123456789012:analyzer/unused-access \
  --id <finding-id>
```

The finding gives you a per-service list of actions that have not been exercised within the tracking window. **It only tells you what is unused — not what is used.**

### 2. IAM Action Last-Accessed Details

This tells you which actions have actually been invoked:

```bash
JOB_ID=$(aws iam generate-service-last-accessed-details \
  --arn arn:aws:iam::123456789012:role/my-app-role \
  --granularity ACTION_LEVEL \
  --query 'JobId' --output text)

# Paginated — 200 services per page, use --marker for subsequent pages
aws iam get-service-last-accessed-details \
  --job-id "$JOB_ID" --max-items 200
```

Each tracked action comes back with a `LastAuthenticated` timestamp. **It only tells you what has been used — not what is unused.**

---

## The Critical Limitation: Data-Plane Operations

Both tools are built on CloudTrail management events. **Data-plane operations are not tracked by either tool**, regardless of how frequently they are called:

| Service | Not tracked (data-plane) |
|---|---|
| S3 | `GetObject`, `PutObject`, `DeleteObject`, `ListBucket` |
| DynamoDB | `GetItem`, `PutItem`, `Query`, `Scan`, `UpdateItem` |
| EventBridge | `PutEvents` |
| SQS | `SendMessage`, `ReceiveMessage`, `DeleteMessage` |
| Kinesis | `PutRecord`, `GetRecords` |

An action's absence from the unused list does **not** mean it is in use — it may simply not be tracked. For data-plane actions, you cannot infer anything from these tools alone. Verify via codebase search or CloudTrail data events.

---

## The Cross-Matching Technique

For control-plane actions, combining both tools gives you the full picture:

```
used control-plane actions = all tracked actions − unused tracked actions
```

For data-plane actions: codebase verification only.

---

## Service-by-Service Examples

### Whole services to remove outright

Start broad — which services have zero access across the entire tracking window?

```
connect:*    — 270+ actions, never accessed
kinesis:*    — 23 actions, never accessed
lambda:*     — 63 actions, never accessed
pipes:*      —  7 actions, never accessed
```

Before deleting, always check the codebase. One case: `license-manager:*` showed as never accessed on staging, but the codebase used `CheckoutLicenseCommand` for AWS Marketplace licence validation — not triggered on staging, but essential in production. The right call was to keep it scoped to `license-manager:CheckoutLicense`.

### EventBridge (`events:*`)

52 control-plane actions (rule management, bus management) are all unused. `PutEvents` is data-plane — invisible to both tools. Check the codebase to confirm whether it is used, then scope accordingly:

```
events:PutEvents
```

### Amazon Polly (`polly:*`)

8 actions in the unused list. `SynthesizeSpeech` is absent — meaning it was tracked and used. Everything else (lexicon management, task operations) is unused.

```
polly:SynthesizeSpeech
```

### DynamoDB (`dynamodb:*`)

`CreateTable` and `DescribeTable` are confirmed used via tracking. All CRUD operations (`GetItem`, `PutItem`, `Query`, etc.) are data-plane and invisible — determine these from the codebase. The unused list clearly marks management operations as removable: `DeleteTable`, `UpdateTable`, `CreateGlobalTable`, backup/restore operations, replication, streams.

### S3 (`s3:*`)

112 tracked actions are all unused — every one is a bucket management operation (`CreateBucket`, `PutBucketPolicy`, versioning, CORS, etc.). Safe to remove entirely.

Object operations (`GetObject`, `PutObject`, `DeleteObject`, `ListBucket`, multipart uploads) are data-plane and invisible to both tools. Determine the required list from codebase search.

---

## Cross-Account Comparison

If the same role policy is deployed across multiple accounts or environments, run the analysis everywhere. Services unused on one account's staging can be actively used on another's.

| Service | Account A | Account B | Decision |
|---|---|---|---|
| `states:*` | Never | Active | Keep, scope down |
| `polly:*` | Never | Active | Keep, scope down |
| `connect:*` | Never | Never | Remove |
| `transcribe:*` | Active | Never | Keep, scope down |

Analyse every account before removing anything.

---

## Summary

1. **Access Analyser** → what is unused (control-plane only)
2. **Action last-accessed** → what has been used (control-plane only)
3. **Cross-match** → `used = tracked − unused`
4. **Codebase search** → required for all data-plane operations
5. **Run across all accounts** — a service unused on staging may be active elsewhere
