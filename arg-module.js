Module['arguments'] =
[
    "-incoming", "file:/pack/vm.state",
    "-cpu", "qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt,+cx16,+aes,+pclmulqdq", "-object", "rng-builtin,id=rng0", "-device", "virtio-rng-pci,rng=rng0", "-nographic", "-m", "1792M", "-accel", "tcg,tb-size=500,thread=multi", "-smp", "4,sockets=4",
    "-L", "/pack/",
    "-drive", "if=virtio,format=raw,file=/pack/rootfs.bin",
    "-drive", "if=virtio,format=qcow2,file=/kdisk/disk.qcow2,werror=report,rerror=report",
    "-kernel", "/pack/bzImage",
    "-append", "earlyprintk=ttyS0,115200n8 console=ttyS0,115200n8 slub_debug=F root=/dev/vda rootwait acpi=off ro virtio_net.napi_tx=false loglevel=0 QEMU_MODE=1 init=/sbin/tini -- /sbin/init",
    "-virtfs", "local,path=/,mount_tag=wasi0,security_model=none,id=wasi0",
    "-virtfs", "local,path=/pack,mount_tag=wasi1,security_model=passthrough,id=wasi1",
    "-netdev", "socket,id=vmnic,connect=127.0.0.1:8888", "-device", "virtio-net-pci,netdev=vmnic"
]
;
