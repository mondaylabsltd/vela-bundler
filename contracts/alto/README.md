# Vendored Alto simulation artifacts

These are the creation artifacts used by `deploy-simulations` to deploy the
ERC-4337 `eth_call` fallback through the canonical CREATE2 deployer.

They were built from Alto commit `9e8dce99` and are intentionally committed so
the deployment binary is self-contained:

- `PimlicoSimulations.json`: SHA-256 `fa9fc5d31ff085ea641bb483b4ca3d3e81ede0c3e4a95e4aad3f995f22cc47a0`
- `EntryPointSimulations07.json`: SHA-256 `f2c084b2da8d6e294b2bcfc93b338c660bda1060bf2a66e943aa3302f6bf5577`

Source contracts:

- `PimlicoSimulations.sol`
- `v07/EntryPointSimulations.sol`
