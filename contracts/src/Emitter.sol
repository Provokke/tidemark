// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice Emits one event of every ABI shape the indexer must decode. Each event has an
/// `emit*` function that takes its arguments, so tests can round-trip arbitrary values
/// through a real chain and compare what the decoder returns with what was sent.
contract Emitter {
    struct Pair {
        uint256 x;
        address y;
    }

    struct Nested {
        Pair inner;
        Pair[] list;
        string label;
    }

    event NoArgs();

    event Simple(address indexed from, address indexed to, uint256 value);

    event AllStatic(uint8 a, uint64 b, uint256 c, int8 d, int256 e, bool f, address g, bytes32 h, bytes4 i);

    event Dynamic(string s, bytes b);

    event Arrays(uint256[] dyn, address[3] fixedArr, string[] strs, bytes32[][] nested);

    event Tuple(Pair p, Nested n);

    /// Indexed dynamic values are stored as the keccak256 of their encoding, so a decoder can only
    /// return the hash for these.
    event IndexedDynamic(string indexed s, bytes indexed b, uint256[] indexed arr);

    /// An indexed struct is also stored as a hash: keccak256 of its ABI encoding.
    event IndexedTuple(Pair indexed p, uint256 tag);

    event IndexedStatic(uint256 indexed a, bool indexed b, bytes32 indexed c, int256 d);

    /// Anonymous events have no topic0, so they may index four values and cannot be found by
    /// signature.
    event AnonymousFour(
        uint256 indexed a, uint256 indexed b, uint256 indexed c, uint256 indexed d, string e
    ) anonymous;

    /// Same name, different signatures: the registry must name these unambiguously.
    event Overloaded(uint256 value);
    event Overloaded(address value);

    function emitNoArgs() external {
        emit NoArgs();
    }

    function emitSimple(address to, uint256 value) external {
        emit Simple(msg.sender, to, value);
    }

    /// Several logs from one transaction, for log-index and ordinal ordering tests.
    function emitMany(address to, uint256 count) external {
        for (uint256 i = 0; i < count; i++) {
            emit Simple(msg.sender, to, i);
        }
    }

    function emitAllStatic(
        uint8 a,
        uint64 b,
        uint256 c,
        int8 d,
        int256 e,
        bool f,
        address g,
        bytes32 h,
        bytes4 i
    ) external {
        emit AllStatic(a, b, c, d, e, f, g, h, i);
    }

    function emitDynamic(string calldata s, bytes calldata b) external {
        emit Dynamic(s, b);
    }

    function emitArrays(
        uint256[] calldata dyn,
        address[3] calldata fixedArr,
        string[] calldata strs,
        bytes32[][] calldata nested
    ) external {
        emit Arrays(dyn, fixedArr, strs, nested);
    }

    function emitTuple(Pair calldata p, Nested calldata n) external {
        emit Tuple(p, n);
    }

    function emitIndexedDynamic(string calldata s, bytes calldata b, uint256[] calldata arr) external {
        emit IndexedDynamic(s, b, arr);
    }

    function emitIndexedTuple(Pair calldata p, uint256 tag) external {
        emit IndexedTuple(p, tag);
    }

    function emitIndexedStatic(uint256 a, bool b, bytes32 c, int256 d) external {
        emit IndexedStatic(a, b, c, d);
    }

    function emitAnonymousFour(uint256 a, uint256 b, uint256 c, uint256 d, string calldata e) external {
        emit AnonymousFour(a, b, c, d, e);
    }

    function emitOverloaded(uint256 value, address other) external {
        emit Overloaded(value);
        emit Overloaded(other);
    }
}
