// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test, Vm} from "forge-std/Test.sol";
import {Child, Factory} from "../src/Factory.sol";

contract FactoryTest is Test {
    Factory internal factory;

    function setUp() public {
        factory = new Factory();
    }

    function testFuzz_createChild_landsAtPredictedAddress(bytes32 salt, string calldata label) public {
        address predicted = factory.predict(salt, label);
        address child = factory.createChild(salt, label);
        assertEq(child, predicted);
        assertEq(Child(child).factory(), address(factory));
        assertEq(Child(child).label(), label);
    }

    function test_childInitializedPrecedesChildCreated() public {
        vm.recordLogs();
        address child = factory.createChild(bytes32(uint256(1)), "first");
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 2);
        assertEq(logs[0].emitter, child);
        assertEq(logs[0].topics[0], Child.Initialized.selector);
        assertEq(logs[1].emitter, address(factory));
        assertEq(logs[1].topics[0], Factory.ChildCreated.selector);
        assertEq(address(uint160(uint256(logs[1].topics[1]))), child);
    }

    function test_createChild_revertsOnReusedSalt() public {
        address child = factory.createChild(bytes32(0), "a");
        vm.expectRevert(abi.encodeWithSelector(Factory.ChildExists.selector, child));
        factory.createChild(bytes32(0), "a");
    }

    function testFuzz_ping(uint256 id) public {
        Child child = Child(factory.createChild(bytes32(0), "c"));
        vm.expectEmit(true, true, false, false, address(child));
        emit Child.Ping(id, address(this));
        child.ping(id);
    }
}
