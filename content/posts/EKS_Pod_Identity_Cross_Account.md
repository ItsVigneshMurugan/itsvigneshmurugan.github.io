---
title: "Cross-Account AWS Access from EKS Pods Using Pod Identity"
date: 2026-05-14T00:00:00Z
draft: false
tags: ['eks', 'aws', 'iam', 'pod-identity', 'kubernetes', 'cdk', 'cross-account', 'security']
---

EKS Pod Identity is the modern replacement for IRSA (IAM Roles for Service Accounts). Where IRSA threads JWT tokens through OIDC to get credentials, Pod Identity uses a per-pod credential endpoint injected directly by the EKS node agent — no OIDC provider to manage, no annotation juggling. But by default it works within a single account. When your EKS cluster lives in one AWS account and your workloads need to call APIs in another, you need an extra hop.

This post walks through setting up cross-account access using Pod Identity, using a real pattern where EKS pods in a **cluster account** assume an IAM role in a separate **workload account**.

## The Problem

Our EKS cluster runs in account A. The application pods need to call AWS Bedrock, DynamoDB, S3, and Secrets Manager — but those resources are managed in account B. We want each deployment (MR review environment, staging, production) to have its own scoped IAM role in account B, so a buggy MR can't accidentally touch staging data.

```
┌─────────────────────────────┐       ┌────────────────────────────────────┐
│  Account A (EKS cluster)    │       │  Account B (workload account)      │
│                             │       │                                    │
│  ┌──────────────────────┐   │       │  ┌──────────────────────────────┐  │
│  │  EKS Pod             │   │  STS  │  │  my-app-task-{branch}        │  │
│  │  (app container)     │───┼──────▶│  │  (IAM Role)                  │  │
│  └──────────────────────┘   │       │  │  Bedrock, DynamoDB, S3, KMS  │  │
│           │                 │       │  └──────────────────────────────┘  │
│           │ Pod Identity    │       │                                    │
│           ▼                 │       └────────────────────────────────────┘
│  ┌──────────────────────┐   │
│  │  my-app-pod-base     │   │
│  │  (base IAM role)     │   │
│  │  AssumeRole → acct B │   │
│  └──────────────────────┘   │
│           │                 │
│  EKS Pod Identity Agent     │
│  (injects credential URI)   │
└─────────────────────────────┘
```

The flow:

1. Pod Identity agent on the EKS node injects `AWS_CONTAINER_CREDENTIALS_FULL_URI` into the pod
2. App's AWS SDK calls that endpoint → gets credentials for the **base role** in account A
3. App calls `sts:AssumeRole` on the **task role** in account B using those base credentials
4. All subsequent AWS SDK calls use the task role credentials

## Prerequisites

- EKS cluster with the Pod Identity agent add-on enabled (`eks-pod-identity-agent`)
- AWS CDK v2 (or Terraform equivalent) with credentials for both accounts
- The EKS cluster name (used in the Pod Identity Association)

## Step 1: The Task Role in Account B

This is the role the application actually uses. It needs:
- A trust policy allowing `pods.eks.amazonaws.com` **from account A** to assume it with `sts:AssumeRole` + `sts:TagSession`
- The permissions the app needs (Bedrock, DynamoDB, etc.)

```typescript
// In account B (workload account)
const role = new Role(this, 'TaskRole', {
  roleName: `my-app-task-${branch}`,
  assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'), // kept for ECS compatibility
});

// Add cross-account Pod Identity trust
// sts:AssumeRole and sts:TagSession must be separate statements when using
// an ExternalId condition — ExternalId only applies to AssumeRole, not TagSession.
role.assumeRolePolicy?.addStatements(
  new PolicyStatement({
    sid: 'PodBaseRoleTrust',
    actions: ['sts:AssumeRole'],
    principals: [
      new ArnPrincipal(
        `arn:aws:iam::<EKS-ACCOUNT>:role/my-app-pod-base-${branch}`
      ),
    ],
    conditions: {
      StringEquals: {
        'sts:ExternalId': `<AWS-REGION>/<EKS-ACCOUNT>/<CLUSTER-NAME>/my-app-namespace/my-app-sa`,
      },
    },
  }),
  new PolicyStatement({
    sid: 'PodBaseRoleTagSession',
    actions: ['sts:TagSession'],
    principals: [
      new ArnPrincipal(
        `arn:aws:iam::<EKS-ACCOUNT>:role/my-app-pod-base-${branch}`
      ),
    ],
  })
);
```

Note: EKS Pod Identity requires **both** `sts:AssumeRole` and `sts:TagSession` in the trust policy. Omitting `sts:TagSession` causes a silent failure where the assume-role call is rejected without a useful error message.

**Confused deputy protection with ExternalId.** AWS recommends adding an `sts:ExternalId` condition to the `sts:AssumeRole` statement. The confused deputy problem is where an entity without permission to perform an action coerces a more-privileged entity into doing it on its behalf. EKS Pod Identity automatically injects the external ID into the cross-account `AssumeRole` call using this format:

```
<region>/<eks-account-id>/<cluster-name>/<namespace>/<service-account>
```

Because `sts:ExternalId` only applies to `AssumeRole` (not `TagSession`), the two actions must be in separate statements. You can't combine them and add the condition in a single `PolicyStatement` — doing so would either reject tag sessions or let assume-role calls through without the ID check.

The task role also needs a policy with the app's required permissions:

```typescript
const policyDoc = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'BedrockAccess',
      Effect: 'Allow',
      Action: ['bedrock:*'],
      Resource: '*',
    },
    {
      Sid: 'DynamoDb',
      Effect: 'Allow',
      Action: ['dynamodb:*'],
      Resource: [
        'arn:aws:dynamodb:*:*:table/myapp*',
        'arn:aws:dynamodb:*:*:table/myapp*/index/*'
      ],
    },
    {
      Sid: 'KmsKeys',
      Effect: 'Allow',
      Action: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'],
      Resource: [`arn:aws:kms:*:${account}:alias/myapp/*`],
    },
  ],
};
```

## Step 2: The Base Role and Pod Identity Association in Account A

In the EKS account you need two resources per deployment:

**1. A base IAM role** — trusted by the Pod Identity service, permitted to assume the task role in account B.

**2. A Pod Identity Association** — binds the base role to a specific (cluster, namespace, service account) tuple. When a pod in that namespace uses that service account, the agent automatically vends credentials for the base role.

```typescript
// In account A (EKS account)
const baseRole = new Role(this, 'MrPodBaseRole', {
  roleName: `my-app-pod-base-${branch}`,
  assumedBy: new ServicePrincipal('pods.eks.amazonaws.com'),
});

// CDK's assumedBy only adds sts:AssumeRole. Pod Identity also requires
// sts:TagSession and an aws:SourceAccount condition. Override via L1 escape hatch:
(baseRole.node.defaultChild as CfnRole).assumeRolePolicyDocument = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'EksPodIdentityTrust',
      Effect: 'Allow',
      Principal: {Service: 'pods.eks.amazonaws.com'},
      Action: ['sts:AssumeRole', 'sts:TagSession'],
      Condition: {
        StringEquals: {'aws:SourceAccount': this.account},
      },
    },
  ],
};

// Permission to assume the task role in account B
baseRole.addToPolicy(
  new PolicyStatement({
    actions: ['sts:AssumeRole', 'sts:TagSession'],
    resources: [taskRoleArn], // arn:aws:iam::<WORKLOAD-ACCOUNT>:role/my-app-task-{branch}
  })
);

// Bind the base role to the namespace + service account
new CfnPodIdentityAssociation(this, 'PodIdentityAssoc', {
  clusterName: 'my-eks-cluster',
  namespace: 'my-app-namespace',
  serviceAccount: 'default',
  roleArn: baseRole.roleArn,
});
```

The `aws:SourceAccount` condition on the trust policy is important. Without it, any EKS cluster in any account running the Pod Identity service could potentially assume your base role if they happened to know the role ARN.

## Step 3: The Application Credential Chain

When EKS Pod Identity is active, the agent sets `AWS_CONTAINER_CREDENTIALS_FULL_URI` on the pod to an endpoint like `http://169.254.170.23/v1/credentials`. This is different from the ECS container metadata endpoint (`169.254.170.2`) used by Fargate.

The standard `fromContainerMetadata` provider only handles the ECS endpoint. For EKS Pod Identity you need `fromHttp`:

```typescript
// In your credential resolution code
const isContainerEnvironment =
  process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
  process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI;

if (isContainerEnvironment) {
  if (process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI) {
    // EKS Pod Identity — uses the 169.254.170.23 endpoint
    const {fromHttp} = await import('@aws-sdk/credential-providers');
    baseProvider = fromHttp({timeout: 5000, maxRetries: 3});
  } else {
    // ECS/Fargate — uses the 169.254.170.2 endpoint
    const {fromContainerMetadata} = await import('@aws-sdk/credential-providers');
    baseProvider = fromContainerMetadata({timeout: 5000, maxRetries: 3});
  }
}
```

The base provider gives you credentials for the **base role** in account A. To automatically assume the task role in account B, wrap it with `fromTemporaryCredentials` when `TASK_ROLE_ARN` is set:

```typescript
const maybeWrapWithTaskRole = async (
  base: AwsCredentialIdentityProvider
): Promise<AwsCredentialIdentityProvider> => {
  const taskRoleArn = process.env.TASK_ROLE_ARN;
  if (!taskRoleArn) return base;

  const {fromTemporaryCredentials} = await import('@aws-sdk/credential-providers');
  return fromTemporaryCredentials({
    masterCredentials: base,
    params: {
      RoleArn: taskRoleArn,
      RoleSessionName: 'my-app',
    },
  });
};
```

`TASK_ROLE_ARN` is injected at pod startup — the `TaskRoleStack` emits the role ARN as a CloudFormation output, the startup script reads it at boot and sets it in the environment before the app starts.

## Step 4: Deploying Both Stacks

Both stacks need to be deployed into their respective accounts. In a GitLab CI pipeline:

```yaml
# Task role stack → account B (workload account)
deploy:mr:cdk:task-role:
  variables:
    CDK_ENVIRONMENT: development
    CDK_STACK_PREFIX: "MR-${CI_MERGE_REQUEST_IID}-"
    CDK_TASK_ROLE_EKS_SOURCE_ACCOUNT: "<EKS-ACCOUNT>"
    AWS_ACCESS_KEY_ID: $WORKLOAD_ACCOUNT_CDK_KEY
    AWS_SECRET_ACCESS_KEY: $WORKLOAD_ACCOUNT_CDK_SECRET
  script:
    - node cdk/scripts/deploy.js AppTaskRole-development

# Pod identity stack → account A (EKS account)
deploy:mr:cdk:pod-identity:
  needs: [deploy:mr:cdk:task-role]  # task role ARN must exist first
  variables:
    CDK_ENVIRONMENT: development
    CDK_STACK_PREFIX: "MR-${CI_MERGE_REQUEST_IID}-"
    CDK_POD_IDENTITY_ACCOUNT: "<EKS-ACCOUNT>"
    KUBE_NAMESPACE: $KUBE_NAMESPACE
    AWS_ACCESS_KEY_ID: $EKS_ACCOUNT_CDK_KEY
    AWS_SECRET_ACCESS_KEY: $EKS_ACCOUNT_CDK_SECRET
  script:
    - node cdk/scripts/deploy.js AppMrPodIdentity-development
```

Deploy task role first — the Pod Identity stack needs the task role ARN to wire the `sts:AssumeRole` permission and to construct the trust policy in the base role.

## Gotchas

**`fromContainerMetadata` does not handle Pod Identity.** The two credential endpoints are different IP addresses. Always check `AWS_CONTAINER_CREDENTIALS_FULL_URI` first and route to `fromHttp`. If you use `fromContainerMetadata` unconditionally, EKS pods will silently fall back to instance metadata credentials instead of the pod identity role.

**The Pod Identity Association is per (cluster, namespace, service account).** If your MR pods run in a shared namespace under the `default` service account, concurrent MRs will overwrite each other's association. Either use a unique service account per MR or a unique namespace.

## Verification

```bash
# Confirm the pod is picking up Pod Identity credentials (not instance metadata)
kubectl exec -n my-namespace my-pod -- env | grep AWS_CONTAINER

# Should print:
# AWS_CONTAINER_CREDENTIALS_FULL_URI=http://169.254.170.23/v1/credentials
# AWS_CONTAINER_AUTHORIZATION_TOKEN=...

# Confirm which role the pod is actually running as
kubectl exec -n my-namespace my-pod -- aws sts get-caller-identity
# {
#   "UserId": "AROAXXXXXXXXXXXXXXXXX:my-app",
#   "Account": "<WORKLOAD-ACCOUNT>",
#   "Arn": "arn:aws:sts::<WORKLOAD-ACCOUNT>:assumed-role/my-app-task-my-branch/my-app"
# }

# Confirm Bedrock access works from the assumed role
kubectl exec -n my-namespace my-pod -- \
  aws bedrock list-foundation-models --region ap-southeast-2 --query 'modelSummaries[0].modelId'
```
