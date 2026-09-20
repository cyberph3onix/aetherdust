/** DUST arithmetic. 1 DUST = 10^15 SPECK (docs.midnight.network/tokens). All amounts are bigint SPECK internally. */
export const SPECKS_PER_DUST = 1_000_000_000_000_000n;

export const specksToDust = (specks: bigint): string => {
  const neg = specks < 0n;
  const abs = neg ? -specks : specks;
  const whole = abs / SPECKS_PER_DUST;
  const frac = (abs % SPECKS_PER_DUST).toString().padStart(15, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
};

/** Parses a decimal DUST string ("0.1", "100", "1.5e-3" not allowed) into SPECK. Throws on invalid input. */
export const dustToSpecks = (dust: string | number): bigint => {
  const s = String(dust).trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,15}))?$/.exec(s);
  if (!m) throw new RangeError(`invalid DUST amount: ${JSON.stringify(dust)}`);
  const [, neg, whole, frac = ''] = m;
  const v = BigInt(whole) * SPECKS_PER_DUST + BigInt(frac.padEnd(15, '0'));
  return neg ? -v : v;
};

/** Multiply a SPECK amount by a decimal factor (e.g. 1.05) with exact integer math, rounding up. */
export const mulCeil = (specks: bigint, factor: number): bigint => {
  const scaled = BigInt(Math.round(factor * 1_000_000));
  const num = specks * scaled;
  const den = 1_000_000n;
  return num % den === 0n ? num / den : num / den + 1n;
};
