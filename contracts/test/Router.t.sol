// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {Router} from "../src/Router.sol";
import {Token} from "../src/Token.sol";
import {Child, Factory} from "../src/Factory.sol";

contract RouterTest is Test {
    Router internal router;
    Token internal token;

    function setUp() public {
        router = new Router();
        token = new Token();
        token.mint(address(router), 100);
    }

    function test_forward_recordsFailuresWithoutReverting() public {
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(Token.transfer, (address(1), 60));
        calls[1] = abi.encodeCall(Token.transfer, (address(2), 60)); // only 40 left
        vm.expectEmit(address(router));
        emit Router.Forwarded(0, true);
        vm.expectEmit(address(router));
        emit Router.Forwarded(1, false);
        router.forward(address(token), calls);
        assertEq(token.balanceOf(address(1)), 60);
        assertEq(token.balanceOf(address(2)), 0);
    }

    function test_forwardThenRevert_undoesTheCall() public {
        vm.expectRevert(bytes("reverted on purpose"));
        router.forwardThenRevert(address(token), abi.encodeCall(Token.transfer, (address(1), 1)));
        assertEq(token.balanceOf(address(1)), 0);
    }

    function test_createChildren_emitsOneEventPerChild() public {
        Factory factory = new Factory();
        vm.recordLogs();
        factory.createChildren(100, 5, "batch");
        // Each child emits Initialized and the factory emits ChildCreated.
        assertEq(vm.getRecordedLogs().length, 10);
        assertEq(Child(factory.predict(bytes32(uint256(104)), "batch")).label(), "batch");
    }
}
