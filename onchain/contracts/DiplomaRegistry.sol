// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

contract DiplomaRegistry is Ownable {
    error IssuerNotAllowed();
    error AlreadyRegistered();
    error NotRegistered();
    error AlreadyRevoked();
    error NotAuthorized();

    struct Record {
        address issuer;   // trường/đơn vị cấp
        bool active;      // true = hợp lệ, false = bị revoke
        uint64 issuedAt;  // timestamp đăng ký
        uint64 revokedAt; // timestamp thu hồi (0 nếu chưa thu hồi)
    }

    // commitment C (bytes32) -> record
    mapping(bytes32 => Record) public records;

    // allowlist issuer
    mapping(address => bool) public issuerAllowed;

    event IssuerAllowed(address indexed issuer, bool allowed);
    event Registered(bytes32 indexed C, address indexed issuer, uint64 issuedAt);
    event Revoked(bytes32 indexed C, address indexed issuer, uint64 revokedAt);

    constructor(address owner_) Ownable(owner_) {}

    modifier onlyAllowedIssuer() {
        if (!issuerAllowed[msg.sender]) revert IssuerNotAllowed();
        _;
    }

    function setIssuerAllowed(address issuer, bool allowed) external onlyOwner {
        issuerAllowed[issuer] = allowed;
        emit IssuerAllowed(issuer, allowed);
    }

    function register(bytes32 C) external onlyAllowedIssuer {
        Record storage r = records[C];
        if (r.issuedAt != 0) revert AlreadyRegistered();

        uint64 nowTs = uint64(block.timestamp);

        records[C] = Record({
            issuer: msg.sender,
            active: true,
            issuedAt: nowTs,
            revokedAt: 0
        });

        emit Registered(C, msg.sender, nowTs);
    }

    function revoke(bytes32 C) external {
        Record storage r = records[C];
        if (r.issuedAt == 0) revert NotRegistered();
        if (!r.active) revert AlreadyRevoked();
        if (msg.sender != r.issuer && msg.sender != owner()) revert NotAuthorized();

        uint64 nowTs = uint64(block.timestamp);

        r.active = false;
        r.revokedAt = nowTs;

        emit Revoked(C, r.issuer, nowTs);
    }

    function active(bytes32 C) external view returns (bool) {
        return records[C].active;
    }
}
