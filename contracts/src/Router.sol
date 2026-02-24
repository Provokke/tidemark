// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice Makes internal calls on behalf of its caller, for call-trace tests: nested calls, and
/// calls that revert inside a transaction that succeeds.
contract Router {
    event Forwarded(uint256 indexed index, bool ok);

    /// Calls `target` with each payload. A failing call is recorded and skipped, not bubbled up.
    function forward(address target, bytes[] calldata calls) external {
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok,) = target.call(calls[i]);
            emit Forwarded(i, ok);
        }
    }

    /// Calls `target` and reverts afterwards, so every trace under it belongs to a reverted frame.
    function forwardThenRevert(address target, bytes calldata data) external {
        (bool ok,) = target.call(data);
        require(ok && false, "reverted on purpose");
    }

    /// Calls `forward` on itself, one level deeper, so traces have a nested trace address.
    function nested(address target, bytes[] calldata calls) external {
        this.forward(target, calls);
    }
}
