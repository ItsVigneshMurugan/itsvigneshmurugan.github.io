---
title: "Event-Driven Autoscaling on EKS with KEDA and Amazon SQS"
date: 2026-04-29T00:00:00Z
draft: false
tags: ['keda', 'kubernetes', 'aws', 'sqs', 'eks', 'autoscaling', 'helmfile', 'eks-pod-identity', 'devops']
---

When you think about Kubernetes autoscaling, HPA (Horizontal Pod Autoscaler) is usually the first thing that comes to mind. It works well for CPU and memory-bound workloads, but for event-driven services — workers that drain a queue, process webhooks, or respond to async messages — HPA falls short. This post covers how I implemented [KEDA](https://keda.sh) on an EKS cluster, why HPA alone wasn't enough, and the practical Helmfile setup I landed on.

## The Problem with HPA for Queue-Based Workers

HPA scales based on resource utilisation — CPU and memory by default, or custom metrics with some extra plumbing. For a service that consumes from an Amazon SQS queue, this creates a mismatch:

- The workers use low CPU even when the queue is growing, because SQS long-polling is I/O-bound — the worker thread is blocked waiting on a network response, not burning CPU
- HPA sees low CPU → keeps replicas at minimum → queue depth grows → latency spikes
- The fundamental problem: CPU looks identical whether the queue is empty or has 10,000 messages

The root cause is that HPA reacts to **symptoms** (resource pressure) rather than the **actual signal** (queue depth). What you really want is: *scale out when there are messages to process, scale in when the queue is empty.*

That's exactly what KEDA is designed for.

```
Without KEDA (HPA only):

  SQS Queue depth: 500 messages
  Worker CPU: 5% (long-polling is I/O-bound — CPU looks the same whether queue is empty or full)
  HPA decision: do nothing
  Result: messages pile up ❌

With KEDA:

  SQS Queue depth: 500 messages
  KEDA target: 5 messages per replica
  KEDA decision: scale to 100 replicas (capped at maxReplicaCount)
  Result: queue drains quickly ✓
```

## What is KEDA?

KEDA (Kubernetes Event-Driven Autoscaler) is a CNCF graduated project that extends Kubernetes with event-driven scaling. It works alongside — not instead of — HPA. Under the hood, KEDA creates and manages an HPA for your deployment, but feeds it metrics from external sources (SQS queue depth, Kafka lag, Redis list length, etc.) via a custom metrics API server.

```
┌─────────────────────────────────────────────┐
│  Kubernetes Cluster (EKS)                   │
│                                             │
│  ┌─────────────────┐   ┌─────────────────┐  │
│  │  keda-operator  │──▶│  Managed HPA    │  │
│  │                 │   │  (auto-created) │  │
│  └────────┬────────┘   └────────┬────────┘  │
│           │                     │           │
│           │ polls queue depth   │ scales    │
│           ▼                     ▼           │
│  ┌─────────────────┐   ┌─────────────────┐  │
│  │ keda-metrics-   │   │  Your Deployment│  │
│  │ apiserver       │   │  (e.g. worker)  │  │
│  └─────────────────┘   └─────────────────┘  │
└─────────────────────────────────────────────┘
              │
              ▼
     Amazon SQS Queue
```

## Deploying KEDA with Helmfile

I manage all cluster-level tooling with [Helmfile](https://helmfile.readthedocs.io). KEDA gets its own application directory under `applications/keda/`.

### `helmfile.yaml`

```yaml
repositories:
  - name: kedacore
    url: https://kedacore.github.io/charts

releases:
  - name: keda
    namespace: keda
    chart: kedacore/keda
    version: 2.18.3
    installed: true
    createNamespace: true
    timeout: 300
    values:
      - keda.values.yaml.gotmpl
```

### `keda.values.yaml.gotmpl`

The values file pins image tags, sets resource limits, and hardens the security context. All three KEDA components (operator, metrics API server, admission webhooks) run as non-root with a read-only root filesystem and all Linux capabilities dropped.

```yaml
image:
  keda:
    repository: ghcr.io/kedacore/keda
    tag: 2.18.3
  metricsApiServer:
    repository: ghcr.io/kedacore/keda-metrics-apiserver
    tag: 2.18.3
  webhooks:
    repository: ghcr.io/kedacore/keda-admission-webhooks
    tag: 2.18.3

resources:
  operator:
    limits:
      cpu: 1000m
      memory: 2048Mi
    requests:
      cpu: 100m
      memory: 256Mi
  metricServer:
    limits:
      cpu: 1000m
      memory: 1000Mi
    requests:
      cpu: 100m
      memory: 100Mi
  webhooks:
    limits:
      cpu: 500m
      memory: 500Mi
    requests:
      cpu: 50m
      memory: 50Mi

podSecurityContext:
  operator:
    runAsNonRoot: true
    runAsUser: 1000
    fsGroup: 1000
  metricServer:
    runAsNonRoot: true
    runAsUser: 1000
    fsGroup: 1000

securityContext:
  operator:
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities:
      drop:
        - ALL

webhooks:
  enabled: true
  failurePolicy: Ignore

upgradeStrategy:
  operator:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1
```

Setting `webhooks.failurePolicy: Ignore` means that if the admission webhook pod is unavailable, deployments aren't blocked — important for cluster bootstrapping and webhook pod restarts.

Deploy with:

```bash
helmfile apply --file applications/keda/helmfile.yaml
```

Verify the pods are running:

```bash
kubectl get pods -n keda
# NAME                                               READY   STATUS    RESTARTS   AGE
# keda-admission-webhooks-xxxxx                      1/1     Running   0          2m
# keda-operator-xxxxx                                1/1     Running   0          2m
# keda-operator-metrics-apiserver-xxxxx              1/1     Running   0          2m
```

## IAM Authentication with EKS Pod Identity

KEDA needs to call `sqs:GetQueueAttributes` to read the queue depth. On EKS, the cleanest way to grant this without static credentials is [EKS Pod Identity](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html) — the newer successor to IRSA. Rather than annotating a ServiceAccount with a role ARN, you create a **Pod Identity association** in EKS that maps a namespace + ServiceAccount to an IAM role. The EKS Pod Identity agent (a DaemonSet) then intercepts credential requests from the pod and vends short-lived STS credentials automatically.

Here is how the full chain works end to end, including role chaining:

```
EKS Pod Identity association
    ↕  maps keda-operator ServiceAccount → keda-operator IAM role
keda-operator IAM role (SQS policy attached)
    ↕  trust policy allows pods.eks.amazonaws.com + sts:AssumeRole from keda-operator role
keda-identity IAM role (SQS policy attached, targetRoleArn in association)
    ↕  EKS Pod Identity agent injects credentials into pod
keda-operator Pod
    ↕  TriggerAuthentication podIdentity: aws tells KEDA to use those credentials
ScaledObject → polls SQS queue depth
```

The Pod Identity association specifies both a `roleArn` (`keda-operator`) and a `targetRoleArn` (`keda-identity`). This two-role split is the [AWS-recommended pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/event-driven-auto-scaling-with-eks-pod-identity-and-keda.html) and is intentional:

| Role | Purpose |
|---|---|
| `keda-operator` | The KEDA operator pod's own AWS identity. Holds the EKS-facing trust boundary (`pods.eks.amazonaws.com`). Should have minimal or no SQS permissions. |
| `keda-identity` | The identity KEDA assumes *on behalf of scalers* when polling SQS. This is what `TriggerAuthentication` with `podIdentity: aws` actually uses. Holds the SQS read permissions. |

Separating the two roles means the operator's core identity stays clean, and the scaling permissions can be scoped, rotated, or swapped independently — particularly useful if you later need different `keda-identity` roles per workload or per AWS account.

### 1. Create the IAM policy

Attach this policy to both roles (or use the AWS managed `AmazonSQSReadOnlyAccess` policy):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl",
        "sqs:ListQueues"
      ],
      "Resource": "arn:aws:sqs:<region>:<account-id>:<queue-prefix>-*"
    }
  ]
}
```

### 2. Create the IAM roles with trust policies

**`keda-operator` role** — trusted by the EKS Pod Identity service:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "pods.eks.amazonaws.com"
      },
      "Action": [
        "sts:AssumeRole",
        "sts:TagSession"
      ]
    }
  ]
}
```

**`keda-identity` role** — trusted by the `keda-operator` role (role chaining) and by the Pod Identity service:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::<account-id>:role/keda-operator",
        "Service": "pods.eks.amazonaws.com"
      },
      "Action": [
        "sts:AssumeRole",
        "sts:TagSession"
      ]
    }
  ]
}
```

### 3. Create the Pod Identity association

Unlike IRSA, **no annotation on the ServiceAccount is needed**. Instead, create the association via the AWS CLI, specifying `roleArn` (the EKS-facing role) and `targetRoleArn` (the role with actual permissions):

```bash
aws eks create-pod-identity-association \
  --cluster-name <cluster-name> \
  --namespace keda \
  --service-account keda-operator \
  --role-arn arn:aws:iam::<account-id>:role/keda-operator \
  --target-role-arn arn:aws:iam::<account-id>:role/keda-identity \
  --no-cli-pager
```

Verify it with:

```bash
aws eks list-pod-identity-associations \
  --cluster-name <cluster-name> \
  --namespace keda \
  --no-cli-pager
```

The EKS Pod Identity agent DaemonSet (installed separately via the `eks-pod-identity-agent` addon) intercepts credential requests from the pod and exchanges them for short-lived STS credentials scoped to the `keda-identity` role. KEDA then uses those credentials when calling SQS.

### 4. Tell KEDA to use the pod identity

The final piece is the `TriggerAuthentication` object in the application namespace. Setting `podIdentity.provider: aws` tells KEDA to use the credentials injected by the Pod Identity agent rather than looking for a static secret:

```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: sqs-trigger-auth
  namespace: my-worker-namespace
spec:
  podIdentity:
    provider: aws
```

The `ScaledObject` then references this by name via `authenticationRef`. Without this object, KEDA would try to call SQS unauthenticated and fail.

## Configuring the ScaledObject

With KEDA running and IAM wired up, the remaining application-level piece is the `ScaledObject`, which binds the SQS queue to the deployment:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: sqs-scaledobject
  namespace: my-worker-namespace
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-worker
  pollingInterval:  10   # check queue depth every 10s
  cooldownPeriod:   60   # wait 60s before scaling in
  minReplicaCount:  1
  maxReplicaCount:  10
  triggers:
  - type: aws-sqs-queue
    name: sqs-trigger
    authenticationRef:
      name: sqs-trigger-auth   # references the TriggerAuthentication created above
    metadata:
      queueURL: https://sqs.<region>.amazonaws.com/<account-id>/my-worker-queue
      queueLength: "5"   # target messages per replica
      awsRegion: <region>
```

The `queueLength: "5"` means KEDA targets 5 messages per replica — you can set `minReplicaCount: 0` if you want true scale-to-zero, or keep it at 1 to always have a ready consumer.

### How the replica count is calculated

KEDA divides the current queue depth by the `queueLength` target and rounds up:

```
desired replicas = ceil(queue depth / queueLength)
```

With `queueLength: 5` and 37 messages in the queue:

```
ceil(37 / 5) = 8 replicas
```

With 50 messages it would hit the `maxReplicaCount` of 10. With 0 messages and `minReplicaCount: 1`, it holds at 1.

## How It All Fits Together

Here is the full picture of every component and how they connect at runtime:

```
AWS
┌──────────────────────────────────────────────────────────────────┐
│                                                                  │
│  keda-operator role ──[2] assumes──► keda-identity role          │
│  (trust: pods.eks.amazonaws.com)     (SQS read permissions)      │
│         ▲                                     │                  │
└─────────┼─────────────────────────────────────┼──────────────────┘
          │                                     │
          │ [1] Pod Identity association        │ [3] vends temp
          │     maps SA → keda-operator role    │     credentials
          │                                     │
EKS Cluster
┌──────────┼─────────────────────────────────────┼──────────────────┐
│          │                                     │                  │
│  ┌───────┴──────────── keda namespace ─────────▼──────────────┐  │
│  │                                                            │  │
│  │  keda-operator ServiceAccount                              │  │
│  │    │                                                       │  │
│  │    │  Pod Identity agent (DaemonSet on each node)          │  │
│  │    │  intercepts credential request from the pod,          │  │
│  │    │  exchanges it for keda-identity temp credentials      │  │
│  │    │                                                       │  │
│  │    ▼                                                       │  │
│  │  keda-operator pod                                         │  │
│  │    │                                                       │  │
│  │    ├──[4] sqs:GetQueueAttributes ──────────────────────────┼──┼──► SQS Queue
│  │    │       (using keda-identity creds)                     │  │
│  │    ├──[5] reads ScaledObject + TriggerAuthentication       │  │
│  │    │       (from app namespace via cluster-wide RBAC)      │  │
│  │    ├──[6] ceil(queueDepth / queueLength) = desired replicas│  │
│  │    │                                                       │  │
│  │    └──[7] updates HPA in app namespace                     │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─────────────────── app namespace ──────────────────────────┐  │
│  │                                                            │  │
│  │  TriggerAuthentication (sqs-trigger-auth)                  │  │
│  │    podIdentity: aws                                        │  │
│  │    └── "use whatever AWS creds the keda-operator pod has"  │  │
│  │    ▲                                                       │  │
│  │    └── referenced by                                       │  │
│  │                                                            │  │
│  │  ScaledObject                                              │  │
│  │    authenticationRef: sqs-trigger-auth                     │  │
│  │    queueLength: 5                                          │  │
│  │    │                                                       │  │
│  │    └──[7] manages                                          │  │
│  │                                                            │  │
│  │  HPA  (owned by KEDA — do not edit directly)               │  │
│  │    │                                                       │  │
│  │    └──[8] scales                                           │  │
│  │                                                            │  │
│  │  Deployment → Pods (your app)                              │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### What each object is responsible for

| Object | "I am the..." | Lives in |
|---|---|---|
| `TriggerAuthentication` | ...auth config — *how* to authenticate to SQS | App namespace |
| `ScaledObject` | ...scaling config — *what* to scale and *when* | App namespace |
| Pod Identity association | ...AWS-side mapping of ServiceAccount → IAM role | AWS EKS API |
| HPA | ...actual Kubernetes scaler, managed by KEDA — don't edit directly | App namespace |

The `TriggerAuthentication` and `ScaledObject` live in the app namespace deliberately — the app team owns them without needing access to the `keda` namespace. The KEDA operator has cluster-wide RBAC to read them from any namespace.

## HPA vs KEDA: When to Use Each

| Concern | HPA | KEDA |
|---|---|---|
| Scale on CPU / memory | ✓ | ✓ (via CPU scaler) |
| Scale on queue depth | ✗ | ✓ |
| Scale to zero | ✗ | ✓ |
| Custom external metrics | Complex (custom metrics API) | Built-in scalers |
| Works alongside existing HPA | N/A | ✓ (manages HPA internally) |

KEDA doesn't replace HPA — it wraps it. If you already have HPA objects on a deployment that you want KEDA to manage, you need to remove them first; KEDA will create its own.

## Verifying the ScaledObject

```bash
kubectl describe scaledobject sqs-scaledobject -n my-worker-namespace
```

Look for the `Active` and `Ready` conditions in the output:

```
Conditions:
  Type            Status  Reason              Message
  ----            ------  ------              -------
  AbleToScale     True    SucceededGetScale   ...
  ScalingActive   True    ValidTriggerFound   ...
  ScalingLimited  False   DesiredWithinRange  ...
```

Watch scaling in real time:

```bash
kubectl get hpa -n my-worker-namespace -w
```

## Summary

HPA is the right tool for stateless services under CPU load. For event-driven workers consuming from SQS, KEDA gives you queue-depth-aware scaling with minimal configuration. The `TriggerAuthentication` + `ScaledObject` pattern is clean, and EKS Pod Identity keeps credentials out of the equation entirely — no ServiceAccount annotations, no OIDC plumbing, just a Pod Identity association and the agent DaemonSet.

Managing KEDA via Helmfile makes it a versioned, reproducible cluster-level dependency that deploys consistently across environments.

## Resources

- [GitHub](https://github.com/ItsVigneshMurugan/Keda-EKS-SQS)
- [KEDA Documentation](https://keda.sh/docs/)
- [KEDA AWS SQS Scaler](https://keda.sh/docs/scalers/aws-sqs/)
- [KEDA GitHub](https://github.com/kedacore/keda)
- [Helmfile](https://helmfile.readthedocs.io)
- [EKS Pod Identity Documentation](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html)
- [EKS Pod Identity Agent Addon](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-agent-setup.html)
