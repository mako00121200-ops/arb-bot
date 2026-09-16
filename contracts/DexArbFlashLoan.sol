// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

// Uniswap V2形式(Solidly形式も同じ)。
// data を空でない値にすると、プールは受け渡し後にこちらのコールバックを
// 呼び返す(フラッシュスワップ)。
interface IAmmPoolV2 {
    function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external;
    function token0() external view returns (address);
}

// Uniswap V3形式(集中流動性)。swapを呼ぶと、出力を先に送った後で
// プールがコールバックを呼び返し、そこで入力を支払う。
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
/// [仕組み(2026年9月16日に向きを修正)]
///   1. 経路の最初のプールから、1段目の出力通貨(legs[0].tokenOut)を先に受け取る
///   2. プールがコールバックを呼び返すので、その中で2段目以降を回して
///      投入通貨(asset = legs[0].tokenIn)に戻す
///   3. 最初のプールへ asset を支払う
///      V2 … 投入額(amount)そのもの。受取量が多すぎればプール側のK検算で拒否される
///      V3 … プールが通知する支払額(投入額を上限とする正確な値)
/// 以前の版は最初のプールから asset を借りており、2段目で持っていない
/// 通貨を送ろうとして "transfer amount exceeds balance" で必ず失敗していた。
///
/// [受取量の数え方]
/// 各段の受取量は要求量ではなく「実行前後の残高差」で数える。送金時に
/// 税を取るトークンで受取量が足りなければ "insufficient output" で止まる。
///
/// [利益の判定]
/// コントラクトに過去の利益が残っていても誤判定しないよう、asset の残高を
/// 実行前と比べる。支払額に届かなければrevertし、取引全体が無効化される
/// (実害はガス代のみ)。
contract DexArbFlashLoan {
    address public owner;

    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    uint8 public constant KIND_V2 = 0;
    uint8 public constant KIND_V3 = 1;

    /// @dev 経路の1段。
    /// minOut はその段で受け取るべき最低量。V2ではプールに要求する受取量そのもの。
    struct Leg {
        address pool;
        address tokenIn;
        address tokenOut;
        uint8 kind;
        uint256 minOut;
    }

    // 実行中だけ有効な状態。
    address private activePool;      // コールバックを受け付ける相手
    address private activePayToken;  // 経路途中のV3で支払う通貨
    bool private inFlashSwap;        // 最初のプールからの受け取り待ち

    event RouteExecuted(address indexed asset, uint256 amountIn, uint256 profit, uint8 legCount);
    event Withdrawn(address indexed token, uint256 amount);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "DexArbFlashLoan: not owner");
        _;
    }

    /// @notice 任意の2〜4段の経路を実行する。V2とV3を混在できる。
    /// @param asset 経路の始点かつ終点の通貨(利益はこの通貨で残る)
    /// @param amount 最初のプールへ支払う投入額
    function executeRoute(address asset, uint256 amount, Leg[] calldata legs) external onlyOwner {
        require(legs.length >= 2 && legs.length <= 4, "DexArbFlashLoan: 2-4 legs");
        require(amount > 0, "DexArbFlashLoan: zero amount");
        require(legs[0].tokenIn == asset, "DexArbFlashLoan: first leg must start with asset");
        require(legs[legs.length - 1].tokenOut == asset, "DexArbFlashLoan: last leg must end with asset");
        for (uint256 i = 1; i < legs.length; i++) {
            require(legs[i].tokenIn == legs[i - 1].tokenOut, "DexArbFlashLoan: legs not connected");
        }
        require(!inFlashSwap, "DexArbFlashLoan: reentrant");

        uint256 assetBefore = IERC20(asset).balanceOf(address(this));
        uint256 firstOutBefore = IERC20(legs[0].tokenOut).balanceOf(address(this));
        bytes memory data = abi.encode(legs, amount, assetBefore, firstOutBefore);

        inFlashSwap = true;
        activePool = legs[0].pool;

        if (legs[0].kind == KIND_V2) {
            _borrowFromV2(legs[0].pool, legs[0].tokenOut, legs[0].minOut, data);
        } else if (legs[0].kind == KIND_V3) {
            _borrowFromV3(legs[0].pool, asset, amount, data);
        } else {
            revert("DexArbFlashLoan: unknown pool kind");
        }

        require(!inFlashSwap, "DexArbFlashLoan: callback not received");
        activePool = address(0);
        activePayToken = address(0);
    }

    /// @dev V2プールから、1段目の出力通貨を支払わずに先に受け取る。
    function _borrowFromV2(address pool, address tokenOut, uint256 amountOut, bytes memory data) internal {
        require(amountOut > 0, "DexArbFlashLoan: amountOut must be positive");
        bool outIsToken0 = IAmmPoolV2(pool).token0() == tokenOut;
        IAmmPoolV2(pool).swap(outIsToken0 ? amountOut : 0, outIsToken0 ? 0 : amountOut, address(this), data);
    }

    /// @dev V3プールで asset を投入額ちょうど売る。出力が先に届き、
    /// 支払いはコールバックの中で経路を回した後に行う。
    function _borrowFromV3(address pool, address asset, uint256 amount, bytes memory data) internal {
        bool zeroForOne = IAmmPoolV3(pool).token0() == asset;
        IAmmPoolV3(pool).swap(
            address(this),
            zeroForOne,
            int256(amount),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            data
        );
    }

    /// @dev 最初のプールから受け取った後に呼ばれる本体。
    /// @param v3Owed 最初のプールがV3の場合の支払額(V2では使わない)
    function _runRouteAndRepay(bytes memory data, uint256 v3Owed) internal {
        (Leg[] memory legs, uint256 amountIn, uint256 assetBefore, uint256 firstOutBefore) =
            abi.decode(data, (Leg[], uint256, uint256, uint256));
        inFlashSwap = false; // 以降、借り受けのコールバックは受け付けない

        uint256 running = IERC20(legs[0].tokenOut).balanceOf(address(this)) - firstOutBefore;
        require(running >= legs[0].minOut, "DexArbFlashLoan: insufficient output");

        for (uint256 i = 1; i < legs.length; i++) {
            running = _swapLeg(legs[i], running);
        }

        _repayAndReport(legs, amountIn, assetBefore, v3Owed);
    }

    /// @dev 利益を確認してから最初のプールへ支払う。
    /// (ローカル変数を減らすため、本体から分けている)
    function _repayAndReport(Leg[] memory legs, uint256 amountIn, uint256 assetBefore, uint256 v3Owed) internal {
        uint256 owed = legs[0].kind == KIND_V3 ? v3Owed : amountIn;
        address asset = legs[0].tokenIn;
        uint256 assetNow = IERC20(asset).balanceOf(address(this));
        require(assetNow >= assetBefore + owed, "DexArbFlashLoan: not profitable, reverting");
        _safeTransfer(asset, legs[0].pool, owed);
        emit RouteExecuted(asset, amountIn, assetNow - assetBefore - owed, uint8(legs.length));
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
        _safeTransfer(tokenIn, pool, amountIn);
        bool tokenInIsToken0 = IAmmPoolV2(pool).token0() == tokenIn;
        IAmmPoolV2(pool).swap(tokenInIsToken0 ? 0 : amountOut, tokenInIsToken0 ? amountOut : 0, address(this), new bytes(0));
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

    /// @dev 戻り値の無いトークン(USDT等)にも対応した送金。
    /// 失敗した場合はトークン側の拒否理由をそのまま返す(botの判定に使う)。
    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            revert("DexArbFlashLoan: transfer failed");
        }
        require(ret.length == 0 || abi.decode(ret, (bool)), "DexArbFlashLoan: transfer failed");
    }

    // ===== V2形式のコールバック =====
    // フォークごとに名前が違うため、主要なものを全て用意する。

    function _onV2Callback(address sender, bytes calldata data) internal {
        if (data.length == 0) return; // 通常のスワップ。何もしない
        require(sender == address(this), "DexArbFlashLoan: unexpected initiator");
        require(msg.sender == activePool && inFlashSwap, "DexArbFlashLoan: unexpected callback");
        _runRouteAndRepay(data, 0);
    }

    function uniswapV2Call(address sender, uint256, uint256, bytes calldata data) external {
        _onV2Callback(sender, data);
    }
    function pancakeCall(address sender, uint256, uint256, bytes calldata data) external {
        _onV2Callback(sender, data);
    }
    function hook(address sender, uint256, uint256, bytes calldata data) external {
        _onV2Callback(sender, data);
    }
    function swapCall(address sender, uint256, uint256, bytes calldata data) external {
        _onV2Callback(sender, data);
    }

    // ===== V3形式のコールバック =====

    function _onV3Callback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) internal {
        require(msg.sender == activePool, "DexArbFlashLoan: unexpected callback");
        int256 owedSigned = amount0Delta > 0 ? amount0Delta : amount1Delta;
        require(owedSigned > 0, "DexArbFlashLoan: nothing owed");
        uint256 owed = uint256(owedSigned);

        if (data.length == 0) {
            // 経路途中の通常のスワップ。その場で支払う。
            _safeTransfer(activePayToken, msg.sender, owed);
            return;
        }
        // 最初のプール。残りの経路を回してから支払う。
        require(inFlashSwap, "DexArbFlashLoan: not in flash swap");
        _runRouteAndRepay(data, owed);
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
        _safeTransfer(token, owner, balance);
        emit Withdrawn(token, balance);
    }

    function withdrawAmount(address token, uint256 amount) external onlyOwner {
        require(amount > 0, "DexArbFlashLoan: amount must be positive");
        require(IERC20(token).balanceOf(address(this)) >= amount, "DexArbFlashLoan: insufficient balance");
        _safeTransfer(token, owner, amount);
        emit Withdrawn(token, amount);
    }
}
