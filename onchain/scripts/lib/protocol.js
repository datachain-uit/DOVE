const hre = require("hardhat");

const TRANSCRIPT_TAG = hre.ethers.keccak256(hre.ethers.toUtf8Bytes("TRANSCRIPT_V1"));

function toHex32(x) {
  return hre.ethers.toBeHex(BigInt(x), 32);
}

function toAddressFromUint(x) {
  return hre.ethers.getAddress(hre.ethers.toBeHex(BigInt(x), 20));
}

function proofStructFromJson(proof) {
  return {
    a: [proof.pi_a[0], proof.pi_a[1]],
    b: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    c: [proof.pi_c[0], proof.pi_c[1]],
  };
}

function buildProofHash(ps) {
  return hre.ethers.keccak256(
    hre.ethers.solidityPacked(
      ["uint256[2]", "uint256[2][2]", "uint256[2]"],
      [ps.a, ps.b, ps.c]
    )
  );
}

function buildTranscriptHash(ctx, ps) {
  return hre.ethers.keccak256(
    hre.ethers.solidityPacked(
      ["bytes32", "bytes32", "address", "address", "uint256", "uint256", "bytes32"],
      [TRANSCRIPT_TAG, ctx.C, ctx.sid, ctx.aud, ctx.nonce, ctx.exp, buildProofHash(ps)]
    )
  );
}

async function signPoP(holder, ctx, ps) {
  const th = buildTranscriptHash(ctx, ps);
  return holder.signMessage(hre.ethers.getBytes(th));
}

module.exports = {
  TRANSCRIPT_TAG,
  toHex32,
  toAddressFromUint,
  proofStructFromJson,
  buildProofHash,
  buildTranscriptHash,
  signPoP,
};
