// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./DiplomaRegistry.sol";

interface IGroth16VerifierV2 {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[2] calldata pubSignals
    ) external view returns (bool);
}

contract ZKOnlyVerifier {
    error InvalidVerifierAddress();
    error InvalidRegistryAddress();
    error InactiveOrRevoked();
    error BadZkProof();

    address public immutable groth16;
    DiplomaRegistry public immutable registry;

    event VerifiedZKOnly(bytes32 indexed C, address indexed sid, address indexed aud, uint256 nonce, uint256 exp);

    constructor(address groth16Verifier, address registryAddr) {
        if (groth16Verifier.code.length == 0) revert InvalidVerifierAddress();
        if (registryAddr.code.length == 0) revert InvalidRegistryAddress();
        groth16 = groth16Verifier;
        registry = DiplomaRegistry(registryAddr);
    }

    struct VerifyContext {
        bytes32 C;
        address sid;
        address aud;
        uint256 nonce;
        uint256 exp;
    }

    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
    }

    function _publicSignals(VerifyContext calldata ctx) internal pure returns (uint256[2] memory pub) {
        pub[0] = uint256(ctx.C);
        pub[1] = uint256(uint160(ctx.sid));
    }

    function _verifyZkProof(Proof calldata proof, uint256[2] memory pub2) internal view returns (bool) {
        try IGroth16VerifierV2(groth16).verifyProof(proof.a, proof.b, proof.c, pub2) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    function verifyZKOnly(
        VerifyContext calldata ctx,
        Proof calldata proof
    ) external returns (bool) {
        if (!registry.active(ctx.C)) revert InactiveOrRevoked();

        uint256[2] memory pub = _publicSignals(ctx);
        if (!_verifyZkProof(proof, pub)) revert BadZkProof();

        emit VerifiedZKOnly(ctx.C, ctx.sid, ctx.aud, ctx.nonce, ctx.exp);
        return true;
    }
}
