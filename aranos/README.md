# AranOS

**Simple. Beautiful. Yours.**

AranOS is a custom Linux desktop distribution — an Ubuntu 24.04 LTS (“Noble”) base,
remastered from scratch into a branded, **bootable live ISO** with the
**Cinnamon** desktop, a full app suite, a custom boot splash, wallpaper, theme,
and a first-run welcome experience.

This repository is the **reproducible builder**. Running `build.sh` on a Linux
host produces `AranOS-1.0-amd64.iso`, a hybrid **BIOS + UEFI** bootable image you
can flash to a USB stick or boot in a virtual machine.

> The ISO itself is a multi-gigabyte binary artifact and is **not** committed to
> git — you build it from these sources with one command.

---

## What's inside

| Area            | Included |
|-----------------|----------|
| **Base**        | Ubuntu 24.04 LTS, Linux `generic` kernel, `linux-firmware` (broad hardware support) |
| **Desktop**     | Cinnamon (Mint-style, traditional menu + panel) with Arc-Dark + Papirus theming |
| **Live boot**   | `casper` live system, autologin as `aran`, runs fully from RAM/USB |
| **Browser**     | GNOME Web (Epiphany) — see *Browser note* below |
| **Office**      | LibreOffice Writer, Calc, Impress |
| **Creative**    | GIMP |
| **Media**       | VLC + GStreamer codecs (good/bad/ugly/libav) |
| **Utilities**   | Files (Nemo), Calculator, Screenshot, Archive Manager, Document Viewer, Image Viewer, Disks, GParted, System Monitor, Transmission, Terminal |
| **Audio**       | PipeWire + WirePlumber + `pavucontrol` |
| **Network**     | NetworkManager (Wi-Fi/Ethernet), `wpasupplicant` |
| **Branding**    | Custom Plymouth boot splash, GRUB menu, wallpaper, logo, `/etc/os-release`, first-run Welcome app |

## Build it

Requirements: a **Debian/Ubuntu host**, **root**, ~30 GB free disk, and network
access to `archive.ubuntu.com`.

```bash
sudo apt-get install -y debootstrap squashfs-tools xorriso \
    grub-pc-bin grub-efi-amd64-bin grub2-common mtools dosfstools

# regenerate brand art (optional — pre-rendered PNGs are committed):
python3 branding/gen_assets.py branding/assets

sudo ./build.sh            # full: debootstrap -> customize -> ISO
# or re-run individual phases:
sudo ./build.sh customize  # re-run in-chroot customization + reassemble ISO
sudo ./build.sh iso        # just reassemble the ISO from an existing chroot
```

Output: `/home/user/aranos-build/AranOS-1.0-amd64.iso` (override with `OUT=`).

### Phases

| File | Role |
|------|------|
| `build.sh` | Orchestrator: bind-mounts, runs the chroot script, assembles the ISO |
| `scripts/02-customize-chroot.sh` | The distro itself — installs desktop/apps, applies all AranOS branding (runs **inside** the chroot) |
| `scripts/03-assemble-iso.sh` | `mksquashfs` the rootfs + build the hybrid BIOS/UEFI ISO with `grub-mkrescue` |
| `branding/gen_assets.py` | Renders wallpaper, logos, GRUB & Plymouth art (pure Pillow, no network) |
| `config/` | Plymouth splash script + first-run `welcome.html` |

## Try it

**In a VM (recommended for a quick look):**
```bash
qemu-system-x86_64 -enable-kvm -m 4096 -smp 2 \
    -cdrom AranOS-1.0-amd64.iso -boot d -vga virtio
```

**On real hardware:** flash to a USB stick (this **erases** the stick):
```bash
sudo dd if=AranOS-1.0-amd64.iso of=/dev/sdX bs=4M status=progress oflag=sync
```
…then boot from USB. The live session logs in automatically and a Welcome
window introduces the desktop.

## Honest notes / known limits

- **“Everything works”** is the goal, not a guarantee any OS can make. AranOS
  bundles `linux-firmware` for broad hardware support and codecs for media, but
  exotic/very new hardware may still need extra drivers. It boots and runs the
  full desktop + apps in QEMU (BIOS and UEFI) — that's what's verified here.
- **Browser = GNOME Web (Epiphany).** Ubuntu ships Firefox/Chromium only as
  *snaps*, which don't work cleanly inside a `casper` live image (no `snapd`
  seeding), and the Mozilla/Chromium `.deb` repos were unreachable from the build
  network. GNOME Web is a real `.deb`, GTK-native, and fits Cinnamon. Swapping in
  Firefox is a one-line change once a `.deb` source is reachable.
- **Live session only.** This image boots a live desktop; changes reset on
  reboot. A graphical installer (e.g. Calamares) is a natural next addition.
- **Size.** A full desktop + LibreOffice + GIMP + VLC + firmware compresses to a
  few GB. The exact ISO size is printed at the end of the build.

## License

Built from Ubuntu/Debian packages under their respective licenses. AranOS
branding assets (logo, wallpaper) in `branding/` are original to this project.
