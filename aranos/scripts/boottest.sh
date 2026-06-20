#!/bin/bash
# ============================================================================
#  AranOS — headless boot test in QEMU
#  Boots the ISO, logs the serial console, and screenshots the framebuffer
#  on an interval so you can watch GRUB -> kernel -> Cinnamon desktop.
#
#    ./boottest.sh <iso> [bios|uefi] [minutes]
# ============================================================================
set -u
ISO="${1:?usage: boottest.sh <iso> [bios|uefi] [minutes]}"
MODE="${2:-bios}"
MINUTES="${3:-12}"
OUTDIR="${OUTDIR:-/home/user/aranos-build/shots-$MODE}"
MON=/tmp/aranos-mon-$MODE.sock
SERIAL=/tmp/aranos-serial-$MODE.log
PIDF=/tmp/aranos-qemu-$MODE.pid
mkdir -p "$OUTDIR"; rm -f "$OUTDIR"/*.ppm "$OUTDIR"/*.png "$SERIAL"

FW=()
if [ "$MODE" = "uefi" ]; then
  cp /usr/share/OVMF/OVMF_VARS_4M.fd /tmp/aranos-vars-$MODE.fd
  FW=(-drive if=pflash,format=raw,unit=0,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd
      -drive if=pflash,format=raw,unit=1,file=/tmp/aranos-vars-$MODE.fd)
fi

echo "[boottest] starting QEMU ($MODE, TCG, ${MINUTES}m budget)"
qemu-system-x86_64 \
  "${FW[@]}" \
  -m 4096 -smp 2 \
  -cdrom "$ISO" -boot d \
  -vga std \
  -display none \
  -serial file:"$SERIAL" \
  -monitor unix:"$MON",server,nowait \
  -no-reboot &
QPID=$!; echo $QPID > "$PIDF"
echo "[boottest] qemu pid $QPID  monitor $MON  serial $SERIAL"

snap(){  # send an HMP command to the monitor socket
  local cmd="$1"
  python3 - "$MON" "$cmd" <<'PY'
import socket,sys,time
sock,cmd=sys.argv[1],sys.argv[2]
try:
    s=socket.socket(socket.AF_UNIX); s.connect(sock); time.sleep(0.2)
    s.recv(4096)
    s.sendall((cmd+"\n").encode()); time.sleep(0.4)
    try: print(s.recv(4096).decode(errors="ignore"))
    except: pass
    s.close()
except Exception as e:
    print("monitor err:",e)
PY
}

END=$(( $(date +%s) + MINUTES*60 ))
i=0
while [ "$(date +%s)" -lt "$END" ]; do
  sleep 30
  kill -0 "$QPID" 2>/dev/null || { echo "[boottest] qemu exited early"; break; }
  i=$((i+1)); n=$(printf '%02d' $i)
  ppm="$OUTDIR/shot-$n.ppm"
  snap "screendump $ppm" >/dev/null
  if [ -f "$ppm" ]; then
    python3.12 - "$ppm" "$OUTDIR/shot-$n.png" <<'PY' 2>/dev/null
import sys
from PIL import Image
Image.open(sys.argv[1]).save(sys.argv[2])
PY
    rm -f "$ppm"
    echo "[boottest] t=${i}x30s  -> shot-$n.png   serial: $(wc -l < "$SERIAL") lines"
  fi
done

echo "[boottest] stopping qemu"
snap "quit" >/dev/null 2>&1
sleep 1; kill "$QPID" 2>/dev/null || true
echo "[boottest] done. shots in $OUTDIR ; serial in $SERIAL"
tail -25 "$SERIAL" 2>/dev/null
