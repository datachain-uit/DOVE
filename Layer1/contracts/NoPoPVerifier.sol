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

contract NoPoPVerifier {
    error InvalidVerifierAddress();
    error InvalidRegistryAddress();
    error AudMismatch();
    error Expired();
    error InactiveOrRevoked();
    error RequestUsed();
    error BadZkProof();

    address public immutable groth16;
    DiplomaRegistry public immutable registry;
    mapping(bytes32 => bool) public usedRequest;

    event VerifiedNoPoP(bytes32 indexed C, address indexed sid, address indexed aud, uint256 nonce, uint256 exp);

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

    function _computeRequestKey(VerifyContext calldata ctx) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(ctx.sid, ctx.aud, ctx.nonce));
    }

    function _verifyZkProof(Proof calldata proof, uint256[2] memory pub2) internal view returns (bool) {
        try IGroth16VerifierV2(groth16).verifyProof(proof.a, proof.b, proof.c, pub2) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    function verifyAndConsumeNoPoP(
        VerifyContext calldata ctx,
        Proof calldata proof
    ) external returns (bool) {
        if (msg.sender != ctx.aud) revert AudMismatch();
        if (block.timestamp > ctx.exp) revert Expired();
        if (!registry.active(ctx.C)) revert InactiveOrRevoked();

        bytes32 requestKey = _computeRequestKey(ctx);
        if (usedRequest[requestKey]) revert RequestUsed();

        uint256[2] memory pub = _publicSignals(ctx);
        if (!_verifyZkProof(proof, pub)) revert BadZkProof();

        usedRequest[requestKey] = true;

        emit VerifiedNoPoP(ctx.C, ctx.sid, ctx.aud, ctx.nonce, ctx.exp);
        return true;
    }
}
