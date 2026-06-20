#!/bin/bash
# ============================================================================
#  AranOS — in-chroot customization
#  Runs INSIDE the chroot (invoked by build.sh). Installs the desktop,
#  applications and AranOS branding. Expects brand sources at /root/aranos-src.
# ============================================================================
set -u
export DEBIAN_FRONTEND=noninteractive
export LANG=C LC_ALL=C
SRC=/root/aranos-src
log(){ echo -e "\n\033[1;36m[aranos] $*\033[0m"; }

# ---------------------------------------------------------------------------
# 0. APT sources (full Ubuntu noble) + don't let services start in chroot
# ---------------------------------------------------------------------------
cat > /etc/apt/sources.list <<'EOF'
deb http://archive.ubuntu.com/ubuntu noble main restricted universe multiverse
deb http://archive.ubuntu.com/ubuntu noble-updates main restricted universe multiverse
deb http://archive.ubuntu.com/ubuntu noble-backports main restricted universe multiverse
deb http://archive.ubuntu.com/ubuntu noble-security main restricted universe multiverse
EOF

printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
chmod +x /usr/sbin/policy-rc.d
# divert initramfs/grub updates to be fast & quiet during install
dpkg-divert --local --rename --add /sbin/initctl >/dev/null 2>&1 || true
ln -sf /bin/true /sbin/initctl 2>/dev/null || true

log "apt-get update"
apt-get update -y || { echo "FATAL: apt update failed"; exit 1; }

# base utilities first (need apt-utils/locales/sudo early)
apt-get install -y --no-install-recommends \
  apt-utils locales sudo ca-certificates tzdata keyboard-configuration console-setup \
  || { echo "FATAL: base utils failed"; exit 1; }

# locale + timezone
sed -i 's/^# *\(en_US.UTF-8\)/\1/' /etc/locale.gen
locale-gen en_US.UTF-8
update-locale LANG=en_US.UTF-8
ln -sf /usr/share/zoneinfo/Etc/UTC /etc/localtime
echo "Etc/UTC" > /etc/timezone

# ---------------------------------------------------------------------------
# 1. CRITICAL packages: kernel + live-boot + X + display manager + desktop
# ---------------------------------------------------------------------------
log "installing kernel + casper live-boot + firmware"
apt-get install -y \
  linux-generic linux-firmware \
  casper discover laptop-detect os-prober \
  initramfs-tools \
  || { echo "FATAL: kernel/casper failed"; exit 1; }

log "installing networking"
apt-get install -y \
  network-manager network-manager-gnome wpasupplicant \
  net-tools iproute2 isc-dhcp-client \
  || { echo "FATAL: networking failed"; exit 1; }

log "installing X + LightDM + Cinnamon desktop (this is the big one)"
apt-get install -y \
  xorg xserver-xorg xinit \
  lightdm slick-greeter \
  cinnamon-desktop-environment nemo gnome-terminal \
  || {
    echo "cinnamon-desktop-environment failed — falling back to core cinnamon";
    apt-get install -y xorg lightdm slick-greeter cinnamon nemo gnome-terminal \
      || { echo "FATAL: desktop failed"; exit 1; }
  }

# force LightDM as the default display manager
echo "/usr/sbin/lightdm" > /etc/X11/default-display-manager
echo "set shared/default-x-display-manager lightdm" | debconf-communicate >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 2. BEST-EFFORT packages: apps, media codecs, look & feel, utilities
#    (failures here are logged but do not abort the build)
# ---------------------------------------------------------------------------
best_effort(){
  log "installing (best-effort): $*"
  apt-get install -y $* || echo "WARN: some of [$*] failed to install"
}
best_effort epiphany-browser
best_effort libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-gtk3
best_effort gimp
best_effort vlc
best_effort gnome-calculator gnome-screenshot file-roller evince eog \
            gnome-system-monitor gparted gnome-disk-utility baobab transmission-gtk gedit
best_effort gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-plugins-ugly \
            gstreamer1.0-libav
best_effort pipewire pipewire-pulse wireplumber pavucontrol
best_effort plymouth plymouth-themes plymouth-label
best_effort arc-theme papirus-icon-theme fonts-noto-core fonts-liberation2 fonts-dejavu \
            fonts-noto-color-emoji
best_effort zenity yad xdg-utils policykit-1 udisks2 ubuntu-drivers-common \
            software-properties-gtk synaptic less nano vim-tiny curl wget htop

# ---------------------------------------------------------------------------
# 2.5 MAKE CINNAMON THE ONE TRUE DESKTOP
#     The cinnamon-desktop-environment metapackage drags in gdm3 + gnome-shell
#     + ubuntu-session, and gdm3 wins the systemd display-manager activation
#     (autologin then lands in GNOME). Plain `cinnamon` does NOT need gnome-shell,
#     so pin the Cinnamon stack, purge the GNOME shell/DM, and force LightDM.
# ---------------------------------------------------------------------------
log "pinning Cinnamon + removing GNOME shell/gdm so autologin lands in Cinnamon"
apt-mark manual \
  cinnamon cinnamon-common cinnamon-session cinnamon-control-center \
  cinnamon-screensaver cinnamon-settings-daemon cinnamon-desktop-data cjs \
  nemo lightdm slick-greeter xorg xserver-xorg 2>/dev/null || true

apt-get purge -y \
  'gdm3' 'gnome-shell' 'gnome-shell-common' 'gnome-shell-extension-*' \
  'ubuntu-session' 'gnome-session' 'gnome-session-bin' 'gnome-session-common' \
  'gnome-initial-setup' 2>/dev/null || true
apt-get autoremove --purge -y || true

# LightDM is the one and only display manager
ln -sf /lib/systemd/system/lightdm.service /etc/systemd/system/display-manager.service
echo "/usr/sbin/lightdm" > /etc/X11/default-display-manager
echo "set shared/default-x-display-manager lightdm" | debconf-communicate >/dev/null 2>&1 || true

# drop any non-Cinnamon X sessions so even a "default session" pick is Cinnamon
rm -f /usr/share/xsessions/ubuntu*.desktop /usr/share/xsessions/gnome*.desktop 2>/dev/null || true
# pre-seed the live user's default session = Cinnamon (casper reads AccountsService)
mkdir -p /var/lib/AccountsService/users
cat > /var/lib/AccountsService/users/aran <<'EOF'
[User]
Session=cinnamon
XSession=cinnamon
SystemAccount=false
EOF

echo "  remaining X sessions: $(ls /usr/share/xsessions/ 2>/dev/null | tr '\n' ' ')"
echo "  active DM -> $(readlink /etc/systemd/system/display-manager.service)"

# ---------------------------------------------------------------------------
# 3. AranOS IDENTITY (os-release / lsb-release / issue / hostname)
# ---------------------------------------------------------------------------
log "applying AranOS identity"
echo "aranos" > /etc/hostname
cat > /etc/hosts <<'EOF'
127.0.0.1   localhost
127.0.1.1   aranos
::1         localhost ip6-localhost ip6-loopback
ff02::1     ip6-allnodes
ff02::2     ip6-allrouters
EOF

cat > /etc/os-release <<'EOF'
PRETTY_NAME="AranOS 1.0 (Aurora)"
NAME="AranOS"
VERSION_ID="1.0"
VERSION="1.0 (Aurora)"
VERSION_CODENAME=aurora
ID=aranos
ID_LIKE="ubuntu debian"
HOME_URL="https://aranos.example"
SUPPORT_URL="https://aranos.example/support"
BUG_REPORT_URL="https://aranos.example/bugs"
LOGO=aranos-logo
EOF
ln -sf /etc/os-release /usr/lib/os-release

cat > /etc/lsb-release <<'EOF'
DISTRIB_ID=AranOS
DISTRIB_RELEASE=1.0
DISTRIB_CODENAME=aurora
DISTRIB_DESCRIPTION="AranOS 1.0 (Aurora)"
EOF

cat > /etc/issue <<'EOF'
  ___                    ___  ____
 / _ \    Welcome to    / _ \/ ___|
| |_| |  ___ _ __  __ _| | | \___ \
|  _  | / _ \ '__|/ _` | |_| |___) |
|_| |_|/_/ \_\_|  \__,_|\___/|____/   1.0 "Aurora"  \n \l

EOF
echo "Welcome to AranOS 1.0 \"Aurora\" — Simple. Beautiful. Yours." > /etc/motd

# ---------------------------------------------------------------------------
# 4. Live user config (casper) + autologin into Cinnamon
# ---------------------------------------------------------------------------
log "configuring live user + autologin"
cat > /etc/casper.conf <<'EOF'
export USERNAME="aran"
export USERFULLNAME="AranOS Live User"
export HOST="aranos"
export BUILD_SYSTEM="Ubuntu"
export FLAVOUR="AranOS"
EOF

mkdir -p /etc/lightdm/lightdm.conf.d
cat > /etc/lightdm/lightdm.conf.d/50-aranos.conf <<'EOF'
[Seat:*]
greeter-session=slick-greeter
user-session=cinnamon
autologin-user=aran
autologin-user-timeout=0
EOF

# slick-greeter look
cat > /etc/lightdm/slick-greeter.conf <<'EOF'
[Greeter]
background=/usr/share/backgrounds/aranos/wallpaper.png
theme-name=Arc-Dark
icon-theme-name=Papirus-Dark
draw-user-backgrounds=false
show-hostname=true
EOF

# ---------------------------------------------------------------------------
# 5. Wallpaper + system-wide desktop defaults (dconf)
# ---------------------------------------------------------------------------
log "installing wallpaper + dconf defaults"
mkdir -p /usr/share/backgrounds/aranos
cp "$SRC/branding/assets/wallpaper.png" /usr/share/backgrounds/aranos/wallpaper.png
# app/distributor logo for About dialogs
mkdir -p /usr/share/pixmaps /usr/share/icons/hicolor/256x256/apps
cp "$SRC/branding/assets/logo-256.png" /usr/share/pixmaps/aranos-logo.png
cp "$SRC/branding/assets/logo-256.png" /usr/share/icons/hicolor/256x256/apps/aranos-logo.png

mkdir -p /etc/dconf/profile /etc/dconf/db/local.d
echo -e "user-db:user\nsystem-db:local" > /etc/dconf/profile/user
cat > /etc/dconf/db/local.d/00-aranos <<'EOF'
[org/cinnamon/desktop/background]
picture-uri='file:///usr/share/backgrounds/aranos/wallpaper.png'
picture-options='zoom'
primary-color='#0a0e21'

[org/gnome/desktop/background]
picture-uri='file:///usr/share/backgrounds/aranos/wallpaper.png'
picture-options='zoom'

[org/cinnamon/desktop/interface]
gtk-theme='Arc-Dark'
icon-theme='Papirus-Dark'
cursor-theme='DMZ-White'

[org/cinnamon/theme]
name='Arc-Dark'

[org/cinnamon/desktop/wm/preferences]
theme='Arc-Dark'

[org/cinnamon]
favorite-apps=['epiphany.desktop', 'org.gnome.Terminal.desktop', 'nemo.desktop', 'libreoffice-writer.desktop', 'org.gnome.Calculator.desktop', 'cinnamon-settings.desktop']

[org/gnome/desktop/interface]
gtk-theme='Arc-Dark'
icon-theme='Papirus-Dark'

[org/cinnamon/desktop/session]
idle-delay=uint32 0

[org/cinnamon/settings-daemon/plugins/power]
sleep-display-ac=0
sleep-display-battery=0
idle-dim=false

[org/cinnamon/desktop/screensaver]
lock-enabled=false
idle-activation-enabled=false
EOF
dconf update 2>/dev/null || echo "WARN: dconf update failed (will still apply on boot)"

# ---------------------------------------------------------------------------
# 6. Plymouth boot splash
# ---------------------------------------------------------------------------
if [ -d /usr/share/plymouth/themes ]; then
  log "installing AranOS plymouth theme"
  mkdir -p /usr/share/plymouth/themes/aranos
  cp "$SRC/config/plymouth/aranos.script" /usr/share/plymouth/themes/aranos/aranos.script
  cp "$SRC/branding/assets/plymouth-bg.png"   /usr/share/plymouth/themes/aranos/plymouth-bg.png
  cp "$SRC/branding/assets/plymouth-logo.png" /usr/share/plymouth/themes/aranos/plymouth-logo.png
  cat > /usr/share/plymouth/themes/aranos/aranos.plymouth <<'EOF'
[Plymouth Theme]
Name=AranOS
Description=AranOS boot splash
ModuleName=script

[script]
ImageDir=/usr/share/plymouth/themes/aranos
ScriptFile=/usr/share/plymouth/themes/aranos/aranos.script
EOF
  plymouth-set-default-theme aranos 2>/dev/null || \
    update-alternatives --install /usr/share/plymouth/themes/default.plymouth \
      default.plymouth /usr/share/plymouth/themes/aranos/aranos.plymouth 200 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# 7. First-run Welcome app (shows once per live session)
# ---------------------------------------------------------------------------
log "installing AranOS Welcome"
mkdir -p /usr/share/aranos
cp "$SRC/config/welcome.html" /usr/share/aranos/welcome.html

cat > /usr/bin/aranos-welcome <<'EOF'
#!/bin/sh
# Open the AranOS welcome page in the default browser
URL="file:///usr/share/aranos/welcome.html"
if command -v epiphany >/dev/null 2>&1; then exec epiphany "$URL"; fi
if command -v xdg-open  >/dev/null 2>&1; then exec xdg-open  "$URL"; fi
exec sensible-browser "$URL"
EOF
chmod +x /usr/bin/aranos-welcome

cat > /usr/share/applications/aranos-welcome.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Welcome to AranOS
Comment=A friendly introduction to your new desktop
Exec=aranos-welcome
Icon=aranos-logo
Terminal=false
Categories=GTK;System;
EOF

# autostart once: a wrapper that self-disables after first run
mkdir -p /etc/skel/.config/autostart
cat > /usr/bin/aranos-welcome-once <<'EOF'
#!/bin/sh
FLAG="$HOME/.config/aranos-welcome-shown"
[ -f "$FLAG" ] && exit 0
mkdir -p "$HOME/.config"; touch "$FLAG"
sleep 4
aranos-welcome
EOF
chmod +x /usr/bin/aranos-welcome-once
cat > /etc/skel/.config/autostart/aranos-welcome.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=AranOS Welcome
Exec=aranos-welcome-once
Terminal=false
X-GNOME-Autostart-enabled=true
EOF

# make GNOME Web the default browser
if [ -f /usr/share/applications/epiphany.desktop ]; then
  cat > /etc/skel/.config/mimeapps.list <<'EOF'
[Default Applications]
text/html=epiphany.desktop
x-scheme-handler/http=epiphany.desktop
x-scheme-handler/https=epiphany.desktop
EOF
  update-alternatives --install /usr/bin/x-www-browser x-www-browser /usr/bin/epiphany 200 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# 8. Regenerate initramfs (include casper + plymouth), then clean up
# ---------------------------------------------------------------------------
log "regenerating initramfs"
update-initramfs -u || update-initramfs -c -k all || echo "WARN: initramfs update issue"

log "cleaning chroot"
apt-get autoremove -y || true
apt-get clean
rm -rf /tmp/* /var/tmp/* /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
rm -f /usr/sbin/policy-rc.d
rm -f /sbin/initctl 2>/dev/null || true
dpkg-divert --rename --remove /sbin/initctl >/dev/null 2>&1 || true
# truncate machine-id so each boot gets a fresh one
: > /etc/machine-id
rm -f /var/lib/dbus/machine-id 2>/dev/null || true
ln -sf /etc/machine-id /var/lib/dbus/machine-id
# remove the host resolv.conf used for the build
rm -f /etc/resolv.conf
truncate -s 0 /etc/hostname && echo "aranos" > /etc/hostname
history -c 2>/dev/null || true

log "in-chroot customization COMPLETE"
