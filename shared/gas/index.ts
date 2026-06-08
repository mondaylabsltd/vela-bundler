/**
 * Gas calculation and profitability module.
 */

export { calcPreVerificationGas, type PreVerificationGasContext } from "./preVerificationGas.ts";
export {
  isL2WithDataFee,
  isArbitrumChain,
  isOpStackChain,
  estimateArbitrumL1Gas,
  estimateOpStackL1Gas,
} from "./l2-data-fee.ts";
export {
  calcUserOpGasPrice,
  calcExpectedRevenue,
  calcExpectedCost,
  checkBundleProfitability,
  checkUserOpProfitability,
  type ProfitabilityResult,
} from "./profitability.ts";
