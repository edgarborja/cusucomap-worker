// CRC-16/XMODEM (poly 0x1021, init 0x0000, no reflection, no xorout) - used
// only to turn an npub into a short, stable, anonymous-but-consistent
// attribution tag for shared scan results (see worker-app.js's
// checkScanSubscription/approveScanResults). Not a security or
// integrity checksum - just a deterministic, compact code with no
// meaningful collision-resistance requirement at the scale this is used
// at (a handful of scan subscribers, not an adversarial dataset).
export function crc16(text) {
  let crc = 0x0000;
  for (let i = 0; i < text.length; i++) {
    crc ^= text.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

/** 4-character uppercase hex tag, e.g. "A3F2". */
export function crc16Tag(text) {
  return crc16(text).toString(16).toUpperCase().padStart(4, "0");
}
