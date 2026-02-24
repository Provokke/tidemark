// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice A child contract created by `Factory`. Its constructor emits `Initialized`, which lands
/// in the same transaction as, and before, the factory's `ChildCreated`. The indexer's factory
/// discovery has to handle a child whose first log precedes the log that announces it.
contract Child {
    address public immutable factory;
    string public label;

    event Initialized(address indexed factory, string label);
    event Ping(uint256 indexed id, address indexed caller);

    constructor(string memory label_) {
        factory = msg.sender;
        label = label_;
        emit Initialized(msg.sender, label_);
    }

    function ping(uint256 id) external {
        emit Ping(id, msg.sender);
    }
}

/// @notice Creates `Child` contracts with CREATE2, so their addresses are predictable in tests.
contract Factory {
    event ChildCreated(address indexed child, bytes32 indexed salt, string label);

    error ChildExists(address child);

    function createChild(bytes32 salt, string calldata label) external returns (address child) {
        address predicted = predict(salt, label);
        if (predicted.code.length != 0) revert ChildExists(predicted);
        child = address(new Child{salt: salt}(label));
        emit ChildCreated(child, salt, label);
    }

    /// Creates `count` children in one transaction, with salts `saltBase + i`. For tests that need
    /// thousands of children.
    function createChildren(uint256 saltBase, uint256 count, string calldata label) external {
        for (uint256 i = 0; i < count; i++) {
            bytes32 salt = bytes32(saltBase + i);
            address child = address(new Child{salt: salt}(label));
            emit ChildCreated(child, salt, label);
        }
    }

    function predict(bytes32 salt, string calldata label) public view returns (address) {
        bytes32 initCodeHash = keccak256(abi.encodePacked(type(Child).creationCode, abi.encode(label)));
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))))
        );
    }
}
