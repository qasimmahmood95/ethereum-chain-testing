// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Minimal ERC-20 test fixture (docs/PLAN.md M6). Mint, transfer and
/// batchTransfer only; configurable decimals so suites can cover 6 and
/// 18. Deployed fresh per suite on local Anvil — never production
/// (CLAUDE.md scope).
contract TestToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    /// Several transfers in one tx: S14's multiple-logs-per-tx case.
    function batchTransfer(
        address[] calldata to,
        uint256[] calldata values
    ) external {
        require(to.length == values.length, "length mismatch");
        for (uint256 i = 0; i < to.length; i++) {
            _move(msg.sender, to[i], values[i]);
        }
    }

    function _move(address from, address to, uint256 value) internal {
        uint256 fromBalance = balanceOf[from];
        require(fromBalance >= value, "insufficient balance");
        unchecked {
            balanceOf[from] = fromBalance - value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
