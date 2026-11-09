// Metadata prices are USD per 1M tokens. Providers that only publish CNY
// (Volcengine Doubao, Baidu Qianfan) are converted at one fixed rate, so the
// rows stay comparable with each other. 7.3 is close to Alibaba's own
// Singapore conversion; revisit if the market rate drifts far from it.
export const CNY_PER_USD = 7.3;

/**
 * CNY per 1M tokens → USD per 1M tokens, rounded to 4 significant digits so
 * the Model Selector shows `0.8219`, not `0.8219178082191781`.
 */
export function cny(yuan: number): number {
  return Number((yuan / CNY_PER_USD).toPrecision(4));
}
