#!/usr/bin/env bash
# Bootstrap a Vast.ai Ubuntu 22.04 VM with k3s + NVIDIA + KServe (Standard mode)
# Then deploy a Qwen2.5-0.5B-Instruct InferenceService for smoke-testing.
#
# Usage on your Mac, after launching a Vast.ai VM and getting the SSH command:
#
#   ./Local-vast-setup.sh root@<host> <port>
#   # Example:
#   ./Local-vast-setup.sh root@70.30.158.46 14502
#
# Or run it directly on the VM (after SCP'ing it there):
#
#   bash Local-vast-setup.sh

set -uo pipefail

# ----- If invoked with args, just SSH and re-exec ourselves on the VM -----
if [[ $# -ge 2 && "$1" != "--on-vm" ]]; then
    HOST="$1"; PORT="$2"
    echo "[host] copying script to VM..."
    scp -P "$PORT" -o StrictHostKeyChecking=accept-new "$0" "$HOST:/root/vast-bootstrap.sh"
    echo "[host] running on VM..."
    exec ssh -t -p "$PORT" "$HOST" "bash /root/vast-bootstrap.sh --on-vm"
fi

# ----- From here on, we are on the VM -----

log() { echo -e "\n\033[1;36m[$(date +%H:%M:%S)] $*\033[0m"; }
fail() { echo -e "\033[1;31m[ERROR] $*\033[0m"; exit 1; }

[[ "$(id -u)" == "0" ]] || fail "Run as root."
command -v nvidia-smi >/dev/null || fail "nvidia-smi missing — is this a GPU VM?"

export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# 1. Stop apt's background updater so it doesn't lock dpkg --------------------
log "Stopping unattended-upgrades (disposable VM, no need to apply security patches)"
systemctl stop unattended-upgrades.service apt-daily.service apt-daily-upgrade.service 2>/dev/null || true
systemctl mask unattended-upgrades.service 2>/dev/null || true
# Kill any lingering apt processes that haven't released the lock
pkill -9 -x unattended-upgr 2>/dev/null || true
pkill -9 -x apt 2>/dev/null || true
pkill -9 -x apt-get 2>/dev/null || true
sleep 2
rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock 2>/dev/null || true
dpkg --configure -a >/dev/null 2>&1 || true

# 2. Install nvidia-container-toolkit (before k3s — it'll trigger driver/lib upgrade) --
log "Installing nvidia-container-toolkit"
apt-get update -qq
apt-get install -y -qq curl gnupg ca-certificates >/dev/null

if [[ ! -f /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg ]]; then
    curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey -o /tmp/nvidia.key
    gpg --batch --no-tty --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg /tmp/nvidia.key
    rm /tmp/nvidia.key
fi
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
    | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
    > /etc/apt/sources.list.d/nvidia-container-toolkit.list

apt-get update -qq
apt-get install -y -qq nvidia-container-toolkit >/dev/null

# 3. Reload NVIDIA kernel module (apt upgraded libs may now mismatch the running module) --
log "Reloading NVIDIA kernel module (works around driver/library version mismatch)"
if ! nvidia-smi >/dev/null 2>&1; then
    rmmod nvidia_uvm nvidia_drm nvidia_modeset nvidia 2>/dev/null || true
    sleep 2
    modprobe nvidia
    sleep 2
fi
nvidia-smi | head -3
nvidia-smi >/dev/null 2>&1 || fail "nvidia-smi still broken after module reload — try rebooting the VM"

# 4. Install k3s with traefik disabled ----------------------------------------
log "Installing k3s"
if ! command -v k3s >/dev/null; then
    curl -sfL https://get.k3s.io | sh -s - \
        --write-kubeconfig-mode 644 \
        --disable=traefik >/dev/null
fi

# 5. Tell k3s containerd to use nvidia as default runtime ---------------------
log "Configuring k3s containerd to use nvidia runtime by default"
mkdir -p /var/lib/rancher/k3s/agent/etc/containerd
cat > /var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl <<'TEMPLATE'
{{ template "base" . }}

[plugins."io.containerd.cri.v1.runtime".containerd]
  default_runtime_name = "nvidia"
TEMPLATE

log "Restarting k3s to pick up the new containerd config"
systemctl restart k3s
# Wait for API server to come back
until kubectl get nodes >/dev/null 2>&1; do sleep 2; done

# 6. NVIDIA device plugin -----------------------------------------------------
log "Installing NVIDIA Kubernetes device plugin"
kubectl apply -f https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.17.1/deployments/static/nvidia-device-plugin.yml >/dev/null

# Restart the plugin pod in case it was started before nvidia became the default runtime
kubectl delete pod -n kube-system -l name=nvidia-device-plugin-ds --ignore-not-found >/dev/null

log "Waiting for nvidia.com/gpu to be allocatable..."
until [[ "$(kubectl get node -o jsonpath='{.items[0].status.allocatable.nvidia\.com/gpu}' 2>/dev/null)" == "1" ]]; do
    sleep 5
done
echo "GPU allocatable: $(kubectl get node -o jsonpath='{.items[0].status.allocatable.nvidia\.com/gpu}')"

# 7. Clone KServe + install kustomize -----------------------------------------
log "Cloning KServe"
cd /root
[[ -d kserve ]] || git clone --depth=1 https://github.com/kserve/kserve.git
cd /root/kserve

if [[ ! -x /root/kserve/bin/kustomize ]]; then
    log "Installing kustomize (KServe install script needs it)"
    ./hack/setup/cli/install-kustomize.sh >/dev/null
fi
export PATH="/root/kserve/bin:$PATH"

# 8. Install KServe in Standard (Raw) mode via kustomize ----------------------
log "Installing KServe (Standard mode, no Knative/Istio)"
./hack/kserve-install.sh -r --kustomize 2>&1 | tail -5

# Set defaultDeploymentMode so ISVCs without an annotation work too
kubectl get configmap inferenceservice-config -n kserve -o json | \
    python3 -c "
import json, sys
cm = json.load(sys.stdin)
cm['data']['deploy'] = '{\n  \"defaultDeploymentMode\": \"RawDeployment\"\n}'
print(json.dumps(cm))
" | kubectl apply -f - >/dev/null
kubectl rollout restart deployment/kserve-controller-manager -n kserve >/dev/null
kubectl rollout status deployment/kserve-controller-manager -n kserve --timeout=120s >/dev/null

# 9. Deploy the Qwen2.5-0.5B-Instruct InferenceService ------------------------
log "Deploying Qwen2.5-0.5B-Instruct InferenceService"
kubectl create namespace kserve-test --dry-run=client -o yaml | kubectl apply -f - >/dev/null

cat <<EOF | kubectl apply -f -
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
EOF

log "Waiting for Qwen ISVC to be Ready (image pull + model load, ~5-8 min on first run)..."
until [[ "$(kubectl get isvc qwen-llm -n kserve-test -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" == "True" ]]; do
    PHASE=$(kubectl get pod -n kserve-test -l serving.kserve.io/inferenceservice=qwen-llm \
        -o jsonpath='{.items[0].status.phase}{": "}{.items[0].status.containerStatuses[0].state}' 2>/dev/null || echo "no pod yet")
    echo "[$(date +%H:%M:%S)] $(echo "$PHASE" | head -c 180)"
    sleep 20
done

# 10. Smoke-test inference ----------------------------------------------------
# Note: vLLM's first inference request after pod start hits torch.compile for
# the actual prompt shape and can take ~30s. Subsequent requests are fast.
# We warm up with a throwaway request, then run the real smoke test.
log "Warming up vLLM (first request hits compilation, ~30s)"
SVC_IP=$(kubectl get svc qwen-llm-predictor -n kserve-test -o jsonpath='{.spec.clusterIP}')
curl -sm 90 -H "Content-Type: application/json" \
    -d '{"model":"qwen","messages":[{"role":"user","content":"warmup"}],"max_tokens":5}' \
    "http://${SVC_IP}/openai/v1/chat/completions" > /dev/null

log "Smoke-testing inference"
curl -sm 30 -H "Content-Type: application/json" \
    -d '{"model":"qwen","messages":[{"role":"user","content":"Say hi in one sentence."}],"max_tokens":40}' \
    "http://${SVC_IP}/openai/v1/chat/completions" | python3 -m json.tool | head -20

cat <<'DONE'

------------------------------------------------------------
✅ KServe + Qwen 2.5 ready.

To hit it from your Mac (the -L 8080:localhost:8080 in your
SSH command already tunnels this), run on the VM:

    kubectl port-forward -n kserve-test svc/qwen-llm-predictor 8080:80

Then from your Mac:

    curl -s http://localhost:8080/openai/v1/chat/completions \
      -H "Content-Type: application/json" \
      -d '{"model":"qwen","messages":[{"role":"user","content":"Hello"}],"max_tokens":50}' | jq

⚠️  Don't forget to DESTROY the Vast.ai instance when you're done.
------------------------------------------------------------
DONE
