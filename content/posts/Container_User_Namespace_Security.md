---
title: "How User Namespaces Revolutionized Container Security: Understanding UID/GID Mapping"
date: 2026-01-10T00:00:00Z
draft: false
tags: ['linux', 'containers', 'security', 'docker', 'kubernetes', 'namespaces', 'kernel']
---

If you've been running containers for a while, you might remember the early days when security researchers would regularly demonstrate container escapes. The fundamental issue wasn't just about isolation—it was about privilege. Before user namespaces, containers were process isolation without privilege isolation. Let's dive into how UID/GID mapping transformed container security.

## The Dark Ages: Pre-User Namespace Containers

Before Linux 3.8 introduced user namespaces, containers had a fundamental security flaw: **UID 0 was globally privileged**.

### The Problem

Early container systems (LXC, early Docker) worked like this:

```
Host root (UID 0)
   └── Container root (same UID 0)
```

Even with PID, mount, and network namespaces providing isolation, the kernel still saw UID 0 as UID 0. Many syscalls performed simple checks:

```c
if (uid == 0) {
    allow();
}
```

This meant that to perform essential container operations, you needed real root privileges:

- **Mount filesystems** → Required CAP_SYS_ADMIN
- **Change hostname** → Required CAP_SYS_ADMIN  
- **Create device nodes** → Required CAP_MKNOD
- **Manage PID 1** → Required init capabilities

### Why This Was Dangerous

If a container running as root was compromised:

- **Kernel bugs** → Full host root access
- **Misconfigured mounts** → Direct host filesystem access
- **Device nodes** → Raw disk access
- **Privileged syscalls** → Easy container escape

Containers provided process isolation, but not privilege isolation. The kernel had no way to differentiate between "root in container" and "root on host."

## The Breakthrough: User Namespaces

User namespaces introduced a revolutionary concept: **root is contextual**.

### The Core Insight

Instead of asking "Is this UID 0?", the kernel now asks "Is this UID 0 **in this user namespace**?"

This seemingly simple change fundamentally altered container security. Root became a relative concept, not an absolute one.

### How UID/GID Mapping Works

User namespaces use mapping files to translate UIDs between the namespace and the host:

```bash
# Inside container
$ id
uid=0(root) gid=0(root) groups=0(root)

# On host
$ ps aux | grep container_process
user1000  12345  ... /bin/bash

# The mapping
$ cat /proc/12345/uid_map
         0       1000          1
# container_uid  host_uid  range
```

This creates a two-tier permission system:

```
┌─────────────────────────────────────┐
│  Inside Container                    │
│  UID: 0 (thinks it's root)          │
└──────────────┬──────────────────────┘
               │ uid_map translation
               ↓
┌─────────────────────────────────────┐
│  Host Kernel View                    │
│  UID: 1000 (unprivileged user)      │
└─────────────────────────────────────┘
```

## The Security Transformation

Let's see how UID/GID mapping blocks common container escape vectors.

### Example 1: Accessing Sensitive Host Files

**Attack Attempt:**
```bash
# Inside container as "root"
cat /etc/shadow
```

**What Happens:**

```
1. Process thinks: "I am UID 0, I can read anything"
2. Kernel translates: UID 0 → UID 1000 (via uid_map)
3. Permission check on /etc/shadow:
   - File owner: UID 0
   - Requesting process: UID 1000
   - Result: DENIED (Permission denied)
```

Even though the process sees `uid=0(root)`, the kernel enforces permissions as UID 1000.

### Example 2: Killing Host Processes

**Attack Attempt:**
```bash
# Try to kill systemd (PID 1 on host)
kill -9 1
```

**What Happens:**

```
1. Target PID 1 belongs to initial PID namespace
2. Kernel checks:
   - Caller's user namespace: container's user namespace
   - Target's user namespace: initial user namespace
   - Caller's host UID: 1000 (not 0)
3. Result: DENIED (Operation not permitted)
```

The kernel sees through the "root" facade.

### Example 3: Loading Kernel Modules

**Attack Attempt:**
```bash
# Try to load a malicious kernel module
insmod /tmp/evil.ko
```

**What Happens:**

```
1. Loading kernel modules requires CAP_SYS_MODULE
2. Container root has capabilities only in its namespace
3. Kernel checks:
   - Capability required: CAP_SYS_MODULE in initial user namespace
   - Capability held: CAP_SYS_MODULE in container user namespace
   - Match: NO
4. Result: DENIED (Operation not permitted)
```

Capabilities are namespace-scoped. Container root's capabilities don't extend to the host.

### Example 4: Creating Device Nodes

**Attack Attempt:**
```bash
# Try to create device node for raw disk access
mknod /tmp/sda b 8 0
```

**What Happens:**

```
1. Creating device nodes requires:
   - CAP_MKNOD capability
   - Permission to access the device's major/minor numbers
2. Even if CAP_MKNOD succeeds (in container namespace):
   - Opening /dev/sda requires host-level permissions
   - Container UID 0 → Host UID 1000
   - Host UID 1000 cannot access /dev/sda
3. Result: Device created but unusable
```

## The Permission Check Flow

Here's how the kernel validates operations with user namespaces:

```
Container Process Request
          ↓
┌─────────────────────────┐
│ 1. Translate UID via    │
│    /proc/PID/uid_map    │
└──────────┬──────────────┘
           ↓
┌─────────────────────────┐
│ 2. Get effective host   │
│    UID (e.g., 1000)     │
└──────────┬──────────────┘
           ↓
┌─────────────────────────┐
│ 3. Check capability in  │
│    target namespace     │
└──────────┬──────────────┘
           ↓
┌─────────────────────────┐
│ 4. Check file/resource  │
│    permissions as host  │
│    UID                  │
└──────────┬──────────────┘
           ↓
    ALLOW or DENY
```

## Practical Implementation

### Docker with User Namespaces

Enable user namespace remapping in Docker:

```bash
# /etc/docker/daemon.json
{
  "userns-remap": "default"
}
```

This creates a subordinate UID/GID mapping:

```bash
# /etc/subuid
dockremap:100000:65536

# /etc/subgid  
dockremap:100000:65536
```

Now containers run as:
- Container UID 0 → Host UID 100000
- Container UID 1 → Host UID 100001
- Container UID 1000 → Host UID 101000

### Kubernetes with User Namespaces

Kubernetes 1.25+ supports user namespaces (alpha feature):

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: userns-pod
spec:
  hostUsers: false  # Enable user namespace
  containers:
  - name: app
    image: nginx
    securityContext:
      runAsUser: 0  # Root in container
```

The pod runs as root inside, but maps to an unprivileged UID on the host.

## Limitations and Considerations

### UID/GID Range Exhaustion

Each container needs a unique UID/GID range on the host:

```bash
# If you have 100 containers, you need:
# 100 * 65536 = 6,553,600 UIDs
```

Plan your subordinate UID allocation carefully.

### File Permission Challenges

Files created by container root (mapped to host UID 100000) appear as:

```bash
$ ls -la /var/lib/docker/volumes/myvolume
-rw-r--r-- 1 100000 100000 4096 Jan 10 10:00 data.db
```

This can complicate volume management and backups.

### Not a Silver Bullet

User namespaces don't protect against:

- **Kernel vulnerabilities**: Bugs in the kernel can still be exploited
- **Resource exhaustion**: Container can still DoS the host
- **Side-channel attacks**: Timing attacks, cache attacks, etc.

They're one layer in a defense-in-depth strategy.

## The Modern Container Security Model

Today's container security relies on multiple layers:

```
┌─────────────────────────────────────┐
│  Application Security                │
├─────────────────────────────────────┤
│  User Namespaces (UID/GID mapping)  │ ← Privilege isolation
├─────────────────────────────────────┤
│  Capabilities (Fine-grained perms)   │
├─────────────────────────────────────┤
│  Seccomp (Syscall filtering)         │
├─────────────────────────────────────┤
│  AppArmor/SELinux (MAC)              │
├─────────────────────────────────────┤
│  Namespaces (PID, Network, Mount)    │ ← Process isolation
├─────────────────────────────────────┤
│  cgroups (Resource limits)           │
└─────────────────────────────────────┘
```

User namespaces transformed the weakest link—privilege—into a strong security boundary.

## Conclusion

The introduction of user namespaces marked a turning point in container security. By making root contextual rather than absolute, Linux fundamentally changed the threat model for containers.

**Before user namespaces:**
- Container root = Host root
- Compromise = Game over

**After user namespaces:**
- Container root ≠ Host root
- Compromise = Limited impact

This single innovation enabled the secure, multi-tenant container platforms we rely on today. While not perfect, UID/GID mapping transformed containers from "dangerous convenience" to "production-ready infrastructure."

If you're running containers in production, ensure user namespaces are enabled. The security benefits are too significant to ignore.

## Further Reading

- [Linux User Namespaces Documentation](https://man7.org/linux/man-pages/man7/user_namespaces.7.html)
- [Docker Security: User Namespaces](https://docs.docker.com/engine/security/userns-remap/)
- [Kubernetes User Namespaces](https://kubernetes.io/docs/concepts/workloads/pods/user-namespaces/)
- [Understanding Linux Capabilities](https://man7.org/linux/man-pages/man7/capabilities.7.html)
