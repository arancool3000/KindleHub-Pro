#!/bin/bash
# ============================================================================
#  AranOS — top-level build orchestrator   (run as root)
#
#    sudo ./build.sh            # full build: bootstrap -> customize -> ISO
#    sudo ./build.sh customize  # (re)run in-chroot customization + ISO
#    sudo ./build.sh iso        # just (re)assemble the ISO from the chroot
#
#  Output: $B/AranOS-1.0-amd64.iso
# ============================================================================
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
export SRC
export B="${B:-/home/user/aranos-build}"
CHROOT="$B/chroot"
MIRROR="http://archive.ubuntu.com/ubuntu/"
PHASE="${1:-full}"
log(){ echo -e "\n\033[1;32m========== [AranOS build] $* ==========\033[0m"; }

[ "$(id -u)" = "0" ] || { echo "Run as root (sudo)."; exit 1; }

mount_chroot(){
  mount --bind /dev      "$CHROOT/dev"
  mount --bind /dev/pts  "$CHROOT/dev/pts"
  mount -t proc  proc    "$CHROOT/proc"
  mount -t sysfs sysfs   "$CHROOT/sys"
  mount -t tmpfs tmpfs   "$CHROOT/tmp" 2>/dev/null || true
  cp /etc/resolv.conf "$CHROOT/etc/resolv.conf"
}
umount_chroot(){
  for m in tmp sys proc dev/pts dev ; do
    mountpoint -q "$CHROOT/$m" && umount -lf "$CHROOT/$m" || true
  done
}
trap umount_chroot EXIT

do_bootstrap(){
  if [ -x "$CHROOT/bin/bash" ]; then
    log "chroot already bootstrapped — skipping debootstrap"
    return
  fi
  log "debootstrap Ubuntu 24.04 base"
  mkdir -p "$CHROOT"
  debootstrap --arch=amd64 --variant=minbase \
    --components=main,universe,multiverse,restricted \
    noble "$CHROOT" "$MIRROR"
}

do_customize(){
  log "copy AranOS sources into chroot"
  rm -rf "$CHROOT/root/aranos-src"
  mkdir -p "$CHROOT/root/aranos-src"
  cp -a "$SRC/branding" "$SRC/config" "$SRC/scripts" "$CHROOT/root/aranos-src/"

  mount_chroot
  log "run in-chroot customization"
  chroot "$CHROOT" /bin/bash /root/aranos-src/scripts/02-customize-chroot.sh
  umount_chroot
  # don't ship the build sources inside the image
  rm -rf "$CHROOT/root/aranos-src"
}

do_iso(){
  log "assemble ISO"
  bash "$SRC/scripts/03-assemble-iso.sh"
}

case "$PHASE" in
  full)       do_bootstrap; do_customize; do_iso ;;
  customize)  do_customize; do_iso ;;
  iso)        do_iso ;;
  bootstrap)  do_bootstrap ;;
  *) echo "unknown phase: $PHASE (use: full|customize|iso|bootstrap)"; exit 1 ;;
esac

log "DONE"
