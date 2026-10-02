const { buildModule } = require("@nomicfoundation/hardhat-ignition/modules");

module.exports = buildModule("L1DeployModule", (m) => {
  const owner = m.getAccount(0);

  const groth16 = m.contract("Groth16Verifier");
  const registry = m.contract("DiplomaRegistry", [owner]);
  const enforcer = m.contract("DoveVerifier", [groth16, registry]);
  const noPoP = m.contract("NoPoPVerifier", [groth16, registry]);
  const zkOnly = m.contract("ZKOnlyVerifier", [groth16, registry]);

  return { groth16, registry, enforcer, noPoP, zkOnly };
});
