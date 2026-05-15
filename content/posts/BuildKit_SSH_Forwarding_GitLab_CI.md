---
title: "BuildKit SSH Forwarding in GitLab CI/CD"
date: 2026-05-15T00:00:00Z
draft: false
tags: ['docker', 'buildkit', 'gitlab', 'ci-cd', 'ssh', 'devops']
---

When a Dockerfile needs to pull from a private Git repository — a private Go module proxy, a private pip package, or a private npm registry — the instinct is often to copy a deploy key into the image or pass a token as a build argument. Both approaches are risky: secrets end up in intermediate image layers and can be extracted from the final image.

BuildKit's SSH forwarding solves this cleanly. Instead of embedding a key, you forward the host's SSH agent socket into the build context for the duration of a single `RUN` step. The private key never touches the image.

## How It Works

```
GitLab CI Runner
│
├── ssh-agent (loaded with SSH_PRIVATE_KEY)
│       │  (SSH_AUTH_SOCK socket)
│       ▼
├── docker build --ssh default
│       │
│       └── BuildKit daemon
│               │
│               └── RUN --mount=type=ssh ...
│                       │
│                       └── git clone git@gitlab.com:...
│                               │
│                               └── SSH auth via forwarded socket
│                                   (key never written to image layer)
```

The `--ssh default` flag tells BuildKit to expose the host's SSH agent (identified as `default`) to the build. Inside the Dockerfile, `--mount=type=ssh` mounts the agent socket only for that `RUN` step. Once the step completes, the socket is gone — it is never committed into any layer.

## GitLab CI Configuration

Add your private key as a **File** type CI/CD variable — for example, `SSH_PRIVATE_KEY`. File type variables are written to a temp path on the runner rather than being injected as environment strings, which makes them easier to work with `ssh-add`.

```yaml
build_image:
  image: docker:latest
  services:
    - docker:dind
  variables:
    DOCKER_BUILDKIT: "1"
  before_script:
    - eval $(ssh-agent -s)
    - chmod 400 "$SSH_PRIVATE_KEY"
    - ssh-add "$SSH_PRIVATE_KEY"
    - mkdir -p ~/.ssh
    - chmod 700 ~/.ssh
    - ssh-keyscan gitlab.com >> ~/.ssh/known_hosts
  script:
    - docker build --ssh default -t my-app:latest .
```

A few things worth noting:

- `DOCKER_BUILDKIT: "1"` enables BuildKit. Without it, `--ssh` is not understood.
- `ssh-keyscan gitlab.com >> ~/.ssh/known_hosts` is required. Without a known hosts entry, the SSH client inside the build will refuse the connection with a host verification error. Add entries for any other hosts your build needs to reach.
- `eval $(ssh-agent -s)` starts the agent and sets `SSH_AUTH_SOCK`. BuildKit reads that environment variable to locate the socket to forward.

## Dockerfile

The `# syntax=docker/dockerfile:1` directive at the top is required — it opts the Dockerfile into the BuildKit frontend, which is what understands `--mount=type=ssh`.

```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.12-slim

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

RUN --mount=type=ssh \
    git clone git@gitlab.com:my-org/private-repo.git /app/private-repo
```

The mount is scoped to that single `RUN`. If you have multiple commands that need SSH access, either combine them in one `RUN` step or add `--mount=type=ssh` to each one individually.

## Verify No Keys in the Image

After building, confirm the private key material did not land in any layer:

```bash
docker history my-app:latest
docker run --rm my-app:latest find / -name "id_rsa" -o -name "id_ed25519" 2>/dev/null
```

You can also inspect the build cache with `docker buildx imagetools inspect` or use a tool like [dive](https://github.com/wagoodman/dive) to walk the layer diff.

## Multi-Stage Builds

SSH forwarding works well with multi-stage builds. Use it in the builder stage to fetch dependencies, then copy only the artefacts into the final image:

```dockerfile
# syntax=docker/dockerfile:1
FROM golang:1.23 AS builder

WORKDIR /app

# Fetch private module — SSH key used here, never in the final image
RUN --mount=type=ssh \
    git clone git@gitlab.com:my-org/private-lib.git /deps/private-lib

COPY . .
RUN go build -o app ./cmd/server

FROM gcr.io/distroless/static
COPY --from=builder /app/app /app
ENTRYPOINT ["/app"]
```

The final distroless image has no trace of the SSH session or the build toolchain.

## Troubleshooting

**`error: ssh: Required ssh forwarding agent is not running`**  
The SSH agent socket is not reachable inside the build. Check that `eval $(ssh-agent -s)` ran and `SSH_AUTH_SOCK` is set before invoking `docker build`.

**`Host key verification failed`**  
You skipped `ssh-keyscan` or the host is not in `~/.ssh/known_hosts`. Run `ssh-keyscan <hostname> >> ~/.ssh/known_hosts` in `before_script` for every host the build connects to.

**`dockerfile parse error on line 1: unknown instruction: #`**  
The `# syntax=docker/dockerfile:1` directive must be the very first line in the Dockerfile with no blank lines before it.
