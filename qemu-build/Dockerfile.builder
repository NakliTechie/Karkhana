# syntax = docker/dockerfile:1.5

ARG BINFMT_VERSION=qemu-v6.1.0
ARG WASI_SDK_VERSION=19
ARG WASI_SDK_VERSION_FULL=${WASI_SDK_VERSION}.0
ARG WASI_VFS_VERSION=v0.3.0
ARG WIZER_VERSION=04e49c989542f2bf3a112d60fbf88a62cce2d0d0
ARG EMSDK_VERSION=3.1.40 # TODO: support recent version
ARG EMSDK_VERSION_QEMU=4.0.10
ARG BINARYEN_VERSION=114
ARG BUSYBOX_VERSION=1.36.1
ARG RUNC_VERSION=v1.3.0

# ARG LINUX_LOGLEVEL=0
# ARG INIT_DEBUG=false
ARG LINUX_LOGLEVEL=7
ARG INIT_DEBUG=true
ARG VM_MEMORY_SIZE_MB=128
ARG VM_CORE_NUMS=1
ARG QEMU_MIGRATION=true
ARG NO_VMTOUCH=
ARG EXTERNAL_BUNDLE=
ARG NO_BINFMT=

ARG LOAD_MODE=single # or separated

ARG OUTPUT_NAME=out.wasm # for wasi
ARG JS_OUTPUT_NAME=out # for emscripten; must not include "."
ARG OPTIMIZATION_MODE=wizer # "wizer" or "native"
# ARG OPTIMIZATION_MODE=native

ARG TINYEMU_REPO=https://github.com/ktock/tinyemu-c2w
ARG TINYEMU_REPO_VERSION=e4e9bd198f9c0505ab4c77a6a9d038059cd1474a

ARG BOCHS_REPO=https://github.com/ktock/Bochs
ARG BOCHS_REPO_VERSION=a88d1f687ec83ff82b5318f59dcecb8dab44fc83

ARG QEMU_REPO=https://github.com/NakliTechie/qemu-wasm
ARG QEMU_REPO_VERSION=7df55d6d2b65d7a38bfd91f0d92c9dbe1a176328

ARG SOURCE_REPO=https://github.com/ktock/container2wasm
ARG SOURCE_REPO_VERSION=v0.8.4

ARG ZLIB_VERSION=1.3.2
ARG GLIB_MINOR_VERSION=2.75
ARG GLIB_VERSION=${GLIB_MINOR_VERSION}.0
ARG PIXMAN_VERSION=0.42.2
ARG FFI_VERSION=adbcf2b247696dde2667ab552cb93e0c79455c84

FROM scratch AS oci-image-src
COPY . .

FROM ubuntu:22.04 AS assets-base
ARG SOURCE_REPO
ARG SOURCE_REPO_VERSION
RUN apt-get update && apt-get install -y git
RUN git clone -b ${SOURCE_REPO_VERSION} ${SOURCE_REPO} /assets
# Karkhana carried patch: persistent guest disk. The page attaches a qcow2 image
# as the second virtio disk (/dev/vdb): the user's OPFS disk, or the template in
# memory when OPFS is unavailable. The container's overlay is mounted after the
# snapshot restores rather than before it, so its upper layer can live on that
# disk. karkhana_disk.go mounts the disk when /mnt/wasi1/info says "disk: vdb"
# and moves the overlay's upper and work directories onto it; without that
# line, or on any failure, they stay on tmpfs.
COPY <<'EOF' /assets/cmd/init/karkhana_disk.go
package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	inittype "github.com/ktock/container2wasm/cmd/init/types"
)

const (
	karkhanaDiskDevice = "/dev/vdb"
	karkhanaDiskMount  = "/run/kdisk"
	karkhanaProbeMount = "/run/kdisk-probe"
	// BLKFLSBUF drops the block device's cached pages. The snapshot was taken
	// with the template attached, so the restored kernel can hold its blocks.
	karkhanaBlkFlsBuf = 0x1261
	// The overlay options create-spec writes for the container's rootfs.
	karkhanaTmpfsLayers = "upperdir=/run/rootfs-upper,workdir=/run/rootfs-work"
	karkhanaDiskLayers  = "upperdir=" + karkhanaDiskMount + "/upper,workdir=" + karkhanaDiskMount + "/work"
)

// karkhanaDisk runs after the snapshot restores and before cfg.PostMounts.
// Its messages avoid "karkhana:", which the page reads as the shell prompt.
func karkhanaDisk(cfg *inittype.BootConfig) {
	requested, mode := karkhanaDiskRequested()
	if !requested {
		return
	}
	if err := karkhanaUseDisk(cfg); err != nil {
		fmt.Printf("karkhana disk: unavailable (%v); this session uses scratch storage\n", err)
		return
	}
	if mode == "scratch" {
		fmt.Printf("karkhana disk: scratch, in this tab's memory\n")
		return
	}
	fmt.Printf("karkhana disk: persistent\n")
}

// karkhanaDiskRequested reads "disk: vdb" and "disk-mode: persistent|scratch"
// from the page's info file. The disk is mounted the same way in both modes;
// only the page knows whether it lives in OPFS or in the tab's memory.
func karkhanaDiskRequested() (bool, string) {
	f, err := os.Open(filepath.Join("/mnt", packFSTag, "info"))
	if err != nil {
		return false, ""
	}
	defer f.Close()
	requested, mode := false, "persistent"
	s := bufio.NewScanner(f)
	for s.Scan() {
		k, v, ok := strings.Cut(s.Text(), ":")
		if !ok {
			continue
		}
		switch k {
		case "disk":
			requested = requested || strings.TrimSpace(v) == "vdb"
		case "disk-mode":
			mode = strings.TrimSpace(v)
		}
	}
	return requested, mode
}

// karkhanaUseDisk mounts the disk and points the rootfs overlay's upper and
// work directories into it. overlayfs needs both under one mount, so they
// are subdirectories of the disk mount rather than separate binds.
func karkhanaUseDisk(cfg *inittype.BootConfig) (err error) {
	rootfs := -1
	for i, m := range cfg.PostMounts {
		if m.FSType == "overlay" && m.Dst == "/run/rootfs" && strings.Count(m.Data, karkhanaTmpfsLayers) == 1 {
			rootfs = i
		}
	}
	if rootfs < 0 {
		return fmt.Errorf("rootfs overlay not found")
	}
	fd, err := syscall.Open(karkhanaDiskDevice, syscall.O_RDONLY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), karkhanaBlkFlsBuf, 0)
	syscall.Close(fd)
	if errno != 0 {
		return fmt.Errorf("flush %s: %w", karkhanaDiskDevice, errno)
	}
	if err := os.MkdirAll(karkhanaDiskMount, 0755); err != nil {
		return err
	}
	if err := syscall.Mount(karkhanaDiskDevice, karkhanaDiskMount, "ext4", syscall.MS_NOATIME, ""); err != nil {
		return fmt.Errorf("mount %s: %w", karkhanaDiskDevice, err)
	}
	defer func() {
		if err != nil {
			syscall.Unmount(karkhanaDiskMount, 0)
		}
	}()
	for _, d := range []string{"upper", "work"} {
		if err := os.MkdirAll(filepath.Join(karkhanaDiskMount, d), 0755); err != nil {
			return err
		}
	}
	// Mount the exact overlay once: a failure here keeps tmpfs, where a
	// failure inside mountAll would panic init and stop the VM.
	data := strings.Replace(cfg.PostMounts[rootfs].Data, karkhanaTmpfsLayers, karkhanaDiskLayers, 1)
	if err := os.MkdirAll(karkhanaProbeMount, 0755); err != nil {
		return err
	}
	if err := syscall.Mount("overlay", karkhanaProbeMount, "overlay", 0, data); err != nil {
		return fmt.Errorf("overlay on disk: %w", err)
	}
	if err := syscall.Unmount(karkhanaProbeMount, 0); err != nil {
		return fmt.Errorf("overlay probe: %w", err)
	}
	cfg.PostMounts[rootfs].Data = data
	// /tmp stays scratch: the guest keeps pid-keyed locks there, and pids repeat
	// on every restore of the same snapshot.
	cfg.PostMounts = append(cfg.PostMounts, inittype.MountInfo{
		FSType: "tmpfs",
		Src:    "tmpfs",
		Dst:    "/run/rootfs/tmp",
		Data:   "mode=1777",
	})
	return nil
}
EOF
RUN cd /assets && \
    sed -i 's|^\tif err := mountAll(cfg.PostMounts); err != nil {$|\tkarkhanaDisk(\&cfg)\n&|' cmd/init/main.go && \
    test "$(grep -cF 'karkhanaDisk(&cfg)' cmd/init/main.go)" -eq 1 && \
    sed -i 's|^\t\tbootConfig.Mounts = append(bootConfig.Mounts, rootfsMount) // mount embedded rootfs as soon as possible$|\t\tbootConfig.PostMounts = append(bootConfig.PostMounts, rootfsMount) // Karkhana: after restore, so the upper layer can live on the persistent disk|' cmd/create-spec/main.go && \
    test "$(grep -cF 'Karkhana: after restore' cmd/create-spec/main.go)" -eq 1 && \
    test "$(grep -cF 'bootConfig.Mounts = append(bootConfig.Mounts, rootfsMount)' cmd/create-spec/main.go)" -eq 0
FROM scratch AS assets
COPY --link --from=assets-base /assets /

FROM ubuntu:22.04 AS tinyemu-repo-base
ARG TINYEMU_REPO
ARG TINYEMU_REPO_VERSION
RUN apt-get update && apt-get install -y git
RUN git clone ${TINYEMU_REPO} /tinyemu && \
    cd /tinyemu && \
    git checkout ${TINYEMU_REPO_VERSION}
FROM scratch AS tinyemu-repo
COPY --link --from=tinyemu-repo-base /tinyemu /

FROM ubuntu:22.04 AS bochs-repo-base
ARG BOCHS_REPO
ARG BOCHS_REPO_VERSION
RUN apt-get update && apt-get install -y git
RUN git clone ${BOCHS_REPO} /Bochs && \
    cd /Bochs && \
    git checkout ${BOCHS_REPO_VERSION}
FROM scratch AS bochs-repo
COPY --link --from=bochs-repo-base /Bochs /

FROM ubuntu:22.04 AS qemu-repo-base
ARG QEMU_REPO
ARG QEMU_REPO_VERSION
RUN apt-get update && apt-get install -y git
RUN git clone --depth 100 --branch build/9p-fix-8604 ${QEMU_REPO} /qemu && \
    cd /qemu && \
    git checkout ${QEMU_REPO_VERSION} && \
    git clone https://gitlab.com/qemu-project/dtc.git subprojects/dtc && \
    git -C subprojects/dtc checkout b6910bec11614980a21e46fbccc35934b671bd81
# Karkhana carried patch: a guest with its 9p exports mounted can be saved and
# restored. Upstream blocks migration once an export is mounted, because the
# server's fid table is not part of the device state. The patch carries it
# (fid, type, open flags, uid, path) in the virtio-9p device state; restored
# files reopen on first use, the path an LRU-reclaimed fid already takes. A save
# with 9p requests in flight fails and is retried. Karkhana's machine files
# (savevm/loadvm of a running VM) depend on it: savevm checks the same blockers,
# and Karkhana keeps /persist and the TLS certificate mounted all session.
COPY <<'EOF' /qemu-patches/9p-migrate.patch
diff --git a/hw/9pfs/9p.c b/hw/9pfs/9p.c
index 46aa506..d6f0926 100644
--- a/hw/9pfs/9p.c
+++ b/hw/9pfs/9p.c
@@ -34,6 +34,8 @@
 #include "coth.h"
 #include "trace.h"
 #include "migration/blocker.h"
+#include "migration/qemu-file-types.h"
+#include "migration/vmstate.h"
 #include "qemu/xxhash.h"
 #include <math.h>
 
@@ -1494,20 +1496,11 @@ static void coroutine_fn v9fs_attach(void *opaque)
     }
 
     /*
-     * disable migration if we haven't done already.
-     * attach could get called multiple times for the same export.
+     * Karkhana: a mounted export no longer blocks migration. The fid table
+     * travels with the device state (vmstate_v9fs_server below), so a guest
+     * restored elsewhere keeps its mounts and open files.
      */
-    if (!s->migration_blocker) {
-        error_setg(&s->migration_blocker,
-                   "Migration is disabled when VirtFS export path '%s' is mounted in the guest using mount_tag '%s'",
-                   s->ctx.fs_root ? s->ctx.fs_root : "NULL", s->tag);
-        err = migrate_add_blocker(&s->migration_blocker, NULL);
-        if (err < 0) {
-            clunk_fid(s, fid);
-            goto out;
-        }
-        s->root_fid = fid;
-    }
+    s->root_fid = fid;
 
     err = pdu_marshal(pdu, offset, "Q", &qid);
     if (err < 0) {
@@ -4355,3 +4348,125 @@ static void __attribute__((__constructor__)) v9fs_set_fd_limit(void)
     open_fd_hw = rlim.rlim_cur - MIN(400, rlim.rlim_cur / 3);
     open_fd_rc = rlim.rlim_cur / 2;
 }
+
+/*
+ * Karkhana: migrate the server's per-mount state, so a guest saved with its
+ * exports mounted resumes with them working. A fid carries its number, type,
+ * open flags, uid and path; nothing host-side (fds, DIR streams). Restored
+ * files and directories start closed and reopen on first use through
+ * v9fs_reopen_fid(), the path an LRU-reclaimed fid already takes. The export
+ * must hold the same paths on the destination. xattr fids are transient and
+ * are not carried; requests in flight make the save fail, to be retried.
+ */
+static bool v9fs_fid_migrates(V9fsFidState *fidp)
+{
+    return !fidp->clunked && fidp->fid_type != P9_FID_XATTR;
+}
+
+static int put_v9fs_server(QEMUFile *f, void *pv, size_t size,
+                           const VMStateField *field, JSONWriter *vmdesc)
+{
+    V9fsState *s = pv;
+    GHashTableIter iter;
+    gpointer key;
+    V9fsFidState *fidp;
+    uint32_t count = 0;
+
+    qemu_put_be32(f, s->proto_version);
+    qemu_put_be32(f, s->msize);
+    qemu_put_be32(f, s->root_fid);
+    g_hash_table_iter_init(&iter, s->fids);
+    while (g_hash_table_iter_next(&iter, &key, (gpointer *) &fidp)) {
+        count += v9fs_fid_migrates(fidp);
+    }
+    qemu_put_be32(f, count);
+    g_hash_table_iter_init(&iter, s->fids);
+    while (g_hash_table_iter_next(&iter, &key, (gpointer *) &fidp)) {
+        if (!v9fs_fid_migrates(fidp)) {
+            continue;
+        }
+        qemu_put_be32(f, fidp->fid);
+        qemu_put_be32(f, fidp->fid_type);
+        qemu_put_be32(f, fidp->open_flags);
+        qemu_put_be32(f, fidp->uid);
+        qemu_put_be32(f, fidp->path.size);
+        qemu_put_buffer(f, (uint8_t *) fidp->path.data, fidp->path.size);
+    }
+    return 0;
+}
+
+static int get_v9fs_server(QEMUFile *f, void *pv, size_t size,
+                           const VMStateField *field)
+{
+    V9fsState *s = pv;
+    uint32_t count, i;
+
+    s->proto_version = qemu_get_be32(f);
+    s->msize = qemu_get_be32(f);
+    s->root_fid = qemu_get_be32(f);
+    count = qemu_get_be32(f);
+    for (i = 0; i < count; i++) {
+        int32_t fid = qemu_get_be32(f);
+        int fid_type = qemu_get_be32(f);
+        int open_flags = qemu_get_be32(f);
+        uid_t uid = qemu_get_be32(f);
+        uint32_t len = qemu_get_be32(f);
+        V9fsFidState *fidp;
+
+        if (qemu_file_get_error(f) || len > PATH_MAX + 1 ||
+            (fid_type != P9_FID_NONE && fid_type != P9_FID_FILE &&
+             fid_type != P9_FID_DIR)) {
+            return -EINVAL;
+        }
+        fidp = alloc_fid(s, fid);
+        if (!fidp) {
+            return -EINVAL;
+        }
+        /* alloc_fid() hands out a reference for the request that made it. */
+        fidp->ref = 0;
+        fidp->fid_type = fid_type;
+        /* Reopening must not create or truncate again. */
+        fidp->open_flags = open_flags & ~(O_CREAT | O_EXCL | O_TRUNC);
+        fidp->uid = uid;
+        fidp->path.size = len;
+        fidp->path.data = g_malloc(len);
+        qemu_get_buffer(f, (uint8_t *) fidp->path.data, len);
+        if (fid_type == P9_FID_FILE) {
+            fidp->fs.fd = -1;
+        }
+    }
+    return qemu_file_get_error(f);
+}
+
+static const VMStateInfo vmstate_info_v9fs_server = {
+    .name = "9p-server",
+    .get = get_v9fs_server,
+    .put = put_v9fs_server,
+};
+
+static int v9fs_server_pre_save(void *opaque)
+{
+    V9fsState *s = opaque;
+
+    if (!QLIST_EMPTY(&s->active_list)) {
+        error_report("9p export '%s' has requests in flight; save again",
+                     s->tag);
+        return -EBUSY;
+    }
+    return 0;
+}
+
+const VMStateDescription vmstate_v9fs_server = {
+    .name = "9p-server",
+    .version_id = 1,
+    .minimum_version_id = 1,
+    .pre_save = v9fs_server_pre_save,
+    .fields = (VMStateField[]) {
+        {
+            .name = "server",
+            .info = &vmstate_info_v9fs_server,
+            .flags = VMS_SINGLE,
+        },
+        VMSTATE_END_OF_LIST()
+    },
+};
diff --git a/hw/9pfs/9p.h b/hw/9pfs/9p.h
index a6f59ab..3b1ff64 100644
--- a/hw/9pfs/9p.h
+++ b/hw/9pfs/9p.h
@@ -469,6 +469,7 @@ V9fsPDU *pdu_alloc(V9fsState *s);
 void pdu_free(V9fsPDU *pdu);
 void pdu_submit(V9fsPDU *pdu, P9MsgHeader *hdr);
 void v9fs_reset(V9fsState *s);
+extern const VMStateDescription vmstate_v9fs_server;
 
 struct V9fsTransport {
     ssize_t     (*pdu_vmarshal)(V9fsPDU *pdu, size_t offset, const char *fmt,
diff --git a/hw/9pfs/virtio-9p-device.c b/hw/9pfs/virtio-9p-device.c
index 5f522e6..776c3d9 100644
--- a/hw/9pfs/virtio-9p-device.c
+++ b/hw/9pfs/virtio-9p-device.c
@@ -233,6 +233,43 @@ static void virtio_9p_device_unrealize(DeviceState *dev)
 
 /* virtio-9p device */
 
+/*
+ * Karkhana: the 9p server's state, present once the guest has mounted the
+ * export (9p.c). It rides in the device-specific state that virtio_load()
+ * reads, so a stream without it (an older snapshot) still loads.
+ */
+static bool virtio_9p_server_needed(void *opaque)
+{
+    V9fsVirtioState *v = opaque;
+
+    return v->state.proto_version != 0;
+}
+
+static const VMStateDescription vmstate_virtio_9p_server = {
+    .name = "virtio-9p-device/server",
+    .version_id = 1,
+    .minimum_version_id = 1,
+    .needed = virtio_9p_server_needed,
+    .fields = (VMStateField[]) {
+        VMSTATE_STRUCT(state, V9fsVirtioState, 1, vmstate_v9fs_server,
+                       V9fsState),
+        VMSTATE_END_OF_LIST()
+    },
+};
+
+static const VMStateDescription vmstate_virtio_9p_device = {
+    .name = "virtio-9p-device",
+    .version_id = 1,
+    .minimum_version_id = 1,
+    .fields = (VMStateField[]) {
+        VMSTATE_END_OF_LIST()
+    },
+    .subsections = (const VMStateDescription * []) {
+        &vmstate_virtio_9p_server,
+        NULL
+    },
+};
+
 static const VMStateDescription vmstate_virtio_9p = {
     .name = "virtio-9p",
     .minimum_version_id = 1,
@@ -262,6 +299,7 @@ static void virtio_9p_class_init(ObjectClass *klass, void *data)
     vdc->get_features = virtio_9p_get_features;
     vdc->get_config = virtio_9p_get_config;
     vdc->reset = virtio_9p_reset;
+    vdc->vmsd = &vmstate_virtio_9p_device;
 }
 
 static const TypeInfo virtio_device_info = {
EOF
# Carried cherry-pick: ktock/qemu-wasm#50 by its author (open upstream).
# Emscripten gives a thread a 64KB stack with no guard page, laid out above the
# thread's own TLS; an overflow corrupts it silently, as the PR shows for the
# block layer's synchronous paths. 2MB per thread, plus -sSTACK_SIZE=4MB for
# main() under PROXY_TO_PTHREAD (the x86_64 EXTRA_CFLAGS below).
COPY <<'EOF' /qemu-patches/thread-stack.patch
diff --git a/util/qemu-thread-posix.c b/util/qemu-thread-posix.c
index b2e26e21205b6..0064810858e9b 100644
--- a/util/qemu-thread-posix.c
+++ b/util/qemu-thread-posix.c
@@ -11,6 +11,12 @@
  *
  */
 #include "qemu/osdep.h"
+#include "qemu/units.h"
+
+#if defined(EMSCRIPTEN)
+#define EMSCRIPTEN_THREAD_STACK_SIZE (2 * MiB)
+#endif
+
 #include "qemu/thread.h"
 #include "qemu/atomic.h"
 #include "qemu/notify.h"
@@ -560,6 +566,22 @@ void qemu_thread_create(QemuThread *thread, const char *name,
         error_exit(err, __func__);
     }
 
+#if defined(EMSCRIPTEN)
+    /*
+     * Emscripten gives a new thread a 64KB wasm shadow stack by default, laid
+     * out directly above the thread's own TLS block with no guard page.  The
+     * synchronous block-layer paths device emulation takes from a vCPU
+     * thread (blk_pread under AIO_WAIT_WHILE: aio_poll, bottom halves,
+     * coroutine entry) need a few hundred KB, and an overflow silently
+     * corrupts the TLS.  Linear memory is committed, not reserved, so keep
+     * the request moderate.
+     */
+    err = pthread_attr_setstacksize(&attr, EMSCRIPTEN_THREAD_STACK_SIZE);
+    if (err) {
+        error_exit(err, __func__);
+    }
+#endif
+
     if (mode == QEMU_THREAD_DETACHED) {
         pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
     }
EOF
RUN cd /qemu && git apply /qemu-patches/thread-stack.patch && \
    grep -q 'EMSCRIPTEN_THREAD_STACK_SIZE' util/qemu-thread-posix.c
RUN cd /qemu && git apply /qemu-patches/9p-migrate.patch && \
    test "$(grep -c 'vmstate_v9fs_server' hw/9pfs/9p.c hw/9pfs/virtio-9p-device.c | awk -F: '{s+=$2} END {print s}')" -ge 3 && \
    ! grep -q 'Migration is disabled when VirtFS' hw/9pfs/9p.c
FROM scratch AS qemu-repo
COPY --link --from=qemu-repo-base /qemu /

FROM golang:1.26-bookworm AS golang-base

FROM golang-base AS bundle-dev
ARG TARGETPLATFORM
ARG INIT_DEBUG
ARG OPTIMIZATION_MODE
ARG NO_VMTOUCH
ARG NO_BINFMT
ARG EXTERNAL_BUNDLE
COPY --link --from=assets / /work
WORKDIR /work
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    go build -o /bin/create-spec ./cmd/create-spec
COPY --link --from=oci-image-src / /oci
# This step creates the following files
# <vm-rootfs>/oci/rootfs          : rootfs dir this Dockerfile creates container's rootfs and used by the container.
# <vm-rootfs>/oci/image.json      : container image config file used by init
# <vm-rootfs>/oci/spec.json       : container runtime spec file used by init
# <vm-rootfs>/oci/initconfig.json : configuration file for init
RUN mkdir -p /out/oci/rootfs /out/oci/bundle && \
    IS_WIZER=false && \
    if test "${OPTIMIZATION_MODE}" = "wizer" ; then IS_WIZER=true ; fi && \
    NO_VMTOUCH_F=false && \
    NO_BINFMT_F=false && \
    if test "${OPTIMIZATION_MODE}" = "native" ; then NO_VMTOUCH_F=true ; NO_BINFMT_F=true ; fi && \
    if test "${NO_VMTOUCH}" != "" ; then NO_VMTOUCH_F="${NO_VMTOUCH}" ; fi && \
    if test "${NO_BINFMT}" != "" ; then NO_BINFMT_F="${NO_BINFMT}" ; fi && \
    EXTERNAL_BUNDLE_F=false && \
    if test "${EXTERNAL_BUNDLE}" = "true" ; then EXTERNAL_BUNDLE_F=true ; fi && \
    create-spec --debug=${INIT_DEBUG} --debug-init=${IS_WIZER} --no-vmtouch=${NO_VMTOUCH_F} --external-bundle=${EXTERNAL_BUNDLE_F} --no-binfmt=${NO_BINFMT_F} \
                --image-config-path=/oci/image.json \
                --runtime-config-path=/oci/spec.json \
                --rootfs-path=/oci/rootfs \
                /oci "${TARGETPLATFORM}" /out/oci/rootfs
RUN if test -f image.json; then mv image.json /out/oci/ ; fi && \
    if test -f spec.json; then mv spec.json /out/oci/ ; fi
RUN mv initconfig.json /out/oci/

FROM ubuntu:22.04 AS gcc-riscv64-linux-gnu-base
RUN apt-get update && apt-get install -y gcc-riscv64-linux-gnu libc-dev-riscv64-cross git make

FROM gcc-riscv64-linux-gnu-base AS bbl-dev
WORKDIR /work-buildroot/
RUN git clone https://github.com/riscv-software-src/riscv-pk
WORKDIR /work-buildroot/riscv-pk
RUN git checkout 7e9b671c0415dfd7b562ac934feb9380075d4aa2
RUN mkdir build
WORKDIR /work-buildroot/riscv-pk/build
RUN ../configure --host=riscv64-linux-gnu
RUN cat ../machine/htif.c ../bbl/bbl.lds
# HTIF address needs to be static on TinyEMU
RUN sed -i 's/volatile uint64_t tohost __attribute__((section(".htif")));/#define tohost *(uint64_t*)0x40008000/' ../machine/htif.c && \
    sed -i 's/volatile uint64_t fromhost __attribute__((section(".htif")));/#define fromhost *(uint64_t*)0x40008008/' ../machine/htif.c
RUN make bbl
RUN riscv64-linux-gnu-objcopy -O binary bbl bbl.bin && \
    mkdir /out/ && \
    mv bbl.bin /out/

FROM gcc-riscv64-linux-gnu-base AS linux-riscv64-dev-common
RUN apt-get update && apt-get install -y gperf flex bison bc
RUN mkdir /work-buildlinux
WORKDIR /work-buildlinux
RUN git clone -b v6.1 --depth 1 https://github.com/torvalds/linux

FROM linux-riscv64-dev-common AS linux-riscv64-dev
WORKDIR /work-buildlinux/linux
COPY --link --from=assets /config/tinyemu/linux_rv64_config ./.config
RUN make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- -j$(nproc) all && \
    mkdir /out && \
    mv /work-buildlinux/linux/arch/riscv/boot/Image /out/Image && \
    make clean

FROM linux-riscv64-dev-common AS linux-riscv64-config-dev
WORKDIR /work-buildlinux/linux
COPY --link --from=assets /config/tinyemu/linux_rv64_config ./.config
RUN make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- olddefconfig

FROM scratch AS linux-riscv64-config
COPY --link --from=linux-riscv64-config-dev /work-buildlinux/linux/.config /

FROM golang-base AS init-riscv64-dev
COPY --link --from=assets / /work
WORKDIR /work
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    GOARCH=riscv64 go build -ldflags "-s -w -extldflags '-static'" -tags "osusergo netgo static_build" -o /out/init ./cmd/init

FROM golang-base AS runc-riscv64-dev
ARG RUNC_VERSION
RUN apt-get update -y && apt-get install -y gcc-riscv64-linux-gnu libc-dev-riscv64-cross git make gperf
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    git clone https://github.com/opencontainers/runc.git /go/src/github.com/opencontainers/runc && \
    cd /go/src/github.com/opencontainers/runc && \
    git checkout "${RUNC_VERSION}" && \
    # mkdir -p /opt/libseccomp && ./script/seccomp.sh "2.5.4" /opt/libseccomp riscv64 && \
    make static GOARCH=riscv64 CC=riscv64-linux-gnu-gcc EXTRA_LDFLAGS='-s -w' BUILDTAGS="" && \
    mkdir -p /out/ && mv runc /out/runc

FROM gcc-riscv64-linux-gnu-base AS vmtouch-riscv64-dev
RUN git clone https://github.com/hoytech/vmtouch.git && \
    cd vmtouch && \
    CC="riscv64-linux-gnu-gcc -static" make && \
    mkdir /out && mv vmtouch /out/

FROM --platform=riscv64 tonistiigi/binfmt:${BINFMT_VERSION} AS binfmt
FROM scratch AS binfmt-riscv64
FROM scratch AS binfmt-base
COPY --link --from=binfmt /usr/bin/binfmt /usr/bin/
FROM binfmt-base AS binfmt-amd64
COPY --link --from=binfmt /usr/bin/qemu-x86_64 /usr/bin/
FROM binfmt-base AS binfmt-aarch64
COPY --link --from=binfmt /usr/bin/qemu-aarch64 /usr/bin/
FROM binfmt-base AS binfmt-arm
COPY --link --from=binfmt /usr/bin/qemu-arm /usr/bin/
FROM binfmt-base AS binfmt-i386
COPY --link --from=binfmt /usr/bin/qemu-i386 /usr/bin/
FROM binfmt-base AS binfmt-mips64
COPY --link --from=binfmt /usr/bin/qemu-mips64 /usr/bin/
FROM binfmt-base AS binfmt-ppc64le
COPY --link --from=binfmt /usr/bin/qemu-ppc64le /usr/bin/
FROM binfmt-base AS binfmt-s390
COPY --link --from=binfmt /usr/bin/qemu-s390 /usr/bin/
FROM binfmt-$TARGETARCH AS binfmt-dev

FROM gcc-riscv64-linux-gnu-base AS busybox-riscv64-dev
ARG BUSYBOX_VERSION
RUN apt-get update -y && apt-get install -y gcc bzip2 wget
WORKDIR /work
RUN wget https://busybox.net/downloads/busybox-${BUSYBOX_VERSION}.tar.bz2
RUN bzip2 -d busybox-${BUSYBOX_VERSION}.tar.bz2
RUN tar xvf busybox-${BUSYBOX_VERSION}.tar
WORKDIR /work/busybox-${BUSYBOX_VERSION}
RUN make CROSS_COMPILE=riscv64-linux-gnu- LDFLAGS=--static defconfig
RUN make CROSS_COMPILE=riscv64-linux-gnu- LDFLAGS=--static -j$(nproc)
RUN mkdir -p /out/bin && mv busybox /out/bin/busybox
RUN make LDFLAGS=--static defconfig
RUN make LDFLAGS=--static -j$(nproc)
RUN for i in $(./busybox --list) ; do ln -s busybox /out/bin/$i ; done
RUN mkdir -p /out/usr/share/udhcpc/ && cp ./examples/udhcp/simple.script /out/usr/share/udhcpc/default.script

FROM gcc-riscv64-linux-gnu-base AS tini-riscv64-dev
# https://github.com/krallin/tini#building-tini
RUN apt-get update -y && apt-get install -y cmake
ENV CFLAGS="-DPR_SET_CHILD_SUBREAPER=36 -DPR_GET_CHILD_SUBREAPER=37"
WORKDIR /work
RUN git clone -b v0.19.0 https://github.com/krallin/tini
WORKDIR /work/tini
ENV CC="riscv64-linux-gnu-gcc -static"
RUN cmake . && make && mkdir /out/ && mv tini /out/

FROM ubuntu:22.04 AS rootfs-riscv64-dev
RUN apt-get update -y && apt-get install -y mkisofs
COPY --link --from=busybox-riscv64-dev /out/ /rootfs/
COPY --link --from=binfmt-dev / /rootfs/
COPY --link --from=runc-riscv64-dev /out/runc /rootfs/sbin/runc
COPY --link --from=bundle-dev /out/ /rootfs/
COPY --link --from=init-riscv64-dev /out/init /rootfs/sbin/init
COPY --link --from=vmtouch-riscv64-dev /out/vmtouch /rootfs/bin/
COPY --link --from=tini-riscv64-dev /out/tini /rootfs/sbin/tini
RUN mkdir -p /rootfs/proc /rootfs/sys /rootfs/mnt /rootfs/run /rootfs/tmp /rootfs/dev /rootfs/var /rootfs/etc && mknod /rootfs/dev/null c 1 3 && chmod 666 /rootfs/dev/null
RUN mkdir /out/ && mkisofs -R -o /out/rootfs.bin /rootfs/
# RUN isoinfo -i /out/rootfs.bin -l

FROM ubuntu:22.04 AS tinyemu-config-dev
ARG LINUX_LOGLEVEL
ARG VM_MEMORY_SIZE_MB
RUN apt-get update && apt-get install -y gettext-base && mkdir /out
COPY --link --from=assets /config/tinyemu/tinyemu.config.template /
RUN cat /tinyemu.config.template | LOGLEVEL=$LINUX_LOGLEVEL MEMORY_SIZE=$VM_MEMORY_SIZE_MB envsubst > /out/tinyemu.config

FROM scratch AS vm-riscv64-dev
COPY --link --from=bbl-dev /out/bbl.bin /pack/bbl.bin
COPY --link --from=linux-riscv64-dev /out/Image /pack/Image
COPY --link --from=rootfs-riscv64-dev /out/rootfs.bin /pack/rootfs.bin
COPY --link --from=tinyemu-config-dev /out/tinyemu.config /pack/config

FROM rust:1.74.1-bullseye AS tinyemu-dev-common
ARG WASI_VFS_VERSION
ARG WASI_SDK_VERSION
ARG WASI_SDK_VERSION_FULL
ARG WIZER_VERSION
RUN apt-get update -y && apt-get install -y make curl git gcc xz-utils

WORKDIR /wasi
RUN curl -o wasi-sdk.tar.gz -fSL https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}/wasi-sdk-${WASI_SDK_VERSION_FULL}-linux.tar.gz && \
    tar xvf wasi-sdk.tar.gz && rm wasi-sdk.tar.gz
ENV WASI_SDK_PATH=/wasi/wasi-sdk-${WASI_SDK_VERSION_FULL}

WORKDIR /work/
RUN git clone https://github.com/kateinoigakukun/wasi-vfs.git --recurse-submodules && \
    cd wasi-vfs && \
    git checkout "${WASI_VFS_VERSION}" && \
    cargo build --target wasm32-unknown-unknown && \
    cargo build --package wasi-vfs-cli && \
    mkdir -p /tools/wasi-vfs/ && \
    mv target/debug/wasi-vfs target/wasm32-unknown-unknown/debug/libwasi_vfs.a /tools/wasi-vfs/ && \
    cargo clean

WORKDIR /work/
RUN git clone https://github.com/bytecodealliance/wizer && \
    cd wizer && \
    git checkout "${WIZER_VERSION}" && \
    cargo build --bin wizer --all-features && \
    mkdir -p /tools/wizer/ && \
    mv include target/debug/wizer /tools/wizer/ && \
    cargo clean

COPY --link --from=tinyemu-repo / /tinyemu
WORKDIR /tinyemu
RUN make -j $(nproc) -f Makefile \
    CONFIG_FS_NET= CONFIG_SDL= CONFIG_INT128= CONFIG_X86EMU= CONFIG_SLIRP= \
    CC="${WASI_SDK_PATH}/bin/clang --sysroot=${WASI_SDK_PATH}/share/wasi-sysroot -D_WASI_EMULATED_SIGNAL -DWASI -I/tools/wizer/include/" \
    EMU_LIBS="/tools/wasi-vfs/libwasi_vfs.a -lrt" \
    EMU_OBJS="virtio.o pci.o fs.o cutils.o iomem.o simplefb.o json.o machine.o temu.o wasi.o riscv_machine.o softfp.o riscv_cpu32.o riscv_cpu64.o fs_disk.o"

FROM tinyemu-dev-common AS tinyemu-dev-native
COPY --link --from=vm-riscv64-dev /pack /minpack

FROM tinyemu-dev-common AS tinyemu-dev-wizer
COPY --link --from=vm-riscv64-dev /pack /pack
RUN mv temu temu-org && /tools/wizer/wizer --allow-wasi --wasm-bulk-memory=true -r _start=wizer.resume --mapdir /pack::/pack -o temu temu-org
RUN mkdir /minpack && cp /pack/rootfs.bin /minpack/

FROM tinyemu-dev-${OPTIMIZATION_MODE} AS tinyemu-dev-packed
RUN /tools/wasi-vfs/wasi-vfs pack /tinyemu/temu --mapdir /pack::/minpack -o packed && mkdir /out
ARG OUTPUT_NAME
RUN mv packed /out/$OUTPUT_NAME

FROM emscripten/emsdk:$EMSDK_VERSION AS tinyemu-emscripten
ARG JS_OUTPUT_NAME
RUN apt-get update && apt-get install -y git
COPY --link --from=tinyemu-repo / /tinyemu
COPY --link --from=vm-riscv64-dev /pack /pack
WORKDIR /tinyemu
RUN make -j $(nproc) -f Makefile \
    CONFIG_FS_NET= CONFIG_SDL= CONFIG_INT128= CONFIG_X86EMU= CONFIG_SLIRP= OUTPUT_NAME=$JS_OUTPUT_NAME \
    CC="emcc --preload-file /pack -s WASM=1 -s ASYNCIFY=1 -s ALLOW_MEMORY_GROWTH=1 -UEMSCRIPTEN -DON_BROWSER -sNO_EXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1" && \
    mkdir -p /out/ && mv ${JS_OUTPUT_NAME} /out/${JS_OUTPUT_NAME}.js && mv ${JS_OUTPUT_NAME}.wasm /out/ && mv ${JS_OUTPUT_NAME}.data /out/

FROM scratch AS js-tinyemu
COPY --link --from=tinyemu-emscripten /out/ /
FROM js-tinyemu AS js-arm
FROM js-tinyemu AS js-i386
FROM js-tinyemu AS js-mips64
FROM js-tinyemu AS js-ppc64le
FROM js-tinyemu AS js-s390

FROM scratch AS wasi-tinyemu
COPY --link --from=tinyemu-dev-packed /out/ /
FROM wasi-tinyemu AS wasi-riscv64
FROM wasi-tinyemu AS wasi-aarch64
FROM wasi-tinyemu AS wasi-arm
FROM wasi-tinyemu AS wasi-i386
FROM wasi-tinyemu AS wasi-mips64
FROM wasi-tinyemu AS wasi-ppc64le
FROM wasi-tinyemu AS wasi-s390

FROM emscripten/emsdk:$EMSDK_VERSION_QEMU AS glib-emscripten-base
# Porting glib to emscripten inspired by https://github.com/emscripten-core/emscripten/issues/11066
ENV TARGET=/glib-emscripten/target
ENV CFLAGS="-O2 -matomics -mbulk-memory -DNDEBUG -sWASM_BIGINT -DWASM_BIGINT -pthread -sMALLOC=emmalloc  -sASYNCIFY=1 "
ENV CXXFLAGS="$CFLAGS"
ENV LDFLAGS="-L$TARGET/lib -O2"
ENV CPATH="$TARGET/include"
ENV PKG_CONFIG_PATH="$TARGET/lib/pkgconfig"
ENV EM_PKG_CONFIG_PATH="$PKG_CONFIG_PATH"
ENV CHOST="wasm32-unknown-linux"
ENV MAKEFLAGS="-j$(nproc)"
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \
    autoconf \
    build-essential \
    libglib2.0-dev \
    libtool \
    pkgconf \
    ninja-build \
    pipx
RUN PIPX_BIN_DIR=/usr/local/bin pipx install meson==1.5.0
RUN mkdir /glib-emscripten
WORKDIR /glib-emscripten
RUN mkdir -p $TARGET

FROM glib-emscripten-base AS zlib-emscripten-dev
ARG ZLIB_VERSION
RUN mkdir -p /zlib
RUN curl -LsS https://zlib.net/fossils/zlib-$ZLIB_VERSION.tar.gz | tar zxC /zlib --strip-components=1
WORKDIR /zlib
RUN emconfigure ./configure --prefix=$TARGET --static
RUN make install

FROM glib-emscripten-base AS libffi-emscripten-dev
ARG FFI_VERSION
RUN mkdir -p /libffi
RUN git clone https://github.com/libffi/libffi /libffi
WORKDIR /libffi
RUN git checkout $FFI_VERSION
# Karkhana carried patch: the wasm32 DEREF macros index the heap with a signed
# shift (addr >> 2). Pointers above 2 GiB go negative, the read returns
# undefined, and ffi_call_js dies with "Cannot convert undefined to a BigInt"
# (or silently passes 0 for 32-bit args). A 3000 MB heap puts helper arguments
# there once guest RAM is above ~1 GiB. Upstream master still has it.
RUN sed -i -E 's/HEAP(U?)(8|16|32|64|F32|F64)\[\(addr >> ([123])\)/HEAP\1\2[((addr) >>> \3)/' src/wasm32/ffi.c \
    && ! grep -nE 'define DEREF.*addr >> [123]' src/wasm32/ffi.c \
    && grep -c 'addr) >>> ' src/wasm32/ffi.c
RUN autoreconf -fiv
RUN emconfigure ./configure --host=$CHOST --prefix=$TARGET --enable-static --disable-shared --disable-dependency-tracking \
    --disable-builddir --disable-multi-os-directory --disable-raw-api --disable-structs --disable-docs || cat config.log
RUN emmake make install SUBDIRS='include'

FROM glib-emscripten-base AS glib-emscripten-dev
ARG GLIB_VERSION
ARG GLIB_MINOR_VERSION
RUN mkdir -p /stub
WORKDIR /stub
RUN <<EOF
cat <<'EOT' > res_query.c
#include <netdb.h>
int res_query(const char *name, int class, int type, unsigned char *dest, int len)
{
    h_errno = HOST_NOT_FOUND;
    return -1;
}
EOT
EOF
RUN emcc ${CFLAGS} -c res_query.c -fPIC -o libresolv.o
RUN ar rcs libresolv.a libresolv.o
RUN mkdir -p $TARGET/lib/
RUN cp libresolv.a $TARGET/lib/

RUN mkdir -p /glib
RUN curl -Lks https://download.gnome.org/sources/glib/${GLIB_MINOR_VERSION}/glib-$GLIB_VERSION.tar.xz | tar xJC /glib --strip-components=1

COPY --link --from=zlib-emscripten-dev /glib-emscripten/ /glib-emscripten/
COPY --link --from=libffi-emscripten-dev /glib-emscripten/ /glib-emscripten/

WORKDIR /glib
ENV CFLAGS="-Wno-error=incompatible-function-pointer-types -Wincompatible-function-pointer-types -O2 -matomics -mbulk-memory -DNDEBUG -pthread -sWASM_BIGINT -sMALLOC=emmalloc -sASYNCIFY=1"
ENV CXXFLAGS="$CFLAGS"
RUN <<EOF
cat <<'EOT' > /emcc-meson-wrap.sh
#!/bin/bash
set -euo pipefail
old_string="-Werror=unused-command-line-argument"
# emscripten ignores some -s flags during compilation with warnings. Meson checking phase fails when it sees these warnings.
new_string="-Wno-error=unused-command-line-argument"
cmd="$1"
shift
new_args=()
for arg in "$@"; do
  new_arg="${arg//$old_string/$new_string}"
  new_args+=("$new_arg")
done
"$cmd" "${new_args[@]}"
EOT
EOF
RUN <<EOF
cat <<'EOT' > /cross.meson
[host_machine]
system = 'emscripten'
cpu_family = 'wasm32'
cpu = 'wasm32'
endian = 'little'

[binaries]
c = ['bash', '/emcc-meson-wrap.sh', 'emcc']
cpp = ['bash', '/emcc-meson-wrap.sh', 'em++']
ar = 'emar'
ranlib = 'emranlib'
pkgconfig = ['pkg-config', '--static']
EOT
EOF
RUN meson setup _build --prefix=$TARGET --cross-file=/cross.meson --default-library=static --buildtype=release \
    --force-fallback-for=pcre2,gvdb -Dselinux=disabled -Dxattr=false -Dlibmount=disabled -Dnls=disabled \
    -Dtests=false -Dglib_assert=false -Dglib_checks=false
RUN sed -i -E "/#define HAVE_CLOSE_RANGE 1/d" ./_build/config.h
RUN sed -i -E "/#define HAVE_EPOLL_CREATE 1/d" ./_build/config.h
RUN sed -i -E "/#define HAVE_KQUEUE 1/d" ./_build/config.h
RUN sed -i -E "/#define HAVE_POSIX_SPAWN 1/d" ./_build/config.h
RUN sed -i -E "/#define HAVE_FALLOCATE 1/d" ./_build/config.h
RUN meson install -C _build

FROM glib-emscripten-base AS pixman-emscripten-dev
ARG PIXMAN_VERSION
RUN mkdir /pixman/
RUN git clone  https://gitlab.freedesktop.org/pixman/pixman /pixman/
WORKDIR /pixman
RUN git checkout pixman-$PIXMAN_VERSION
RUN NOCONFIGURE=y ./autogen.sh
RUN emconfigure ./configure --prefix=/glib-emscripten/target/
RUN emmake make -j$(nproc)
RUN emmake make install
RUN rm /glib-emscripten/target/lib/libpixman-1.so /glib-emscripten/target/lib/libpixman-1.so.0 /glib-emscripten/target/lib/libpixman-1.so.$PIXMAN_VERSION

FROM ubuntu:22.04 AS gcc-x86-64-linux-gnu-base
RUN apt-get update && apt-get install -y gcc-x86-64-linux-gnu linux-libc-dev-amd64-cross git make

FROM gcc-x86-64-linux-gnu-base AS linux-amd64-dev-common
RUN apt-get update && apt-get install -y gperf flex bison bc
RUN mkdir /work-buildlinux
WORKDIR /work-buildlinux
RUN git clone -b v6.1 --depth 1 https://github.com/torvalds/linux

FROM linux-amd64-dev-common AS linux-amd64-dev
RUN apt-get install -y libelf-dev
WORKDIR /work-buildlinux/linux
COPY --link --from=assets ./config/bochs/linux_x86_config ./.config
RUN make ARCH=x86 CROSS_COMPILE=x86_64-linux-gnu- -j$(nproc) all && \
    mkdir /out && \
    mv /work-buildlinux/linux/arch/x86/boot/bzImage /out/bzImage && \
    make clean

FROM linux-amd64-dev-common AS linux-amd64-config-dev
WORKDIR /work-buildlinux/linux
COPY --link --from=assets ./config/bochs/linux_x86_config ./.config
RUN make ARCH=x86 CROSS_COMPILE=x86_64-linux-gnu- olddefconfig

FROM scratch AS linux-amd64-config
COPY --link --from=linux-amd64-config-dev /work-buildlinux/linux/.config /

FROM gcc-x86-64-linux-gnu-base AS busybox-amd64-dev
ARG BUSYBOX_VERSION
RUN apt-get update -y && apt-get install -y gcc bzip2 wget
WORKDIR /work
RUN wget https://busybox.net/downloads/busybox-${BUSYBOX_VERSION}.tar.bz2
RUN bzip2 -d busybox-${BUSYBOX_VERSION}.tar.bz2
RUN tar xvf busybox-${BUSYBOX_VERSION}.tar
WORKDIR /work/busybox-${BUSYBOX_VERSION}
RUN make CROSS_COMPILE=x86_64-linux-gnu- LDFLAGS=--static defconfig
RUN make CROSS_COMPILE=x86_64-linux-gnu- LDFLAGS=--static -j$(nproc)
RUN mkdir -p /out/bin && mv busybox /out/bin/busybox
RUN make LDFLAGS=--static defconfig
RUN make LDFLAGS=--static -j$(nproc)
RUN for i in $(./busybox --list) ; do ln -s busybox /out/bin/$i ; done
RUN mkdir -p /out/usr/share/udhcpc/ && cp ./examples/udhcp/simple.script /out/usr/share/udhcpc/default.script

FROM golang-base AS runc-amd64-dev
ARG RUNC_VERSION
RUN apt-get update -y && apt-get install -y git make gperf
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    git clone https://github.com/opencontainers/runc.git /go/src/github.com/opencontainers/runc && \
    cd /go/src/github.com/opencontainers/runc && \
    git checkout "${RUNC_VERSION}" && \
    make static GOARCH=amd64 CC=gcc EXTRA_LDFLAGS='-s -w' BUILDTAGS="" EXTRA_LDFLAGS='-s -w' BUILDTAGS="" && \
    mkdir -p /out/ && mv runc /out/runc

FROM gcc-x86-64-linux-gnu-base AS tini-amd64-dev
# https://github.com/krallin/tini#building-tini
RUN apt-get update -y && apt-get install -y cmake
ENV CFLAGS="-DPR_SET_CHILD_SUBREAPER=36 -DPR_GET_CHILD_SUBREAPER=37"
WORKDIR /work
RUN git clone -b v0.19.0 https://github.com/krallin/tini
WORKDIR /work/tini
ENV CC="x86_64-linux-gnu-gcc -static"
RUN cmake . && make && mkdir /out/ && mv tini /out/

FROM gcc-x86-64-linux-gnu-base AS grub-amd64-dev
ARG LINUX_LOGLEVEL
RUN apt-get update && apt-get install -y mkisofs xorriso wget bison flex python-is-python3 gettext
WORKDIR /work/
RUN wget https://ftp.gnu.org/gnu/grub/grub-2.06.tar.gz
RUN tar zxvf grub-2.06.tar.gz
WORKDIR /work/grub-2.06
RUN ./configure --target=i386
RUN make -j$(nproc)
RUN make install
RUN mkdir -p /iso/boot/grub
COPY --link --from=linux-amd64-dev /out/bzImage /iso/boot/grub/
COPY --link --from=assets ./config/bochs/grub.cfg.template /
RUN cat /grub.cfg.template | LOGLEVEL=$LINUX_LOGLEVEL envsubst > /iso/boot/grub/grub.cfg
RUN mkdir /out && grub-mkrescue --directory ./grub-core -o /out/boot.iso /iso

FROM ubuntu AS bios-amd64-dev
RUN apt-get update && apt-get install -y build-essential git
COPY --link --from=bochs-repo / /Bochs
WORKDIR /Bochs/bochs
RUN CC="x86_64-linux-gnu-gcc" ./configure --enable-x86-64 --with-nogui
RUN make -j$(nproc) bios/BIOS-bochs-latest bios/VGABIOS-lgpl-latest
RUN mkdir /out/ && mv bios/BIOS-bochs-latest bios/VGABIOS-lgpl-latest /out/

FROM golang-base AS init-amd64-dev
COPY --link --from=assets / /work
WORKDIR /work
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    GOARCH=amd64 go build -ldflags "-s -w -extldflags '-static'" -tags "osusergo netgo static_build" -o /out/init ./cmd/init

FROM gcc-x86-64-linux-gnu-base AS vmtouch-amd64-dev
RUN git clone https://github.com/hoytech/vmtouch.git && \
    cd vmtouch && \
    CC="x86_64-linux-gnu-gcc -static" make && \
    mkdir /out && mv vmtouch /out/

FROM ubuntu:22.04 AS rootfs-amd64-dev
RUN apt-get update -y && apt-get install -y squashfs-tools
COPY --link --from=busybox-amd64-dev /out/ /rootfs/
COPY --link --from=runc-amd64-dev /out/runc /rootfs/sbin/runc
COPY --link --from=bundle-dev /out/ /rootfs/
COPY --link --from=init-amd64-dev /out/init /rootfs/sbin/init
COPY --link --from=vmtouch-amd64-dev /out/vmtouch /rootfs/bin/
COPY --link --from=tini-amd64-dev /out/tini /rootfs/sbin/tini
RUN mkdir -p /rootfs/proc /rootfs/sys /rootfs/mnt /rootfs/run /rootfs/tmp /rootfs/dev /rootfs/var /rootfs/etc && mknod /rootfs/dev/null c 1 3 && chmod 666 /rootfs/dev/null
# Karkhana carried patch: squashfs (zstd) instead of an uncompressed ISO9660.
# The ISO was 536 MB of the 627 MB engine download. The kernel mounts
# root=/dev/vda with no rootfstype and probes every built-in filesystem, and
# c2w's init never names the root fs type, so only the kernel needs to know it.
RUN mkdir /out/ && mksquashfs /rootfs/ /out/rootfs.bin -comp zstd -no-xattrs -noappend

FROM ubuntu:22.04 AS bochs-config-dev
ARG VM_MEMORY_SIZE_MB
RUN apt-get update && apt-get install -y gettext-base && mkdir /out
COPY --link --from=assets ./config/bochs/bochsrc.template /
RUN cat /bochsrc.template | MEMORY_SIZE=$VM_MEMORY_SIZE_MB envsubst > /out/bochsrc

FROM scratch AS vm-amd64-dev
COPY --link --from=grub-amd64-dev /out/boot.iso /pack/
COPY --link --from=bios-amd64-dev /out/ /pack/
COPY --link --from=rootfs-amd64-dev /out/rootfs.bin /pack/
COPY --link --from=bochs-config-dev /out/bochsrc /pack/

FROM ubuntu:22.04 AS gcc-aarch64-linux-gnu-base
RUN apt-get update && apt-get install -y gcc-aarch64-linux-gnu linux-libc-dev-arm64-cross git make

FROM gcc-aarch64-linux-gnu-base AS linux-aarch64-dev-common
RUN apt-get update && apt-get install -y gperf flex bison bc
RUN mkdir /work-buildlinux
WORKDIR /work-buildlinux
RUN git clone -b v6.1 --depth 1 https://github.com/torvalds/linux

FROM linux-aarch64-dev-common AS linux-aarch64-dev-qemu
RUN apt-get install -y libelf-dev
WORKDIR /work-buildlinux/linux
COPY --link --from=assets ./config/qemu/linux_arm64_config ./.config
RUN make ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- -j$(nproc) all && \
    mkdir /out && \
    mv /work-buildlinux/linux/arch/arm64/boot/Image /out/bzImage && \
    make clean

FROM linux-aarch64-dev-common AS linux-aarch64-config-dev
WORKDIR /work-buildlinux/linux
COPY --link --from=assets ./config/qemu/linux_arm64_config ./.config
RUN make ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu- olddefconfig

FROM scratch AS linux-aarch64-config
COPY --link --from=linux-aarch64-config-dev /work-buildlinux/linux/.config /

FROM gcc-aarch64-linux-gnu-base AS busybox-aarch64-dev
ARG BUSYBOX_VERSION
RUN apt-get update -y && apt-get install -y gcc bzip2 wget
WORKDIR /work
RUN wget https://busybox.net/downloads/busybox-${BUSYBOX_VERSION}.tar.bz2
RUN bzip2 -d busybox-${BUSYBOX_VERSION}.tar.bz2
RUN tar xvf busybox-${BUSYBOX_VERSION}.tar
WORKDIR /work/busybox-${BUSYBOX_VERSION}
RUN make CROSS_COMPILE=aarch64-linux-gnu- LDFLAGS=--static defconfig
RUN make CROSS_COMPILE=aarch64-linux-gnu- LDFLAGS=--static -j$(nproc)
RUN mkdir -p /out/bin && mv busybox /out/bin/busybox
RUN make LDFLAGS=--static defconfig
RUN make LDFLAGS=--static -j$(nproc)
RUN for i in $(./busybox --list) ; do ln -s busybox /out/bin/$i ; done
RUN mkdir -p /out/usr/share/udhcpc/ && cp ./examples/udhcp/simple.script /out/usr/share/udhcpc/default.script

FROM golang-base AS runc-aarch64-dev
ARG RUNC_VERSION
RUN apt-get update -y && apt-get install -y git make gperf
RUN apt-get update -y && apt-get install -y gcc-aarch64-linux-gnu libc-dev-arm64-cross
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    git clone https://github.com/opencontainers/runc.git /go/src/github.com/opencontainers/runc && \
    cd /go/src/github.com/opencontainers/runc && \
    git checkout "${RUNC_VERSION}" && \
    make static GOARCH=arm64 CC=aarch64-linux-gnu-gcc EXTRA_LDFLAGS='-s -w' BUILDTAGS="" EXTRA_LDFLAGS='-s -w' BUILDTAGS="" && \
    mkdir -p /out/ && mv runc /out/runc

FROM gcc-aarch64-linux-gnu-base AS vmtouch-aarch64-dev
RUN git clone https://github.com/hoytech/vmtouch.git && \
    cd vmtouch && \
    CC="aarch64-linux-gnu-gcc -static" make && \
    mkdir /out && mv vmtouch /out/

FROM gcc-aarch64-linux-gnu-base AS tini-aarch64-dev
# https://github.com/krallin/tini#building-tini
RUN apt-get update -y && apt-get install -y cmake
ENV CFLAGS="-DPR_SET_CHILD_SUBREAPER=36 -DPR_GET_CHILD_SUBREAPER=37"
WORKDIR /work
RUN git clone -b v0.19.0 https://github.com/krallin/tini
WORKDIR /work/tini
ENV CC="aarch64-linux-gnu-gcc -static"
RUN cmake . && make && mkdir /out/ && mv tini /out/

FROM golang-base AS init-aarch64-dev
COPY --link --from=assets / /work
WORKDIR /work
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    GOARCH=arm64 go build -ldflags "-s -w -extldflags '-static'" -tags "osusergo netgo static_build" -o /out/init ./cmd/init

FROM ubuntu:22.04 AS rootfs-aarch64-dev
RUN apt-get update -y && apt-get install -y mkisofs
COPY --link --from=busybox-aarch64-dev /out/ /rootfs/
COPY --link --from=runc-aarch64-dev /out/runc /rootfs/sbin/runc
COPY --link --from=bundle-dev /out/ /rootfs/
COPY --link --from=init-aarch64-dev /out/init /rootfs/sbin/init
COPY --link --from=vmtouch-aarch64-dev /out/vmtouch /rootfs/bin/
COPY --link --from=tini-aarch64-dev /out/tini /rootfs/sbin/tini
RUN mkdir -p /rootfs/proc /rootfs/sys /rootfs/mnt /rootfs/run /rootfs/tmp /rootfs/dev /rootfs/var /rootfs/etc && mknod /rootfs/dev/null c 1 3 && chmod 666 /rootfs/dev/null
RUN mkdir /out/ && mkisofs -R -o /out/rootfs.bin /rootfs/

FROM linux-amd64-dev-common AS linux-amd64-dev-qemu
RUN apt-get install -y libelf-dev
WORKDIR /work-buildlinux/linux
COPY --link --from=assets ./config/qemu/linux_x86_config ./.config
# Karkhana carried patch: virtio-rng so the crng initializes at boot instead of
# blocking TLS (getrandom) for minutes under TCG jitter-entropy.
RUN echo 'CONFIG_HW_RANDOM_VIRTIO=y' >> .config
# Karkhana carried patch: the rootfs is squashfs+zstd (see rootfs-amd64-dev).
# olddefconfig resolves the new symbols' dependencies (ZSTD_DECOMPRESS).
RUN echo 'CONFIG_SQUASHFS=y' >> .config && echo 'CONFIG_SQUASHFS_ZSTD=y' >> .config \
    && make ARCH=x86 CROSS_COMPILE=x86_64-linux-gnu- olddefconfig \
    && grep -q '^CONFIG_SQUASHFS_ZSTD=y' .config
RUN make ARCH=x86 CROSS_COMPILE=x86_64-linux-gnu- -j$(nproc) all && \
    mkdir /out && \
    mv /work-buildlinux/linux/arch/x86/boot/bzImage /out/bzImage && \
    make clean

FROM linux-amd64-dev-common AS linux-amd64-config-dev-qemu
WORKDIR /work-buildlinux/linux
COPY --link --from=assets /config/qemu/linux_x86_config ./.config
RUN make ARCH=x86 CROSS_COMPILE=x86_64-linux-gnu- olddefconfig

FROM scratch AS linux-amd64-config-qemu
COPY --link --from=linux-amd64-config-dev-qemu /work-buildlinux/linux/.config /

FROM glib-emscripten-base AS qemu-emscripten-dev
COPY --link --from=qemu-repo / /qemu
WORKDIR /qemu
COPY --link --from=zlib-emscripten-dev /glib-emscripten/ /glib-emscripten/
COPY --link --from=glib-emscripten-dev /glib-emscripten/ /glib-emscripten/
COPY --link --from=pixman-emscripten-dev /glib-emscripten/ /glib-emscripten/
RUN mkdir -p build
WORKDIR /qemu/build
RUN npm i xterm-pty@v0.10.1
# Karkhana: preserve nonblocking reads, avoid a missed readable event, and keep
# heap indices unsigned above 2 GiB. QEMU dispatches stdio with its I/O mutex held;
# a blocking read here can stop the VM. Keep the shipped out.js in sync.
RUN python3 - <<'PY'
from pathlib import Path
p = Path('/qemu/build/node_modules/xterm-pty/emscripten-pty.js')
s = p.read_text()
patches = {
    'PTY_atomicIndex = _malloc(4) >> 2;':
        'PTY_atomicIndex = _malloc(4) >>> 2;',
    '        if (PTY_pollTimeout === 0) {':
        '        if (PTY.readable) return callback(0);\n'
        '        if (PTY_pollTimeout === 0) {',
    '        if (length && !readBytes.length) {\n':
        '        if (length && !readBytes.length) {\n'
        '            if (stream.flags & {{{ cDefs.O_NONBLOCK }}}) '
        'throw new FS.ErrnoError({{{ cDefs.EAGAIN }}});\n',
}
for old, new in patches.items():
    if s.count(old) != 1:
        raise SystemExit(f'xterm-pty patch drift: expected one {old!r}')
    s = s.replace(old, new)
p.write_text(s)
PY
RUN cp /qemu/build/node_modules/xterm-pty/emscripten-pty.js /glib-emscripten/target/lib/libemscripten-pty.js
ENV XTERM_PTY_CFLAGS="-lemscripten-pty.js -Wno-unused-command-line-argument"

FROM linux-riscv64-dev-common AS linux-riscv64-config-dev-qemu
WORKDIR /work-buildlinux/linux
COPY --link --from=assets /config/qemu/linux_rv64_config ./.config
RUN make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- olddefconfig

FROM scratch AS linux-riscv64-config-qemu
COPY --link --from=linux-riscv64-config-dev-qemu /work-buildlinux/linux/.config /

FROM linux-riscv64-dev-common AS linux-riscv64-dev-qemu
RUN apt-get install -y libelf-dev
WORKDIR /work-buildlinux/linux
COPY --link --from=assets ./config/qemu/linux_rv64_config ./.config
RUN make ARCH=riscv CROSS_COMPILE=riscv64-linux-gnu- -j$(nproc) all && \
    mkdir /out && \
    mv /work-buildlinux/linux/arch/riscv/boot/Image /out/Image && \
    make clean

FROM golang-base AS get-qemu-state-dev
COPY --link --from=assets / /work
RUN mkdir /out/
WORKDIR /work
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    go build -o /out/get-qemu-state ./cmd/get-qemu-state

FROM ubuntu:22.04 AS qemu-config-dev-amd64
ARG LINUX_LOGLEVEL
ARG VM_MEMORY_SIZE_MB
ARG VM_CORE_NUMS
ARG QEMU_MIGRATION
RUN apt-get update && apt-get install -y gettext-base && mkdir /out
COPY --link --from=assets /config/qemu/args-x86_64.json.template /args.json.template
# Keep native snapshot creation and browser restoration on the same CPU model.
# x86-64-v2 supports Bun's Nehalem baseline. AES/PCLMUL expose guest TLS crypto.
# POPCNT requires the wasm backend correction below; default qemu64 lacks it.
RUN test "$(grep -o '"-nographic",' /args.json.template | wc -l)" -eq 1 && \
    ! grep -q '"-cpu"' /args.json.template && \
    sed -i 's/"-nographic",/"-cpu", "qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt,+cx16,+aes,+pclmulqdq", "-nographic",/' /args.json.template
RUN sed -i 's/security_model=passthrough,id=wasi0/security_model=none,id=wasi0/' /args.json.template
RUN sed -i 's/"-nographic",/"-object", "rng-builtin,id=rng0", "-device", "virtio-rng-pci,rng=rng0", "-nographic",/' /args.json.template
# The persistent disk is the second virtio drive, after the rootfs, so it is
# /dev/vdb and existing devices keep their PCI slots. Snapshot creation and the
# browser use the same path: the native stage puts the template there, and the
# page supplies the user's OPFS disk or an in-memory template copy.
RUN test "$(grep -c '"-drive", "if=virtio,format=raw,file=/pack/rootfs.bin",' /args.json.template)" -eq 1 && \
    sed -i 's|"-drive", "if=virtio,format=raw,file=/pack/rootfs.bin",|&\n    "-drive", "if=virtio,format=qcow2,file=/kdisk/disk.qcow2,werror=report,rerror=report",|' /args.json.template
# The rootfs is read-only (squashfs, mounted ro), and saying so lets savevm run:
# savevm refuses a writable disk that cannot hold snapshots. Karkhana saves a
# running machine with savevm into /kdisk/disk.qcow2, on QEMU's main loop
# thread. `migrate` would do the block-layer work on a migration thread, and a
# coroutine resumed on another thread crashes under Emscripten's Asyncify
# fibers ("func is not a function" in Asyncify.doRewind).
RUN sed -i 's|"-drive", "if=virtio,format=raw,file=/pack/rootfs.bin",|"-drive", "if=virtio,format=raw,file=/pack/rootfs.bin,readonly=on",|' /args.json.template && \
    test "$(grep -c 'rootfs.bin,readonly=on' /args.json.template)" -eq 1
RUN MIGRATION_FLAGS= ; \
    if test "${QEMU_MIGRATION}" = "true"  ; then \
      MIGRATION_FLAGS='"-incoming", "file:/pack/vm.state",' ; \
    fi && \
    cat /args.json.template | LOGLEVEL=$LINUX_LOGLEVEL MEMORY_SIZE=$VM_MEMORY_SIZE_MB CORE_NUMS=$VM_CORE_NUMS MIGRATION="" WASI0_PATH=/tmp/wasi0 WASI1_PATH=/tmp/wasi1 envsubst > /out/args-before-cp.json && \
    cat /args.json.template | LOGLEVEL=$LINUX_LOGLEVEL MEMORY_SIZE=$VM_MEMORY_SIZE_MB CORE_NUMS=$VM_CORE_NUMS MIGRATION=$MIGRATION_FLAGS WASI0_PATH=/ WASI1_PATH=/pack envsubst > /out/args.json
RUN echo "Module['arguments'] =" > /out/arg-module.js
RUN cat /out/args.json >> /out/arg-module.js
RUN echo ";" >> /out/arg-module.js

FROM ubuntu:22.04 AS qemu-config-dev-aarch64
ARG LINUX_LOGLEVEL
ARG VM_MEMORY_SIZE_MB
ARG VM_CORE_NUMS
ARG QEMU_MIGRATION
RUN apt-get update && apt-get install -y gettext-base && mkdir /out
COPY --link --from=assets /config/qemu/args-aarch64.json.template /args.json.template
RUN MIGRATION_FLAGS= ; \
    if test "${QEMU_MIGRATION}" = "true"  ; then \
      MIGRATION_FLAGS='"-incoming", "file:/pack/vm.state",' ; \
    fi && \
    cat /args.json.template | LOGLEVEL=$LINUX_LOGLEVEL MEMORY_SIZE=$VM_MEMORY_SIZE_MB CORE_NUMS=$VM_CORE_NUMS MIGRATION="" WASI0_PATH=/tmp/wasi0 WASI1_PATH=/tmp/wasi1 envsubst > /out/args-before-cp.json && \
    cat /args.json.template | LOGLEVEL=$LINUX_LOGLEVEL MEMORY_SIZE=$VM_MEMORY_SIZE_MB CORE_NUMS=$VM_CORE_NUMS MIGRATION=$MIGRATION_FLAGS WASI0_PATH=/ WASI1_PATH=/pack envsubst > /out/args.json
RUN echo "Module['arguments'] =" > /out/arg-module.js
RUN cat /out/args.json >> /out/arg-module.js
RUN echo ";" >> /out/arg-module.js

FROM ubuntu:22.04 AS qemu-config-dev-riscv64
ARG LINUX_LOGLEVEL
ARG VM_MEMORY_SIZE_MB
ARG VM_CORE_NUMS
ARG QEMU_MIGRATION
RUN apt-get update && apt-get install -y gettext-base && mkdir /out
COPY --link --from=assets /config/qemu/args-riscv64.json.template /args.json.template
RUN MIGRATION_FLAGS= ; \
    if test "${QEMU_MIGRATION}" = "true"  ; then \
      MIGRATION_FLAGS='"-incoming", "file:/pack/vm.state",' ; \
    fi && \
    cat /args.json.template | LOGLEVEL=$LINUX_LOGLEVEL MEMORY_SIZE=$VM_MEMORY_SIZE_MB CORE_NUMS=$VM_CORE_NUMS MIGRATION="" WASI0_PATH=/tmp/wasi0 WASI1_PATH=/tmp/wasi1 envsubst > /out/args-before-cp.json && \
    cat /args.json.template | LOGLEVEL=$LINUX_LOGLEVEL MEMORY_SIZE=$VM_MEMORY_SIZE_MB CORE_NUMS=$VM_CORE_NUMS MIGRATION=$MIGRATION_FLAGS WASI0_PATH=/ WASI1_PATH=/pack envsubst > /out/args.json
RUN echo "Module['arguments'] =" > /out/arg-module.js
RUN cat /out/args.json >> /out/arg-module.js
RUN echo ";" >> /out/arg-module.js

# Karkhana: the persistent disk's starting image. ext4 on a 16 GiB qcow2: the
# inode tables and journal are zeroed now, and qemu-img stores no zero
# clusters, so a new disk costs about 6.4 MiB and the kernel never zeroes it
# later. Debian 12's mke2fs matches the guest's userland; Linux 6.1 mounts it.
FROM debian:12-slim AS kdisk-template
RUN apt-get update && apt-get install -y --no-install-recommends e2fsprogs qemu-utils && \
    rm -rf /var/lib/apt/lists/*
RUN mkdir /out && truncate -s 16G /tmp/raw && \
    mkfs.ext4 -q -F -m 0 -L karkhana -J size=32 -E lazy_itable_init=0,lazy_journal_init=0,nodiscard /tmp/raw && \
    qemu-img convert -O qcow2 -o cluster_size=65536 /tmp/raw /out/disk.qcow2 && \
    rm /tmp/raw && gzip -9 -n -k /out/disk.qcow2

FROM gcc:14 AS qemu-native-dev
RUN apt-get update && apt-get install -y libffi-dev libglib2.0-dev libpixman-1-dev libattr1 libattr1-dev ninja-build pipx
RUN PIPX_BIN_DIR=/usr/local/bin pipx install meson==1.5.0
COPY --link --from=qemu-repo / /qemu

FROM qemu-native-dev AS qemu-x86_64-pack
WORKDIR /qemu/build/
RUN ../configure --static --target-list=x86_64-softmmu --cross-prefix= \
    --without-default-features --enable-system --with-coroutine=ucontext --enable-virtfs --enable-attr
RUN make -j $(nproc) qemu-system-x86_64

RUN mkdir -p /pack/
COPY --link --from=rootfs-amd64-dev /out/rootfs.bin /pack/
COPY --link --from=linux-amd64-dev-qemu /out/bzImage /pack/
RUN cp /qemu/pc-bios/bios-256k.bin /pack/
RUN cp /qemu/pc-bios/kvmvapic.bin /pack/
RUN cp /qemu/pc-bios/linuxboot_dma.bin /pack/
RUN cp /qemu/pc-bios/vgabios-stdvga.bin /pack/
RUN cp /qemu/pc-bios/efi-virtio.rom /pack/

COPY --link --from=get-qemu-state-dev /out/get-qemu-state /get-qemu-state
COPY --link --from=qemu-config-dev-amd64 /out/args-before-cp.json /
# Outside /pack: the snapshot needs the device, the engine's .data does not.
COPY --link --from=kdisk-template /out/disk.qcow2 /kdisk/disk.qcow2
RUN mkdir -p /tmp/wasi0 /tmp/wasi1
WORKDIR /qemu/build/
ARG QEMU_MIGRATION
RUN if test "${QEMU_MIGRATION}" = "true"  ; then /get-qemu-state -output=/pack/vm.state --args-json=/args-before-cp.json ./qemu-system-x86_64 ; fi

FROM qemu-native-dev AS qemu-aarch64-pack
WORKDIR /qemu/build/
RUN ../configure --static --target-list=aarch64-softmmu --cross-prefix= \
    --without-default-features --enable-system --with-coroutine=ucontext --enable-virtfs --enable-attr
RUN make -j $(nproc) qemu-system-aarch64

RUN mkdir -p /pack/
COPY --link --from=rootfs-aarch64-dev /out/rootfs.bin /pack/
COPY --link --from=linux-aarch64-dev-qemu /out/bzImage /pack/
RUN cp /qemu/pc-bios/edk2-aarch64-code.fd.bz2 /pack/
RUN bzip2 -d /pack/edk2-aarch64-code.fd.bz2
RUN cp /qemu/pc-bios/efi-virtio.rom /pack/

COPY --link --from=get-qemu-state-dev /out/get-qemu-state /get-qemu-state
COPY --link --from=qemu-config-dev-aarch64 /out/args-before-cp.json /
RUN mkdir -p /tmp/wasi0 /tmp/wasi1
WORKDIR /qemu/build/
ARG QEMU_MIGRATION
RUN if test "${QEMU_MIGRATION}" = "true"  ; then /get-qemu-state -output=/pack/vm.state --args-json=/args-before-cp.json ./qemu-system-aarch64 ; fi

FROM qemu-native-dev AS qemu-riscv64-pack
WORKDIR /qemu/build/
RUN ../configure --static --target-list=riscv64-softmmu --cross-prefix= \
    --without-default-features --enable-system --with-coroutine=ucontext --enable-virtfs --enable-attr
RUN make -j $(nproc) qemu-system-riscv64

RUN mkdir -p /pack/
COPY --link --from=rootfs-riscv64-dev /out/rootfs.bin /pack/
COPY --link --from=linux-riscv64-dev-qemu /out/Image /pack/
RUN cp /qemu/pc-bios/opensbi-riscv64-generic-fw_dynamic.bin /pack/
RUN cp /qemu/pc-bios/efi-virtio.rom /pack/

COPY --link --from=get-qemu-state-dev /out/get-qemu-state /get-qemu-state
COPY --link --from=qemu-config-dev-riscv64 /out/args-before-cp.json /
RUN mkdir -p /tmp/wasi0 /tmp/wasi1
WORKDIR /qemu/build/
ARG QEMU_MIGRATION
RUN if test "${QEMU_MIGRATION}" = "true"  ; then /get-qemu-state -output=/pack/vm.state --args-json=/args-before-cp.json ./qemu-system-riscv64 ; fi

FROM qemu-emscripten-dev AS qemu-emscripten-dev-amd64
ARG LOAD_MODE
# Karkhana: wasm POPCNT operands and result type.
# ctpop has one output and one input. The original operand indexes corrupt
# registers when Go selects POPCNT, killing init before the container starts.
# All Wasm register globals hold i64, including zero-extended i32 results.
RUN python3 - <<'PY'
from pathlib import Path
p = Path('/qemu/tcg/wasm32/tcg-target.c.inc')
s = p.read_text()
patches = {
    'tcg_out_ctpop_i32(s, opc, args[1], args[2]);':
        'tcg_out_ctpop_i32(s, opc, args[0], args[1]);',
    'tcg_out_ctpop_i64(s, opc, args[1], args[2]);':
        'tcg_out_ctpop_i64(s, opc, args[0], args[1]);',
    '    tcg_wasm_out_op_i32_popcnt(s);\n    tcg_wasm_out_op_global_set_r(s, dest);':
        '    tcg_wasm_out_op_i32_popcnt(s);\n'
        '    tcg_wasm_out_op_i64_extend_i32_u(s);\n'
        '    tcg_wasm_out_op_global_set_r(s, dest);',
}
for old, new in patches.items():
    assert s.count(old) == 1, f'POPCNT patch drift: {old}'
    s = s.replace(old, new)
p.write_text(s)
PY
RUN EXTRA_CFLAGS="-O3 -g -Wno-error=unused-command-line-argument -Wno-error=unused-but-set-variable -matomics -mbulk-memory -DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE -sASYNCIFY=1 -pthread -sPROXY_TO_PTHREAD=1 -sFORCE_FILESYSTEM -sALLOW_TABLE_GROWTH -sTOTAL_MEMORY=$((3000*1024*1024)) -sSTACK_SIZE=4MB -sWASM_BIGINT -sMALLOC=emmalloc -sEXPORT_ES6=1 -sASYNCIFY_IMPORTS=ffi_call_js $XTERM_PTY_CFLAGS " ; \
    emconfigure ../configure --static --target-list=x86_64-softmmu --cpu=wasm32 --cross-prefix= \
    --without-default-features --enable-system --with-coroutine=fiber --enable-virtfs \
    --extra-cflags="$EXTRA_CFLAGS" --extra-cxxflags="$EXTRA_CFLAGS" --extra-ldflags="-sEXPORTED_RUNTIME_METHODS=addFunction,removeFunction,TTY,FS" && \
    emmake make -j $(nproc) qemu-system-x86_64
COPY --from=qemu-x86_64-pack /pack /pack
RUN if test "${LOAD_MODE}" = "single" ; then \
      /emsdk/upstream/emscripten/tools/file_packager.py qemu-system-x86_64.data --preload /pack > load.js ; \
    else \
      mkdir /load && \
      mkdir /image && cp /pack/bzImage /image/ && /emsdk/upstream/emscripten/tools/file_packager.py /load/image.data --preload /image > /load/image-load.js && \
      mkdir /rootfs && cp /pack/rootfs.bin /rootfs/ && /emsdk/upstream/emscripten/tools/file_packager.py /load/rootfs.data --preload /rootfs > /load/rootfs-load.js && \
      mkdir /bios && \
      cp /pack/bios-256k.bin /bios/ && \
      cp /pack/kvmvapic.bin /bios/ && \
      cp /pack/linuxboot_dma.bin /bios/ && \
      cp /pack/vgabios-stdvga.bin /bios/ && \
      /emsdk/upstream/emscripten/tools/file_packager.py /load/bios.data --preload /bios > /load/bios-load.js ; \
    fi

FROM scratch AS js-qemu-amd64-base
COPY --link --from=qemu-emscripten-dev-amd64 /qemu/build/qemu-system-x86_64 /out.js
COPY --link --from=qemu-emscripten-dev-amd64 /qemu/build/qemu-system-x86_64.wasm /
COPY --link --from=qemu-config-dev-amd64 /out/arg-module.js /
COPY --link --from=kdisk-template /out/disk.qcow2.gz /kdisk.qcow2.gz

FROM js-qemu-amd64-base AS js-qemu-amd64-single
COPY --link --from=qemu-emscripten-dev-amd64 /qemu/build/qemu-system-x86_64.data /
COPY --link --from=qemu-emscripten-dev-amd64 /qemu/build/load.js /

FROM js-qemu-amd64-base AS js-qemu-amd64-separated
COPY --link --from=qemu-emscripten-dev-amd64 /load /

FROM js-qemu-amd64-${LOAD_MODE} AS js-qemu-amd64

FROM qemu-emscripten-dev AS qemu-emscripten-dev-aarch64
ARG LOAD_MODE
RUN EXTRA_CFLAGS="-O3 -fno-inline-functions -g -Wno-error=unused-command-line-argument -matomics -mbulk-memory -DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE -sASYNCIFY=1 -pthread -sPROXY_TO_PTHREAD=1 -sFORCE_FILESYSTEM -sALLOW_TABLE_GROWTH -sTOTAL_MEMORY=2300MB -sWASM_BIGINT -sMALLOC=emmalloc -sEXPORT_ES6=1 $XTERM_PTY_CFLAGS " ; \
    emconfigure ../configure --static --target-list=aarch64-softmmu --cpu=wasm32 --cross-prefix= \
    --without-default-features --enable-system --with-coroutine=fiber --enable-virtfs \
    --extra-cflags="$EXTRA_CFLAGS" --extra-cxxflags="$EXTRA_CFLAGS" --extra-ldflags="-sEXPORTED_RUNTIME_METHODS=addFunction,removeFunction,TTY,FS" && \
    emmake make -j $(nproc) qemu-system-aarch64
COPY --from=qemu-aarch64-pack /pack /pack
RUN if test "${LOAD_MODE}" = "single" ; then \
      /emsdk/upstream/emscripten/tools/file_packager.py qemu-system-aarch64.data --preload /pack > load.js ; \
    else \
      mkdir /load && \
      mkdir /image && cp /pack/bzImage /image/ && /emsdk/upstream/emscripten/tools/file_packager.py /load/image.data --preload /image > /load/image-load.js && \
      mkdir /rootfs && cp /pack/rootfs.bin /rootfs/ && /emsdk/upstream/emscripten/tools/file_packager.py /load/rootfs.data --preload /rootfs > /load/rootfs-load.js && \
      mkdir /edk2 && cp /pack/edk2-aarch64-code.fd /edk2/ && /emsdk/upstream/emscripten/tools/file_packager.py /load/edk2.data --preload /edk2 > /load/edk2-load.js ; \
    fi

FROM scratch AS js-qemu-aarch64-base
COPY --link --from=qemu-emscripten-dev-aarch64 /qemu/build/qemu-system-aarch64 /out.js
COPY --link --from=qemu-emscripten-dev-aarch64 /qemu/build/qemu-system-aarch64.wasm /
COPY --link --from=qemu-config-dev-aarch64 /out/arg-module.js /

FROM js-qemu-aarch64-base AS js-qemu-aarch64-single
COPY --link --from=qemu-emscripten-dev-aarch64 /qemu/build/qemu-system-aarch64.data /
COPY --link --from=qemu-emscripten-dev-aarch64 /qemu/build/load.js /

FROM js-qemu-aarch64-base AS js-qemu-aarch64-separated
COPY --link --from=qemu-emscripten-dev-aarch64 /load /

FROM js-qemu-aarch64-$LOAD_MODE AS js-aarch64

FROM qemu-emscripten-dev AS qemu-emscripten-dev-riscv64
ARG LOAD_MODE
RUN EXTRA_CFLAGS="-O3 -g -Wno-error=unused-command-line-argument -matomics -mbulk-memory -DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE -sASYNCIFY=1 -pthread -sPROXY_TO_PTHREAD=1 -sFORCE_FILESYSTEM -sALLOW_TABLE_GROWTH -sTOTAL_MEMORY=2300MB -sWASM_BIGINT -sMALLOC=emmalloc -sEXPORT_ES6=1 -sASYNCIFY_IMPORTS=ffi_call_js $XTERM_PTY_CFLAGS " ; \
    emconfigure ../configure --static --target-list=riscv64-softmmu --cpu=wasm32 --cross-prefix= \
    --without-default-features --enable-system --with-coroutine=fiber --enable-virtfs \
    --extra-cflags="$EXTRA_CFLAGS" --extra-cxxflags="$EXTRA_CFLAGS" --extra-ldflags="-sEXPORTED_RUNTIME_METHODS=addFunction,removeFunction,TTY,FS" && \
    emmake make -j $(nproc) qemu-system-riscv64
COPY --from=qemu-riscv64-pack /pack /pack
RUN if test "${LOAD_MODE}" = "single" ; then \
      /emsdk/upstream/emscripten/tools/file_packager.py qemu-system-riscv64.data --preload /pack > load.js ; \
    else \
      mkdir /load && \
      mkdir /image && cp /pack/Image /image/ && /emsdk/upstream/emscripten/tools/file_packager.py /load/image.data --preload /image > /load/image-load.js && \
      mkdir /rootfs && cp /pack/rootfs.bin /rootfs/ && /emsdk/upstream/emscripten/tools/file_packager.py /load/rootfs.data --preload /rootfs > /load/rootfs-load.js && \
      mkdir /bios && cp /pack/opensbi-riscv64-generic-fw_dynamic.bin /bios/ && /emsdk/upstream/emscripten/tools/file_packager.py /load/bios.data --preload /bios > /load/bios-load.js ; \
    fi

FROM scratch AS js-qemu-riscv64-base
COPY --link --from=qemu-emscripten-dev-riscv64 /qemu/build/qemu-system-riscv64 /out.js
COPY --link --from=qemu-emscripten-dev-riscv64 /qemu/build/qemu-system-riscv64.wasm /
COPY --link --from=qemu-config-dev-riscv64 /out/arg-module.js /

FROM js-qemu-riscv64-base AS js-qemu-riscv64-single
COPY --link --from=qemu-emscripten-dev-riscv64 /qemu/build/qemu-system-riscv64.data /
COPY --link --from=qemu-emscripten-dev-riscv64 /qemu/build/load.js /

FROM js-qemu-riscv64-base AS js-qemu-riscv64-separated
COPY --link --from=qemu-emscripten-dev-riscv64 /load /

FROM js-qemu-riscv64-${LOAD_MODE} AS js-qemu-riscv64

FROM js-qemu-riscv64 AS js-riscv64

FROM rust:1.74.1-bullseye AS bochs-dev-common
ARG WASI_VFS_VERSION
ARG WASI_SDK_VERSION
ARG WASI_SDK_VERSION_FULL
ARG BINARYEN_VERSION
ARG WIZER_VERSION
RUN apt-get update -y && apt-get install -y make curl git gcc xz-utils

WORKDIR /wasi
RUN curl -o wasi-sdk.tar.gz -fSL https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}/wasi-sdk-${WASI_SDK_VERSION_FULL}-linux.tar.gz && \
    tar xvf wasi-sdk.tar.gz && rm wasi-sdk.tar.gz
ENV WASI_SDK_PATH=/wasi/wasi-sdk-${WASI_SDK_VERSION_FULL}

WORKDIR /work/
RUN git clone https://github.com/kateinoigakukun/wasi-vfs.git --recurse-submodules && \
    cd wasi-vfs && \
    git checkout "${WASI_VFS_VERSION}" && \
    cargo build --target wasm32-unknown-unknown && \
    cargo build --package wasi-vfs-cli && \
    mkdir -p /tools/wasi-vfs/ && \
    mv target/debug/wasi-vfs target/wasm32-unknown-unknown/debug/libwasi_vfs.a /tools/wasi-vfs/ && \
    cargo clean

WORKDIR /work/
RUN git clone https://github.com/bytecodealliance/wizer && \
    cd wizer && \
    git checkout "${WIZER_VERSION}" && \
    cargo build --bin wizer --all-features && \
    mkdir -p /tools/wizer/ && \
    mv include target/debug/wizer /tools/wizer/ && \
    cargo clean

RUN wget -O /tmp/binaryen.tar.gz https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-x86_64-linux.tar.gz
RUN mkdir -p /binaryen
RUN tar -C /binaryen -zxvf /tmp/binaryen.tar.gz

COPY --link --from=bochs-repo / /Bochs

WORKDIR /Bochs/bochs/wasi_extra/jmp
RUN mkdir /jmp && cp jmp.h /jmp/
RUN ${WASI_SDK_PATH}/bin/clang --sysroot=${WASI_SDK_PATH}/share/wasi-sysroot -O2 --target=wasm32-unknown-wasi -c jmp.c -I . -o jmp.o
RUN ${WASI_SDK_PATH}/bin/clang --sysroot=${WASI_SDK_PATH}/share/wasi-sysroot -O2 --target=wasm32-unknown-wasi -Wl,--export=wasm_setjmp -c jmp.S -o jmp_wrapper.o
RUN ${WASI_SDK_PATH}/bin/wasm-ld jmp.o jmp_wrapper.o --export=wasm_setjmp --export=wasm_longjmp --export=handle_jmp --no-entry -r -o /jmp/jmp

WORKDIR /Bochs/bochs/wasi_extra/vfs
RUN mkdir /vfs
RUN ${WASI_SDK_PATH}/bin/clang --sysroot=${WASI_SDK_PATH}/share/wasi-sysroot -O2 --target=wasm32-unknown-wasi -c vfs.c -I . -o /vfs/vfs.o

WORKDIR /Bochs/bochs
ARG INIT_DEBUG
RUN LOGGING_FLAG=--disable-logging && \
    if test "${INIT_DEBUG}" = "true" ; then LOGGING_FLAG=--enable-logging ; fi && \
    CC="${WASI_SDK_PATH}/bin/clang" CXX="${WASI_SDK_PATH}/bin/clang++" RANLIB="${WASI_SDK_PATH}/bin/ranlib" \
    CFLAGS="--sysroot=${WASI_SDK_PATH}/share/wasi-sysroot -D_WASI_EMULATED_SIGNAL -DWASI -D__GNU__ -O2 -I/jmp/ -I/tools/wizer/include/" \
    CXXFLAGS="${CFLAGS}" \
    ./configure --host wasm32-unknown-wasi --enable-x86-64 --with-nogui --enable-usb --enable-usb-ehci \
    --disable-large-ramfile --disable-show-ips --disable-stats ${LOGGING_FLAG} \
    --enable-repeat-speedups --enable-fast-function-calls --disable-trace-linking --enable-handlers-chaining --enable-avx # TODO: --enable-trace-linking causes "out of bounds memory access"
RUN make -j$(nproc) bochs EMU_DEPS="/tools/wasi-vfs/libwasi_vfs.a /jmp/jmp /vfs/vfs.o -lrt"
RUN /binaryen/binaryen-version_${BINARYEN_VERSION}/bin/wasm-opt bochs --asyncify -O2 -o bochs.async --pass-arg=asyncify-ignore-imports
RUN mv bochs.async bochs

FROM bochs-dev-common AS bochs-dev-native
COPY --link --from=vm-amd64-dev /pack /minpack

FROM bochs-dev-common AS bochs-dev-wizer
COPY --link --from=vm-amd64-dev /pack /pack
ENV WASMTIME_BACKTRACE_DETAILS=1
RUN mv bochs bochs-org && /tools/wizer/wizer --allow-wasi --wasm-bulk-memory=true -r _start=wizer.resume --mapdir /pack::/pack -o bochs bochs-org
RUN mkdir /minpack && cp /pack/rootfs.bin /minpack/ && cp /pack/boot.iso /minpack/

FROM bochs-dev-${OPTIMIZATION_MODE} AS bochs-dev-packed
RUN /tools/wasi-vfs/wasi-vfs pack /Bochs/bochs/bochs --mapdir /pack::/minpack -o packed && mkdir /out
ARG OUTPUT_NAME
RUN mv packed /out/$OUTPUT_NAME

FROM scratch AS wasi-amd64
COPY --link --from=bochs-dev-packed /out/ /


FROM emscripten/emsdk:$EMSDK_VERSION AS bochs-emscripten
RUN apt-get install -y wget git
COPY --link --from=bochs-repo / /Bochs
WORKDIR /Bochs/bochs
COPY --link --from=vm-amd64-dev /pack /pack
ARG INIT_DEBUG
RUN LOGGING_FLAG=--disable-logging && \
    if test "${INIT_DEBUG}" = "true" ; then LOGGING_FLAG=--enable-logging ; fi && \
    CFLAGS="-O2 -s WASM=1 -s ASYNCIFY=1 -s ALLOW_MEMORY_GROWTH=1  -s TOTAL_MEMORY=$((30*1024*1024)) -sNO_EXIT_RUNTIME=1 -sFORCE_FILESYSTEM=1 -D__GNU__" \
    CXXFLAGS="${CFLAGS}" \
    emconfigure ./configure --host wasm32-unknown-emscripten --enable-x86-64 --with-nogui --enable-usb --enable-usb-ehci \
    --disable-large-ramfile --disable-show-ips --disable-stats ${LOGGING_FLAG} \
    --enable-repeat-speedups --enable-fast-function-calls --disable-trace-linking --enable-handlers-chaining --enable-avx # TODO: --enable-trace-linking causes "too much recursion"
RUN emmake make -j$(nproc) bochs EMU_DEPS="--preload-file /pack"
RUN mkdir -p /out/ && mv bochs /out/out.js && mv bochs.wasm /out/ && mv bochs.data /out/

FROM scratch AS js-bochs-amd64
COPY --link --from=bochs-emscripten /out/ /

FROM js-qemu-amd64 AS js-amd64

FROM js-$TARGETARCH AS js

FROM wasi-$TARGETARCH
