---
title: "Building a DevOps AI Agent on Kubernetes with kagent, AWS Bedrock and GitLab MCP"
date: 2026-04-24T00:00:00Z
draft: false
tags: ['kagent', 'kubernetes', 'aws', 'bedrock', 'gitlab', 'ai-agents', 'mcp', 'kind', 'devops']
---

AI agents are moving fast, but running them reliably in production means infrastructure matters. In this post, I walk through deploying [kagent](https://kagent.dev) — a Kubernetes-native AI agent framework — on a local Kind cluster, configuring AWS Bedrock as the LLM provider, and integrate GitLab MCP server so the agent can interact with GitLab issues, pipelines, merge requests, and repositories. 

kagent also ships with built-in Kubernetes tools — so the same agent can run kubectl operations, inspect pod logs, and investigate cluster issues without any extra setup.

## What is kagent?

kagent is a CNCF sandbox project that lets you define AI agents as Kubernetes custom resources. Agents can use any MCP (Model Context Protocol) tool server, any supported LLM provider, and communicate with each other using the A2A (Agent-to-Agent) protocol.

```
┌──────────────────────────────────────────────────────────┐
│  Kubernetes Cluster (Kind)                               │
│                                                          │
│  ┌──────────────┐    ┌───────────────┐    ┌──────────┐   │
│  │  Controller  │───▶│  Agent Pod    │───▶│ MCP Tool │   │
│  │  (Go)        │    │  (Python ADK) │    │ Server   │   │
│  └──────────────┘    └───────────────┘    └──────────┘   │
│         │                                      │         │
│         ▼                                      ▼         │
│  ┌──────────────┐                    ┌──────────────┐    │
│  │  SQLite/PG   │                    │  GitLab MCP  │    │
│  │  (Sessions)  │                    │  (zereight)  │    │
│  └──────────────┘                    └──────────────┘    │
└──────────────────────────────────────────────────────────┘
              │
              ▼
     AWS Bedrock (ap-southeast-2)
     Claude Sonnet via IAM credentials
```

## Prerequisites

- Kind v0.27.0+
- Docker with buildx
- kubectl, helm, make
- AWS credentials with Bedrock access in `ap-southeast-2`

## Setting Up the Local Cluster

> **Note:** The official [kagent quickstart](https://kagent.dev/docs/kagent/getting-started/quickstart) installs kagent using a one-liner `helm install` against an existing cluster. I'm using the `make` commands from the repo instead because I'm building from source — the Makefile handles building the Docker images, pushing them to the local Kind registry, and deploying via Helm in one step. If you just want to run kagent without modifying it, follow the quickstart guide and skip straight to the provider and MCP sections below.

```bash
make create-kind-cluster
make use-kind-cluster
```

The `create-kind-cluster` script sets up a Kind cluster and a local Docker registry on `localhost:5001`. One thing to watch: the registry container must be started with the host port binding (`-p 127.0.0.1:5001:5000`). If you have an existing `kind-registry` container without that binding, recreate it:

```bash
docker rm -f kind-registry
bash scripts/kind/setup-kind.sh
```

To verify the registry is reachable:
```bash
curl http://localhost:5001/v2/_catalog
# {"repositories":["kagent-dev/kagent/controller","kagent-dev/kagent/ui","kagent-dev/kagent/app"]}
```

## Configuring AWS Bedrock as the Provider

kagent ships with providers for OpenAI, Anthropic, Azure OpenAI, Gemini, and Ollama out of the box. 

Bedrock uses IAM credentials. Store your AWS credentials as a Kubernetes secret:

```bash
kubectl create secret generic bedrock-credentials -n kagent \
  --from-literal=AWS_ACCESS_KEY_ID=<your-key-id> \
  --from-literal=AWS_SECRET_ACCESS_KEY=<your-secret-key>
```

Then create a ModelConfig pointing at your Bedrock model:

```yaml
apiVersion: kagent.dev/v1alpha2
kind: ModelConfig
metadata:
  name: bedrock-claude
  namespace: kagent
spec:
  provider: Bedrock
  model: au.anthropic.claude-sonnet-4-6
  apiKeySecret: bedrock-credentials
  bedrock:
    region: ap-southeast-2
```

Deploy with Bedrock as the default provider:

```bash
make helm-install-provider KAGENT_DEFAULT_MODEL_PROVIDER=bedrock
```

## Running GitLab MCP in-cluster with KMCP

[KMCP](https://github.com/kagent-dev/kmcp) is kagent's MCP server manager — it deploys and manages MCP server pods in Kubernetes via a `MCPServer` CRD.

I wanted to run the [`zereight050/gitlab-mcp`](https://hub.docker.com/r/zereight050/gitlab-mcp) container in-cluster with Streamable HTTP transport. The correct `MCPServer` spec — after learning the actual CRD schema with `kubectl explain` — looks like this:

```yaml
apiVersion: kagent.dev/v1alpha1
kind: MCPServer
metadata:
  name: gitlab-mcp
  namespace: kagent
spec:
  transportType: http
  httpTransport:
    targetPort: 3002       # note: targetPort, not port
  deployment:
    image: zereight050/gitlab-mcp
    port: 3002
    env:
      HOST: "0.0.0.0"
      STREAMABLE_HTTP: "true"
      USE_GITLAB_WIKI: "true"
      USE_MILESTONE: "true"
      USE_PIPELINE: "true"
    secretRefs:
      - name: gitlab-mcp-credentials  # injects all keys as env vars
```

Store GitLab credentials in a secret:

```bash
kubectl create secret generic gitlab-mcp-credentials -n kagent \
  --from-literal=GITLAB_PERSONAL_ACCESS_TOKEN=<your-pat> \
  --from-literal=GITLAB_API_URL=https://git.yourcompany.com/api/v4
```

## Wiring it Together: The DevOps Agent

KMCP discovered the GitLab MCP tools but didn't automatically create a `RemoteMCPServer` resource for them. To connect the agent, I created one manually:

```bash
kubectl apply -f - <<EOF
apiVersion: kagent.dev/v1alpha2
kind: RemoteMCPServer
metadata:
  name: gitlab-mcp
  namespace: kagent
spec:
  url: "http://gitlab-mcp.kagent:3002/mcp"
  description: "GitLab MCP Server for CI/CD, issues, pipelines and wikis"
EOF
```

Then the agent definition:

```yaml
apiVersion: kagent.dev/v1alpha2
kind: Agent
metadata:
  name: devops-agent
  namespace: kagent
spec:
  description: DevOps agent for GitLab, Kubernetes and infrastructure operations
  type: Declarative
  declarative:
    modelConfig: default-model-config
    systemMessage: |
      You are a DevOps agent. You help with GitLab, Kubernetes, and infrastructure tasks.
      # Instructions
      - Always check current state before making changes
      - Explain your reasoning before executing
      - Never delete resources without confirmation
      # Response Format
      - Use markdown
      - Summarize actions taken
    tools:
    - type: McpServer
      mcpServer:
        name: gitlab-mcp
        kind: RemoteMCPServer
        apiGroup: kagent.dev
```

## Verifying Everything Works

```bash
# Check agents are running
kubectl get agent -n kagent

# Check the RemoteMCPServer discovered tools
kubectl get remotemcpserver gitlab-mcp -n kagent -o jsonpath='{.status.discoveredTools[*].name}'

# Tail agent logs to see MCP calls
kubectl logs -n kagent -l kagent.dev/agent-name=devops-agent -f

# Open the UI
kubectl port-forward svc/kagent-ui 8001:8080 -n kagent
open http://localhost:8001
```

When it's working you'll see log lines like:

```
INFO - HTTP Request: POST http://gitlab-mcp.kagent:3002/mcp "HTTP/1.1 200 OK"
INFO - Negotiated protocol version: 2025-11-25
INFO - HTTP Request: POST http://gitlab-mcp.kagent:3002/mcp "HTTP/1.1 200 OK"
```

## What's Next

- **Event-driven incident investigation with GlitchTip.** The same DevOps agent can be triggered automatically from error tracking. GlitchTip (Sentry-compatible) supports outbound webhooks — point one at a small adapter service that translates the GlitchTip payload into an A2A task for the devops-agent. The agent then investigates autonomously: pulls pod logs with `kubectl`, searches GitLab for the culprit file, checks recent commits, and posts a root cause summary and fix suggestion to Slack. Write operations (creating a GitLab issue or MR) can be gated behind human approval using kagent's built-in HITL support — the Slack message includes an **[Approve]** button that resumes the agent task when clicked. No one needs to watch the kagent UI; the investigation comes to the engineer.
