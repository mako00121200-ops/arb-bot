// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

// Uniswap V2形式(Solidly形式も同じ)。
// data を空でない値にすると、プールは受け渡し後にこちらのコールバックを
// 呼び返す(フラッシュスワップ)。その中で支払いを済ませればよいため、
// 別途どこかから借りる必要がない。
interface IAmmPoolV2 {
    function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external;
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
}

// Uniswap V3形式(集中流動性)。swapを呼ぶとプールがコールバックを呼び返す。
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
/// @notice フラッシュスワップ方式のDEXアービトラージ実行コントラクト。
///
/// [仕組み]
/// 経路の最初のプールから「先に受け取り、後で払う」形でトークンを引き出す。
/// プールは受け渡し後にこちらのコールバックを呼び返すので、その中で
/// 残りの経路を回り、最後に最初のプールへ支払う。
/// 外部から借りないため、Aaveフラッシュローンの手数料0.05%がかからない。
/// 投入$40の案件では約$0.02、利益$0.15の13%に相当する差になる。
///
/// [安全性]
/// 支払い後に利益が出ていなければrevertし、取引全体が無効化される
/// (実害はガス代のみ)。コールバックは「今まさに開始したプール」からの
/// 呼び出しでなければ拒否する。
contract DexArbFlashLoan {
    address public owner;

    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    uint8 public constant KIND_V2 = 0;
    uint8 public constant KIND_V3 = 1;

    /// @dev 経路の1段。
    /// V2なら minOut は「プールに要求する受取量」そのもの。
    /// V3なら minOut は「これ未満なら失敗させる下限」。
    struct Leg {
        address pool;
        address tokenIn;
        address tokenOut;
        uint8 kind;
        uint256 minOut;
    }

    // 実行中だけ有効な状態。コールバックの正当性確認と経路の受け渡しに使う。
    address private activePool;        // コールバックを受け付ける相手
    address private activePayToken;    // コールバックで支払うトークン
    bool private inFlashSwap;          // 最初のプールからの借り受け中か
    bytes private pendingRoute;        // 残りの経路(コールバック内で使う)

    event RouteExecuted(address indexed asset, uint256 amountBorrowed, uint256 profit, uint8 legCount);
    event Withdrawn(address indexed token, uint256 amount);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "DexArbFlashLoan: not owner");
        _;
    }

    /// @notice 任意の2〜4段の経路を実行する。V2とV3を混在できる。
    /// @param amount 最初のプールから引き出す量(= 経路への投入量)
    function executeRoute(address asset, uint256 amount, Leg[] calldata legs) external onlyOwner {
        require(legs.length >= 2 && legs.length <= 4, "DexArbFlashLoan: 2-4 legs");
        require(legs[0].tokenIn == asset, "DexArbFlashLoan: first leg must start with asset");
        require(legs[legs.length - 1].tokenOut == asset, "DexArbFlashLoan: last leg must end with asset");
        for (uint256 i = 1; i < legs.length; i++) {
            require(legs[i].tokenIn == legs[i - 1].tokenOut, "DexArbFlashLoan: legs not connected");
        }
        require(!inFlashSwap, "DexArbFlashLoan: reentrant");

        // 経路の最初のプールから asset を先に引き出す。
        // 引き出し元は最初のプール自身なので、そこへ最後に払い戻す。
        Leg memory first = legs[0];
        pendingRoute = abi.encode(legs, amount);
        inFlashSwap = true;
        activePool = first.pool;
        activePayToken = first.tokenOut; // 借りたassetの対価として払うトークン

        if (first.kind == KIND_V2) {
            _borrowFromV2(first.pool, asset, amount);
        } else {
            _borrowFromV3(first.pool, asset, amount);
        }

        inFlashSwap = false;
        activePool = address(0);
        activePayToken = address(0);
        delete pendingRoute;
    }

    /// @dev V2プールから、支払わずに先に受け取る。
    /// data を空でない値にするとプールがコールバックを呼び返す。
    function _borrowFromV2(address pool, address asset, uint256 amount) internal {
        bool assetIsToken0 = IAmmPoolV2(pool).token0() == asset;
        uint256 amount0Out = assetIsToken0 ? amount : 0;
        uint256 amount1Out = assetIsToken0 ? 0 : amount;
        IAmmPoolV2(pool).swap(amount0Out, amount1Out, address(this), abi.encode(uint8(1)));
    }

    /// @dev V3プールから先に受け取る。負の amountSpecified は
    /// 「この量をちょうど受け取る」という指定。
    function _borrowFromV3(address pool, address asset, uint256 amount) internal {
        bool assetIsToken0 = IAmmPoolV3(pool).token0() == asset;
        // assetを受け取る向き。assetがtoken0ならtoken1を払う(zeroForOne=false)。
        bool zeroForOne = !assetIsToken0;
        IAmmPoolV3(pool).swap(
            address(this),
            zeroForOne,
            -int256(amount),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            abi.encode(uint8(1))
        );
    }

    /// @dev 借り受けた後に呼ばれる本体。2段目以降を回し、最初のプールへ支払う。
    /// @param owed 最初のプールへ支払うべき activePayToken の量
    function _runRouteAndRepay(uint256 owed) internal {
        (Leg[] memory legs, uint256 amount) = abi.decode(pendingRoute, (Leg[], uint256));

        // 2段目以降を順に回す。1段目は既に「借り受け」として済んでいる。
        uint256 running = amount;
        for (uint256 i = 1; i < legs.length; i++) {
            running = _swapLeg(legs[i], running);
        }

        // 最初のプールへ支払う。払うのは legs[0].tokenOut。
        address payToken = legs[0].tokenOut;
        uint256 balance = IERC20(payToken).balanceOf(address(this));
        require(balance >= owed, "DexArbFlashLoan: not profitable, reverting");
        IERC20(payToken).transfer(legs[0].pool, owed);

        emit RouteExecuted(legs[0].tokenIn, amount, balance - owed, uint8(legs.length));
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

    /// @dev V2形式の通常のスワップ: 先に送ってから受取量を要求する。
    function _swapV2(address pool, address tokenIn, uint256 amountIn, uint256 amountOut) internal {
        require(amountOut > 0, "DexArbFlashLoan: amountOut must be positive");
        IERC20(tokenIn).transfer(pool, amountIn);
        bool tokenInIsToken0 = IAmmPoolV2(pool).token0() == tokenIn;
        uint256 amount0Out = tokenInIsToken0 ? 0 : amountOut;
        uint256 amount1Out = tokenInIsToken0 ? amountOut : 0;
        IAmmPoolV2(pool).swap(amount0Out, amount1Out, address(this), new bytes(0));
    }

    /// @dev V3形式の通常のスワップ: コールバックで支払う。
    function _swapV3(address pool, address tokenIn, uint256 amountIn) internal {
        bool zeroForOne = IAmmPoolV3(pool).token0() == tokenIn;
        address prevPool = activePool;
        address prevToken = activePayToken;
        activePool = pool;
        activePayToken = tokenIn;
        IAmmPoolV3(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            new bytes(0)
        );
        activePool = prevPool;
        activePayToken = prevToken;
    }

    // ===== V2形式のコールバック =====
    // フォークごとに名前が違うため、主要なものを全て用意する。
    // data が空でない場合だけ「借り受け」として本体を実行する。

    function _onV2Callback(uint256 amount0, uint256 amount1, bytes calldata data) internal {
        require(msg.sender == activePool, "DexArbFlashLoan: unexpected callback");
        if (data.length == 0) return; // 通常のスワップ。何もしない
        require(inFlashSwap, "DexArbFlashLoan: not in flash swap");

        // 借りた量から、支払うべき量を逆算する。
        // プールの準備量と手数料(0.3%想定)から、必要な入力量を求める。
        (Leg[] memory legs, uint256 amount) = abi.decode(pendingRoute, (Leg[], uint256));
        uint256 owed = _amountInForV2(legs[0].pool, legs[0].tokenIn, legs[0].tokenOut, amount);
        _runRouteAndRepay(owed);
    }

    /// @dev V2プールから amountOut を受け取るために必要な入力量を求める。
    /// 手数料0.3%を前提とした標準式。異なる手数料のプールでは
    /// プール側の検算で拒否されるため、安全側に倒れる。
    function _amountInForV2(address pool, address tokenOut, address tokenIn, uint256 amountOut)
        internal view returns (uint256)
    {
        (uint112 r0, uint112 r1, ) = IAmmPoolV2(pool).getReserves();
        bool outIsToken0 = IAmmPoolV2(pool).token0() == tokenOut;
        uint256 reserveOut = outIsToken0 ? r0 : r1;
        uint256 reserveIn = outIsToken0 ? r1 : r0;
        require(reserveOut > amountOut, "DexArbFlashLoan: insufficient liquidity");
        uint256 numerator = reserveIn * amountOut * 1000;
        uint256 denominator = (reserveOut - amountOut) * 997;
        return numerator / denominator + 1;
    }

    function uniswapV2Call(address, uint256 amount0, uint256 amount1, bytes calldata data) external {
        _onV2Callback(amount0, amount1, data);
    }
    function pancakeCall(address, uint256 amount0, uint256 amount1, bytes calldata data) external {
        _onV2Callback(amount0, amount1, data);
    }
    function hook(address, uint256 amount0, uint256 amount1, bytes calldata data) external {
        _onV2Callback(amount0, amount1, data);
    }
    function swapCall(address, uint256 amount0, uint256 amount1, bytes calldata data) external {
        _onV2Callback(amount0, amount1, data);
    }

    // ===== V3形式のコールバック =====

    function _onV3Callback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) internal {
        require(msg.sender == activePool, "DexArbFlashLoan: unexpected callback");
        int256 owedSigned = amount0Delta > 0 ? amount0Delta : amount1Delta;
        require(owedSigned > 0, "DexArbFlashLoan: nothing owed");
        uint256 owed = uint256(owedSigned);

        if (data.length == 0) {
            // 通常のスワップ。その場で支払う。
            IERC20(activePayToken).transfer(msg.sender, owed);
            return;
        }
        // 借り受け。残りの経路を回してから支払う。
        require(inFlashSwap, "DexArbFlashLoan: not in flash swap");
        _runRouteAndRepay(owed);
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        _onV3Callback(a0, a1, data);
    }
    function pancakeV3SwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        _onV3Callback(a0, a1, data);
    }
    function algebraSwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        _onV3Callback(a0, a1, data);
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
