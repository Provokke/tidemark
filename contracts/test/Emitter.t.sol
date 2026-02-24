// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test, Vm} from "forge-std/Test.sol";
import {Emitter} from "../src/Emitter.sol";

contract EmitterTest is Test {
    Emitter internal emitter;

    function setUp() public {
        emitter = new Emitter();
    }

    function test_noArgs() public {
        vm.expectEmit(address(emitter));
        emit Emitter.NoArgs();
        emitter.emitNoArgs();
    }

    function testFuzz_simple(address to, uint256 value) public {
        vm.expectEmit(true, true, false, true, address(emitter));
        emit Emitter.Simple(address(this), to, value);
        emitter.emitSimple(to, value);
    }

    function test_many_logIndexesAreSequential() public {
        vm.recordLogs();
        emitter.emitMany(address(0xBEEF), 5);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 5);
        for (uint256 i = 0; i < logs.length; i++) {
            assertEq(logs[i].topics[0], Emitter.Simple.selector);
            assertEq(abi.decode(logs[i].data, (uint256)), i);
        }
    }

    function testFuzz_allStatic(
        uint8 a,
        uint64 b,
        uint256 c,
        int8 d,
        int256 e,
        bool f,
        address g,
        bytes32 h,
        bytes4 i
    ) public {
        vm.expectEmit(address(emitter));
        emit Emitter.AllStatic(a, b, c, d, e, f, g, h, i);
        emitter.emitAllStatic(a, b, c, d, e, f, g, h, i);
    }

    function testFuzz_dynamic(string calldata s, bytes calldata b) public {
        vm.expectEmit(address(emitter));
        emit Emitter.Dynamic(s, b);
        emitter.emitDynamic(s, b);
    }

    function test_arrays() public {
        uint256[] memory dyn = new uint256[](2);
        dyn[0] = 1;
        dyn[1] = type(uint256).max;
        address[3] memory fixedArr = [address(1), address(2), address(3)];
        string[] memory strs = new string[](2);
        strs[0] = "";
        strs[1] = unicode"héllo";
        bytes32[][] memory nested = new bytes32[][](2);
        nested[0] = new bytes32[](0);
        nested[1] = new bytes32[](1);
        nested[1][0] = keccak256("x");

        vm.expectEmit(address(emitter));
        emit Emitter.Arrays(dyn, fixedArr, strs, nested);
        emitter.emitArrays(dyn, fixedArr, strs, nested);
    }

    function test_tuple() public {
        Emitter.Pair memory p = Emitter.Pair(7, address(0xCAFE));
        Emitter.Pair[] memory list = new Emitter.Pair[](2);
        list[0] = Emitter.Pair(1, address(1));
        list[1] = Emitter.Pair(2, address(2));
        Emitter.Nested memory n = Emitter.Nested(p, list, "nested");

        vm.expectEmit(address(emitter));
        emit Emitter.Tuple(p, n);
        emitter.emitTuple(p, n);
    }

    function test_indexedDynamic_topicsAreHashes() public {
        uint256[] memory arr = new uint256[](2);
        arr[0] = 1;
        arr[1] = 2;

        vm.recordLogs();
        emitter.emitIndexedDynamic("str", hex"0102", arr);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1);
        assertEq(logs[0].topics.length, 4);
        assertEq(logs[0].topics[1], keccak256(bytes("str")));
        assertEq(logs[0].topics[2], keccak256(hex"0102"));
        assertEq(logs[0].topics[3], keccak256(abi.encodePacked(arr)));
        assertEq(logs[0].data.length, 0);
    }

    function test_indexedTuple_topicIsHashOfEncoding() public {
        Emitter.Pair memory p = Emitter.Pair(9, address(0xABCD));

        vm.recordLogs();
        emitter.emitIndexedTuple(p, 42);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1);
        assertEq(logs[0].topics.length, 2);
        assertEq(logs[0].topics[1], keccak256(abi.encode(p.x, p.y)));
        assertEq(abi.decode(logs[0].data, (uint256)), 42);
    }

    function testFuzz_indexedStatic(uint256 a, bool b, bytes32 c, int256 d) public {
        vm.expectEmit(true, true, true, true, address(emitter));
        emit Emitter.IndexedStatic(a, b, c, d);
        emitter.emitIndexedStatic(a, b, c, d);
    }

    function test_anonymous_hasNoSignatureTopic() public {
        vm.recordLogs();
        emitter.emitAnonymousFour(1, 2, 3, 4, "anon");
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1);
        assertEq(logs[0].topics.length, 4);
        assertEq(uint256(logs[0].topics[0]), 1);
        assertEq(uint256(logs[0].topics[3]), 4);
        assertEq(abi.decode(logs[0].data, (string)), "anon");
    }

    function test_overloaded_haveDistinctSelectors() public {
        vm.recordLogs();
        emitter.emitOverloaded(5, address(6));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 2);
        assertEq(logs[0].topics[0], keccak256("Overloaded(uint256)"));
        assertEq(logs[1].topics[0], keccak256("Overloaded(address)"));
    }
}
