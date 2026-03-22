pragma circom 2.1.5;
include "../node_modules/circomlib/circuits/poseidon.circom";

/*
  Public inputs:
    C, sid

  Private inputs:
    sid_w, issuer, diplomaId, issuedAt

  Constraints:
    sid_w == sid
    Poseidon(sid_w, issuer, diplomaId, issuedAt) == C
*/

template DiplomaTrust() {
    // Public
    signal input C;
    signal input sid;

    // Private (witness)
    signal input sid_w;
    signal input issuer;
    signal input diplomaId;
    signal input issuedAt;

    sid_w === sid;

    component credHash = Poseidon(4);
    credHash.inputs[0] <== sid_w;
    credHash.inputs[1] <== issuer;
    credHash.inputs[2] <== diplomaId;
    credHash.inputs[3] <== issuedAt;
    credHash.out === C;
}

component main {public [C, sid]} = DiplomaTrust();
