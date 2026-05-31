---
title: "Deploying a KServe LLM Inference Platform on a Rented GPU VM (Vast.ai + k3s + vLLM)"
date: 2026-05-31T00:00:00Z
draft: false
image: /images/kserve-llm-vast-hero.png
alt: "KServe LLM Inference on a Rented GPU — Vast.ai + k3s + vLLM + Qwen 2.5, $0.24 total"
tags: ['kserve', 'vllm', 'k3s', 'kubernetes', 'gpu', 'vast-ai', 'huggingface', 'llm', 'inference']
---

I wanted to test [KServe](https://github.com/kserve/kserve)'s LLM inference stack — `huggingfaceserver`, vLLM, and the new `LLMInferenceService` CRD — but the moment you touch any of those you need an NVIDIA GPU. My Mac is Apple Silicon. KServe's `huggingfaceserver` image is amd64-only and hard-pinned to CUDA.

I didn't want to buy a GPU just to kick the tyres. So: **rent one for an hour, see if the runtime even works, decide later.** This post is the playbook I landed on after a few false starts — Vast.ai VM → k3s → KServe Standard mode → Qwen 2.5 on vLLM, end-to-end in about 30 minutes.

Total spend for the working session: **$0.24 of Vast.ai credit** (across all four instances I cycled through while figuring this out).

## Why not a Mac kind cluster?

A normal Mac kind cluster works fine for everything *except* LLM inference. The KServe controllers, sklearn/xgboost runtimes, transformers, explainers — all of that is happy on `linux/arm64`. But the LLM runtime image is amd64-only:

```bash
$ docker manifest inspect kserve/huggingfaceserver:latest | grep architecture
"architecture": "amd64"
"architecture": "unknown"
```

No arm64 variant. And the CPU Dockerfile (`huggingface_server_cpu.Dockerfile`) won't build on arm64 either — `bitsandbytes` is an unconditional dependency in `pyproject.toml` and has no aarch64 wheel.

So: rent an amd64 GPU box.

## Why Vast.ai over Lambda / Paperspace / EKS

- **Lambda Cloud**: cleanest VMs, but $0.75/hr minimum, billed in chunks.
- **Paperspace**: nice UI, but more expensive for short bursts.
- **EKS with GPU node pool**: realistic prod-like setup, but cluster management overhead and a fixed control-plane fee.
- **Vast.ai**: $0.20-0.40/hr for an RTX 3060/5060 class GPU, per-second billing. Perfect for "I want to test something for an hour".

The catch: most Vast hosts run *containers*, not VMs. Containers don't allow privileged ops like `bind-mount /var/lib/kubelet` or `overlay` mounts — both of which Kubernetes needs. After bouncing off that wall (more on that below), the fix is to **specifically pick a `VM` template**. Vast has both. The VM templates are slightly pricier but behave like real machines.

## What we're building

```
┌─────────────────────────────────────────────────────────┐
│  Vast.ai VM (Ubuntu 22.04, RTX 5060 8GB)                │
│                                                         │
│  ┌────────────────────────────────────────────────┐     │
│  │ k3s (single-node, no traefik)                  │     │
│  │                                                │     │
│  │  ┌──────────────┐    ┌──────────────────────┐  │     │
│  │  │ KServe       │───▶│ qwen-llm-predictor   │  │     │
│  │  │ controller   │    │ huggingfaceserver +  │  │     │
│  │  │              │    │ vLLM + Qwen2.5-0.5B  │  │     │
│  │  └──────────────┘    └──────────────────────┘  │     │
│  │                              │                 │     │
│  │                              ▼                 │     │
│  │                     nvidia.com/gpu: 1          │     │
│  └────────────────────────────────────────────────┘     │
│                              │                          │
│                              ▼                          │
│              NVIDIA RTX 5060 (GPU passthrough)          │
└─────────────────────────────────────────────────────────┘
                          │
                          │  SSH -L 8080:localhost:8080
                          ▼
              Mac terminal (curl tests)
```

KServe runs in **Standard / RawDeployment** mode — no Knative, no Istio. The `LLMInferenceService` (`llmisvc`) CRD is RawDeployment-only anyway, so this matches the production shape it'll have.

## The gotchas (so you don't hit them)

I'll spare you the trial and error and just list the things that bit me.

### 1. Containers can't run k3s

The first Vast.ai instance I rented was the default container-style template. k3s won't run inside an unprivileged container — kubelet fails with:

```
failed to create kubelet: failed to bind-mount /var/lib/kubelet: operation not permitted
```

There's no workaround for the bind-mount restriction without privileged mode. **Filter for VM templates** (look for `Ubuntu 22.04 VM` rather than `Ubuntu 22.04`). Vast support also confirmed this in chat.

### 2. apt's `unattended-upgrades` will lock dpkg for 20 minutes

Fresh Ubuntu VMs auto-run a security-patch job in the background. While it runs, every `apt install` fails with:

```
E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process X (unattended-upgr)
```

On a disposable VM you're throwing away in an hour, applying security updates is wasted compute. Kill it:

```bash
systemctl stop unattended-upgrades.service apt-daily.service apt-daily-upgrade.service
systemctl mask unattended-upgrades.service
pkill -9 -x unattended-upgr
```

### 3. NVIDIA driver/library version mismatch after `apt install`

This was the most subtle one. The Vast.ai VM ships with the NVIDIA kernel module pre-loaded (driver `580.95.05` in my case). Installing `nvidia-container-toolkit` triggers an apt upgrade that pulls newer userspace libraries (`580.159.03`). Now the kernel module and the libs disagree:

```
$ nvidia-smi
Failed to initialize NVML: Driver/library version mismatch
NVML library version: 580.159
```

Even `nvidia-smi` breaks. The fix is to reload the kernel module so it picks up the new userland libs:

```bash
rmmod nvidia_uvm nvidia_drm nvidia_modeset nvidia
modprobe nvidia
nvidia-smi   # works again
```

A reboot would also work but uses up your Vast credit. The module reload is instant.

### 4. k3s containerd template format changed

If you've seen k3s tutorials that drop a `config.toml.tmpl` to override containerd config — that's the old format. Current k3s uses **`config-v3.toml.tmpl`**. The file even tells you, but the error you get if you use the wrong one (`Job for k3s.service failed`) doesn't:

```bash
# Correct path & format for current k3s:
cat > /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl <<'EOF'
{{ template "base" . }}

[plugins."io.containerd.cri.v1.runtime".containerd]
  default_runtime_name = "nvidia"
EOF
```

### 5. NVIDIA device plugin needs nvidia as the *default* runtime

You can register the nvidia runtime in containerd as a non-default named runtime, but then the device plugin (which deploys without specifying a runtimeClass) launches under `runc` and can't see the GPU:

```
"No devices found. Waiting indefinitely."
```

Setting `default_runtime_name = "nvidia"` in the containerd template above is what makes the plugin pod itself use nvidia and successfully enumerate GPUs.

### 6. `kserve-install.sh` needs `kustomize`, doesn't install it

`./hack/kserve-install.sh -r --kustomize` fails with:

```
/root/kserve/hack/setup/infra/manage.kserve-kustomize.sh: line 356: kustomize: command not found
```

There's a separate installer in the repo:

```bash
./hack/setup/cli/install-kustomize.sh
export PATH="$PWD/bin:$PATH"
```

### 7. The dev overlay defaults to Serverless mode

This isn't Vast-specific, just a KServe gotcha. By default an `InferenceService` without an annotation gets `Serverless` mode, which assumes Knative is installed. On a Standard-mode cluster without Knative, the ISVC sits in `Ready=False` forever.

Two fixes — annotate every ISVC, or patch the `inferenceservice-config` ConfigMap to set `RawDeployment` as the default:

```bash
kubectl edit configmap inferenceservice-config -n kserve
# Set:  "deploy": "{ \"defaultDeploymentMode\": \"RawDeployment\" }"
```

## The actual setup

I've wrapped all of this into a single bootstrap script — [`Local-vast-setup.sh`](/scripts/Local-vast-setup.sh). You run it from your Mac:

```bash
# After launching a Vast.ai Ubuntu 22.04 VM and getting the SSH command:
./Local-vast-setup.sh root@<host> <port>
```

It SCPs itself to the VM and runs end-to-end. Roughly 10-15 minutes including image pulls.

The full script handles: stopping unattended-upgrades → installing nvidia-container-toolkit → reloading the NVIDIA kernel module → installing k3s with the v3 containerd template → NVIDIA device plugin → kustomize → KServe (Standard mode) → patching the ConfigMap → deploying Qwen2.5-0.5B-Instruct → smoke-testing inference.

## Deploying the InferenceService

This is the headline YAML — straight from the KServe [first GenAI ISVC tutorial](https://kserve.github.io/website/docs/getting-started/genai-first-isvc), with one addition (the `deploymentMode` annotation, since we're on Standard mode):

```yaml
apiVersion: "serving.kserve.io/v1beta1"
kind: "InferenceService"
metadata:
  name: "qwen-llm"
  namespace: kserve-test
  annotations:
    serving.kserve.io/deploymentMode: "RawDeployment"
spec:
  predictor:
    model:
      modelFormat:
        name: huggingface
      args:
        - --model_name=qwen
      storageUri: "hf://Qwen/Qwen2.5-0.5B-Instruct"
      resources:
        limits:
          cpu: "2"
          memory: 6Gi
          nvidia.com/gpu: "1"
        requests:
          cpu: "1"
          memory: 4Gi
          nvidia.com/gpu: "1"
```

KServe schedules the predictor pod, the storage-initializer downloads the model from HuggingFace (~1.5 GB), and the kserve-container pulls `kserve/huggingfaceserver:latest-gpu` (~7 GB) — the GPU variant is selected automatically because we requested `nvidia.com/gpu`. vLLM then loads the model into GPU memory and finishes torch.compile:

```
INFO 05-31 19:37:43 [gpu_model_runner.py:4879] Model loading took 0.93 GiB memory and 3.47 seconds
INFO 05-31 19:37:58 [backends.py:391] Compiling a graph for compile range (1, 2048) takes 8.26 s
INFO 05-31 19:38:01 [monitor.py:53] torch.compile took 17.79 s in total
```

Roughly **6 minutes** from `kubectl apply` to `Ready=True` on a fresh VM (dominated by the 7 GB image pull). Subsequent restarts are near-instant.

## Hitting the model

KServe exposes vLLM's **OpenAI-compatible** chat endpoint. From the VM:

```bash
SVC_IP=$(kubectl get svc qwen-llm-predictor -n kserve-test -o jsonpath='{.spec.clusterIP}')
curl -s -H "Content-Type: application/json" \
  -d '{
    "model": "qwen",
    "messages": [{"role": "user", "content": "What is KServe in one sentence?"}],
    "max_tokens": 80
  }' \
  "http://${SVC_IP}/openai/v1/chat/completions" | jq
```

Response:

```json
{
  "id": "chatcmpl-a3beeae1b07648b6",
  "model": "qwen",
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "KServe is an open-source platform for building and deploying machine learning models that provides a comprehensive suite of tools to help developers quickly build, train, deploy, and manage their models."
    },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 37, "completion_tokens": 37, "total_tokens": 74 }
}
```

To hit it from your Mac terminal instead, the `-L 8080:localhost:8080` flag in Vast's SSH command already tunnels port 8080. Just port-forward on the VM:

```bash
# On the VM (SSH session)
kubectl port-forward -n kserve-test svc/qwen-llm-predictor 8080:80

# On the Mac (another terminal)
curl -s http://localhost:8080/openai/v1/chat/completions ...
```

## What this is good for

Once you've done this once, you have a rapidly-reproducible LLM-on-Kubernetes sandbox. Some things I'm planning to use it for:

- Trying the KServe `huggingfaceserver` runtime against different models
- Exploring `LLMInferenceService` (`llmisvc`) CRD behaviour against real vLLM
- Comparing autoscaling behaviour (KEDA vs HPA) under real load
- Trying out KV cache offloading, prefix caching, multi-LoRA — all the things the `docs/samples/llmisvc/` directory hints at

For ad-hoc LLM experimentation that doesn't need k8s at all, the same VM (without all this setup) gives you a `docker run --gpus all` environment that's much simpler. But the moment you want to exercise KServe controller logic against a real predictor, k8s on Vast.ai is genuinely the cheapest way I've found.

## Don't forget to destroy

Vast bills per second. The instance keeps running (and billing) until you explicitly destroy it from the dashboard. Easy money trap if you walk away.

```
Total cost across 4 instances while debugging: ~$0.24
Cost if you forget to destroy a single VM for 24 hours: ~$5-10
```

Worth setting yourself a reminder.
