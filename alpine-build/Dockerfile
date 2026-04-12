FROM docker.io/i386/alpine:3.18.6

ENV KERNEL=virt

# Core system + Python 3 + sqlite3 + useful tools
RUN apk add \
    openrc alpine-base agetty alpine-conf \
    linux-$KERNEL linux-firmware-none \
    python3 py3-pip \
    curl wget \
    bash coreutils \
    sqlite

# Auto-login root on serial console
RUN sed -i 's/getty 38400 tty1/agetty --autologin root tty1 linux/' /etc/inittab
RUN echo 'ttyS0::respawn:/sbin/agetty --autologin root -s ttyS0 115200 vt100' >> /etc/inittab
RUN echo "root:" | chpasswd

RUN setup-hostname karkhana

# Networking script (run after boot to get internet via v86 relay)
RUN printf '#!/bin/sh\nhwclock -s\nip link set eth0 up 2>/dev/null\nudhcpc -i eth0 -q\n' > /root/networking.sh && chmod +x /root/networking.sh

# Welcome message
RUN echo -e '\n\033[38;5;208mKarkhana / कारख़ाना\033[0m\nType "agent" to start the coding agent.\nType "/root/networking.sh" to enable internet.\n' > /etc/motd

# OpenRC services
RUN for i in devfs dmesg mdev hwdrivers; do rc-update add $i sysinit; done
RUN for i in hwclock modules sysctl hostname syslog bootmisc; do rc-update add $i boot; done
RUN rc-update add killprocs shutdown

# Create 9p feature for mkinitfs (not included by default)
RUN printf 'kernel/net/9p\nkernel/fs/9p\n' > /etc/mkinitfs/features.d/9p.modules
# Add virtio_pci to the virtio feature
RUN printf 'kernel/drivers/virtio\nkernel/drivers/block/virtio*\nkernel/drivers/net/virtio_net*\nkernel/drivers/char/virtio_console*\nkernel/fs/fuse/virtiofs*\n' > /etc/mkinitfs/features.d/virtio.modules

# Generate initramfs with 9p + virtio modules
RUN mkinitfs -F "base virtio 9p" $(cat /usr/share/kernel/$KERNEL/kernel.release)
