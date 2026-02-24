// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {Token} from "../src/Token.sol";

contract TokenTest is Test {
    Token internal token;
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        token = new Token();
    }

    function testFuzz_mintAndTransfer_conserveSupply(uint128 minted, uint128 sent) public {
        vm.assume(sent <= minted);
        token.mint(alice, minted);
        vm.prank(alice);
        token.transfer(bob, sent);
        assertEq(token.balanceOf(alice) + token.balanceOf(bob), token.totalSupply());
        assertEq(token.balanceOf(bob), sent);
    }

    function test_transfer_revertsWithoutBalance() public {
        vm.expectRevert(abi.encodeWithSelector(Token.InsufficientBalance.selector, alice, 0, 1));
        vm.prank(alice);
        token.transfer(bob, 1);
    }

    function test_transferFrom_spendsAllowance() public {
        token.mint(alice, 100);
        vm.prank(alice);
        token.approve(address(this), 60);
        token.transferFrom(alice, bob, 50);
        assertEq(token.allowance(alice, address(this)), 10);
        vm.expectRevert(abi.encodeWithSelector(Token.InsufficientAllowance.selector, address(this), 10, 20));
        token.transferFrom(alice, bob, 20);
    }

    function test_batchTransfer_emitsOneEventPerRecipient() public {
        token.mint(address(this), 1000);
        address[] memory to = new address[](3);
        uint256[] memory amounts = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) {
            to[i] = address(uint160(i + 1));
            amounts[i] = i + 1;
        }
        vm.recordLogs();
        token.batchTransfer(to, amounts);
        assertEq(vm.getRecordedLogs().length, 3);
        assertEq(token.balanceOf(address(this)), 994);
    }
}
