#!/bin/bash
# ============================================================================
#  AranOS — assemble the bootable ISO from the customized chroot
#  Produces a hybrid BIOS + UEFI ISO using grub-mkrescue.
# ============================================================================
set -euo pipefail
B="${B:-/home/user/aranos-build}"
CHROOT="$B/chroot"
IMAGE="$B/image"
SRC="${SRC:-/home/user/aranos}"
OUT="${OUT:-$B/AranOS-1.0-amd64.iso}"
log(){ echo -e "\n\033[1;35m[iso] $*\033[0m"; }

command -v grub-mkrescue >/dev/null 2>&1 || { sudo apt-get install -y grub2-common grub-pc-bin grub-efi-amd64-bin mtools xorriso; }

log "preparing image tree"
rm -rf "$IMAGE"
mkdir -p "$IMAGE/casper" "$IMAGE/boot/grub/fonts" "$IMAGE/.disk"

log "copying kernel + initrd out of the chroot"
Kver=$(ls -1 "$CHROOT"/boot/vmlinuz-* | sort -V | tail -1)
Iver=$(ls -1 "$CHROOT"/boot/initrd.img-* | sort -V | tail -1)
cp "$Kver" "$IMAGE/casper/vmlinuz"
cp "$Iver" "$IMAGE/casper/initrd"
echo "  kernel : $(basename "$Kver")"
echo "  initrd : $(basename "$Iver")"

log "squashing the root filesystem (this takes a while)"
rm -f "$IMAGE/casper/filesystem.squashfs"
mksquashfs "$CHROOT" "$IMAGE/casper/filesystem.squashfs" \
  -comp zstd -Xcompression-level 19 -b 1M -noappend \
  -wildcards \
  -e "boot/*" \
  -e "root/aranos-src" \
  -e "proc/*" -e "sys/*" -e "dev/pts/*" \
  -e "tmp/*" -e "var/tmp/*" \
  -e "var/cache/apt/archives/*.deb" \
  -e "swapfile"

log "writing casper metadata"
printf '%s' "$(du -sx --block-size=1 "$CHROOT" | cut -f1)" > "$IMAGE/casper/filesystem.size"
chroot "$CHROOT" dpkg-query -W --showformat='${Package} ${Version}\n' \
  > "$IMAGE/casper/filesystem.manifest" 2>/dev/null || true
cp "$IMAGE/casper/filesystem.manifest" "$IMAGE/casper/filesystem.manifest-desktop" 2>/dev/null || true
echo 'AranOS 1.0 "Aurora" - Release amd64' > "$IMAGE/.disk/info"
echo "https://aranos.example" > "$IMAGE/.disk/release_notes_url"
touch "$IMAGE/.disk/base_installable"
echo "full_cd/single" > "$IMAGE/.disk/cd_type"

log "installing GRUB menu + boot art"
cp "$SRC/branding/assets/grub-bg.png" "$IMAGE/boot/grub/aranos-grub-bg.png"
# unicode font for gfxterm (path varies by host)
for f in /usr/share/grub/unicode.pf2 /boot/grub/fonts/unicode.pf2; do
  [ -f "$f" ] && cp "$f" "$IMAGE/boot/grub/fonts/unicode.pf2" && break
done

cat > "$IMAGE/boot/grub/grub.cfg" <<'GRUBEOF'
set default=0
set timeout=10
set timeout_style=menu

insmod all_video
insmod gfxterm
insmod png
if loadfont /boot/grub/fonts/unicode.pf2 ; then
  set gfxmode=auto
  terminal_output gfxterm
fi
if background_image /boot/grub/aranos-grub-bg.png ; then true ; fi

set color_normal=white/black
set color_highlight=black/light-cyan

menuentry "Start AranOS  (Live)" {
    linux  /casper/vmlinuz boot=casper quiet splash ---
    initrd /casper/initrd
}
menuentry "Start AranOS  (safe graphics)" {
    linux  /casper/vmlinuz boot=casper nomodeset quiet splash ---
    initrd /casper/initrd
}
menuentry "Start AranOS  (verbose / troubleshooting)" {
    linux  /casper/vmlinuz boot=casper debug ---
    initrd /casper/initrd
}
menuentry "Check media for integrity" {
    linux  /casper/vmlinuz boot=casper integrity-check quiet splash ---
    initrd /casper/initrd
}
GRUBEOF

log "building the hybrid ISO with grub-mkrescue"
grub-mkrescue \
  --product-name="AranOS" \
  --product-version="1.0" \
  -o "$OUT" "$IMAGE" \
  -- -volid "ARANOS"

log "ISO BUILT"
ls -lh "$OUT"
echo "size: $(du -h "$OUT" | cut -f1)"
echo "md5 : $(md5sum "$OUT" | cut -d' ' -f1)"
