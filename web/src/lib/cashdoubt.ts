/**
 * Part-paid bills and the cash drawer.
 *
 * A bill settled part cash, part online reaches us as one "split" figure
 * with no breakdown, so those rupees are missing from expected cash. The
 * drawer will legitimately count high by up to that amount.
 *
 * The rule is deliberately asymmetric. A surplus inside the band is
 * arithmetic and should not be dressed up as a discrepancy — do that and
 * the owner learns to dismiss every alert. A shortage is never explained
 * by this: money that should be in the till and isn't stays a shortage,
 * whatever the payment modes were.
 */
export function explainedBySplit(variancePaise: number,
                                 splitUnknownPaise: number): boolean {
  return variancePaise > 0 && variancePaise <= splitUnknownPaise;
}
