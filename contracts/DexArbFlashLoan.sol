// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

interface IPoolAddressesProvider {
    function getPool() external view returns (address);
}

interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

// Uniswap V2形式(Solidly形式も同じ)。ルーターを介さずプールを直接呼ぶ。
interface IAmmPoolV2 {
    function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external;
    function token0() external view returns (address);
}

// Uniswap V3形式(集中流動性)。swapを呼ぶと、プールがこちらのコールバックを
// 呼び返してきて、その中で支払いを済ませる仕組み。
interface IAmmPoolV3 {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
    function token0() external view returns (address);
}

/// @title DexArbFlashLoan
/// @notice Aave V3フラッシュローンを使ったDEXアービトラージ実行コントラクト。
///         V2形式とV3形式のプールを同じ経路に混在させられる(2〜4段)。
///         利益が出ない場合はrevertし、取引全体が無効化される(実害はガス代のみ)。
contract DexArbFlashLoan {
    IPoolAddressesProvider public immutable ADDRESSES_PROVIDER;
    IPool public immutable POOL;
    address public owner;

    // V3の価格制限。「制限なし」に相当する最小・最大値(Uniswap V3の定数)。
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    uint8 public constant KIND_V2 = 0;
    uint8 public constant KIND_V3 = 1;

    // V3のコールバック中だけ有効。どのプールからの呼び出しを受け入れ、
    // どのトークンで支払うかを記録する(第三者がコールバックを偽装して
    // 資産を抜き取るのを防ぐ)。
    address private expectedCallbackPool;
    address private expectedCallbackTokenIn;

    constructor(address _addressProvider) {
        ADDRESSES_PROVIDER = IPoolAddressesProvider(_addressProvider);
        POOL = IPool(ADDRESSES_PROVIDER.getPool());
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "DexArbFlashLoan: not owner");
        _;
    }

    /// @dev 経路の1段。V2なら minOut は「プールに要求する受取量」そのもの。
    ///      V3なら minOut は「これ未満なら失敗させる下限」。
    struct Leg {
        address pool;
        address tokenIn;
        address tokenOut;
        uint8 kind;
        uint256 minOut;
    }

    event RouteExecuted(address indexed asset, uint256 amountBorrowed, uint256 profit, uint8 legCount);
    event Withdrawn(address indexed token, uint256 amount);

    /// @notice 任意の2〜4段の経路を実行する。V2とV3を混在できる。
    function executeRoute(address asset, uint256 amount, Leg[] calldata legs) external onlyOwner {
        require(legs.length >= 2 && legs.length <= 4, "DexArbFlashLoan: 2-4 legs");
        require(legs[0].tokenIn == asset, "DexArbFlashLoan: first leg must start with asset");
        require(legs[legs.length - 1].tokenOut == asset, "DexArbFlashLoan: last leg must end with asset");
        for (uint256 i = 1; i < legs.length; i++) {
            require(legs[i].tokenIn == legs[i - 1].tokenOut, "DexArbFlashLoan: legs not connected");
        }
        POOL.flashLoanSimple(address(this), asset, amount, abi.encode(legs), 0);
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address /* initiator */,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(POOL), "DexArbFlashLoan: caller must be Aave Pool");

        Leg[] memory legs = abi.decode(params, (Leg[]));
        uint256 running = amount;
        for (uint256 i = 0; i < legs.length; i++) {
            running = _swapLeg(legs[i], running);
        }

        uint256 amountOwed = amount + premium;
        uint256 balance = IERC20(asset).balanceOf(address(this));
        require(balance >= amountOwed, "DexArbFlashLoan: not profitable, reverting");

        IERC20(asset).approve(address(POOL), amountOwed);
        emit RouteExecuted(asset, amount, balance - amountOwed, uint8(legs.length));
        return true;
    }

    /// @dev 1段をスワップし、実際に受け取った量を返す(残高の差分で測る)。
    function _swapLeg(Leg memory leg, uint256 amountIn) internal returns (uint256) {
        require(amountIn > 0, "DexArbFlashLoan: zero input");
        uint256 before = IERC20(leg.tokenOut).balanceOf(address(this));

        if (leg.kind == KIND_V2) {
            _swapV2(leg.pool, leg.tokenIn, amountIn, leg.minOut);
        } else if (leg.kind == KIND_V3) {
            _swapV3(leg.pool, leg.tokenIn, amountIn);
        } else {
            revert("DexArbFlashLoan: unknown pool kind");
        }

        uint256 received = IERC20(leg.tokenOut).balanceOf(address(this)) - before;
        require(received >= leg.minOut, "DexArbFlashLoan: insufficient output");
        return received;
    }

    /// @dev V2形式: ①プールへ送る ②swapで受取量を要求する。
    /// プールが「送られた量に見合うか」を検算し、過大なら拒否する。
    function _swapV2(address pool, address tokenIn, uint256 amountIn, uint256 amountOut) internal {
        require(amountOut > 0, "DexArbFlashLoan: amountOut must be positive");
        IERC20(tokenIn).transfer(pool, amountIn);
        bool tokenInIsToken0 = IAmmPoolV2(pool).token0() == tokenIn;
        uint256 amount0Out = tokenInIsToken0 ? 0 : amountOut;
        uint256 amount1Out = tokenInIsToken0 ? amountOut : 0;
        IAmmPoolV2(pool).swap(amount0Out, amount1Out, address(this), new bytes(0));
    }

    /// @dev V3形式: swapを呼ぶと、プールがコールバックで支払いを求めてくる。
    /// 受取量は残高差分で測るため、ここでは検算しない。
    function _swapV3(address pool, address tokenIn, uint256 amountIn) internal {
        bool zeroForOne = IAmmPoolV3(pool).token0() == tokenIn;
        expectedCallbackPool = pool;
        expectedCallbackTokenIn = tokenIn;
        IAmmPoolV3(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            new bytes(0)
        );
        expectedCallbackPool = address(0);
        expectedCallbackTokenIn = address(0);
    }

    /// @dev V3プールからの支払い要求。呼び出し元が「今まさにswap中のプール」
    /// であることを確認し、要求された量のtokenInを支払う。
    function _payV3Callback(int256 amount0Delta, int256 amount1Delta) internal {
        require(msg.sender == expectedCallbackPool, "DexArbFlashLoan: unexpected callback");
        int256 owed = amount0Delta > 0 ? amount0Delta : amount1Delta;
        require(owed > 0, "DexArbFlashLoan: nothing owed");
        IERC20(expectedCallbackTokenIn).transfer(msg.sender, uint256(owed));
    }

    // Uniswap V3 / Aerodrome Slipstream 等
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _payV3Callback(amount0Delta, amount1Delta);
    }
    // PancakeSwap V3
    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _payV3Callback(amount0Delta, amount1Delta);
    }
    // Algebra(QuickSwap V3 等)
    function algebraSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _payV3Callback(amount0Delta, amount1Delta);
    }

    // ===== 残高確認と引き出し =====

    function balanceOfToken(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function balancesOf(address[] calldata tokens) external view returns (uint256[] memory) {
        uint256[] memory out = new uint256[](tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            out[i] = IERC20(tokens[i]).balanceOf(address(this));
        }
        return out;
    }

    function withdraw(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "DexArbFlashLoan: nothing to withdraw");
        IERC20(token).transfer(owner, balance);
        emit Withdrawn(token, balance);
    }

    function withdrawAmount(address token, uint256 amount) external onlyOwner {
        require(amount > 0, "DexArbFlashLoan: amount must be positive");
        require(IERC20(token).balanceOf(address(this)) >= amount, "DexArbFlashLoan: insufficient balance");
        IERC20(token).transfer(owner, amount);
        emit Withdrawn(token, amount);
    }
}
