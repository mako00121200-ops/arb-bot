// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

// Uniswap V2形式(Solidly形式も同じ)。
interface IAmmPoolV2 {
    function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external;
    function token0() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

// Solidly系・Camelot等は、プール自身が受取量を計算する関数を持つ。
interface IAmmQuoteV2 {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
}

// Uniswap V3形式(集中流動性)。
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
/// [受取量はチェーン上で計算する(2026年9月17日)]
/// 以前はbotが各段の受取量を事前に計算して渡していた。botの手元の準備量や
/// 手数料の想定、価格表が少しでも古いと、要求量が合わずに失敗するか、
/// 安全余裕(各段5bps)で薄い機会を赤字と判定していた。
/// この版では、各段の受取量を「実行するその瞬間の準備量」から計算する。
///   V2 … プールが getAmountOut を持っていればそれを使い(Solidly系・Camelot等)、
///        無ければ準備量と手数料(botが実測値を渡す)から計算する
///   V3 … 投入額ちょうどをスワップする(プールが正確に計算する)
/// 送金時に税を取るトークンは、プールに実際に届いた量で計算するので、
/// 失敗ではなく「利益が減る」だけになる。
///
/// [結果の問い合わせ]
/// simulateRoute は経路を最後まで実行し、戻ってきた量と返済額を
/// SimulationResult として返して取り消す(ガス見積もりの呼び出しで使う)。
/// botは1回の問い合わせで正確な利益が分かる。
///
/// [仕組み]
///   1. 最初のプールから、1段目の出力通貨を先に受け取る
///   2. コールバックの中で2段目以降を回して投入通貨(asset)に戻す
///   3. 利益が minProfit 以上なら最初のプールへ支払う。届かなければ取消
///
/// [コールバック]
/// V2のフォークはそれぞれ独自の名前で呼び返す(uniswapV2Call, pancakeCall等)。
/// 名前が分からないフォーク(ApeSwap等)も受け付けるよう、同じ形の呼び出しは
/// fallback で処理する。呼び出し元の確認は全て同じ条件で行う。
contract DexArbFlashLoan {
    address public owner;

    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    uint8 public constant KIND_V2 = 0;
    uint8 public constant KIND_V3 = 1;

    /// @dev 経路の1段。feeBps はV2の手数料(実測値)。V3では使わない。
    struct Leg {
        address pool;
        address tokenIn;
        address tokenOut;
        uint8 kind;
        uint16 feeBps;
    }

    struct Context {
        uint256 amountIn;
        uint256 assetBefore;
        uint256 firstOutBefore;
        uint256 minProfit;
    }

    error SimulationResult(uint256 returned, uint256 owed);

    address private activePool;
    address private activePayToken;
    bool private inFlashSwap;
    bool private simulating;

    event RouteExecuted(address indexed asset, uint256 amountIn, uint256 profit, uint8 legCount);
    event Withdrawn(address indexed token, uint256 amount);

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "DexArbFlashLoan: not owner");
        _;
    }

    /// @notice 経路を実行する。利益が minProfit に届かなければ取り消す。
    function executeRoute(address asset, uint256 amount, Leg[] calldata legs, uint256 minProfit) external onlyOwner {
        _start(asset, amount, legs, minProfit);
    }

    /// @notice 経路を最後まで実行し、結果を SimulationResult で返して取り消す。
    /// ガス見積もり(eth_call)で呼び、実際に送信はしない。
    function simulateRoute(address asset, uint256 amount, Leg[] calldata legs) external onlyOwner {
        simulating = true;
        _start(asset, amount, legs, 0);
        revert("DexArbFlashLoan: simulation did not finish");
    }

    function _start(address asset, uint256 amount, Leg[] calldata legs, uint256 minProfit) internal {
        require(legs.length >= 2 && legs.length <= 4, "DexArbFlashLoan: 2-4 legs");
        require(amount > 0, "DexArbFlashLoan: zero amount");
        require(legs[0].tokenIn == asset, "DexArbFlashLoan: first leg must start with asset");
        require(legs[legs.length - 1].tokenOut == asset, "DexArbFlashLoan: last leg must end with asset");
        for (uint256 i = 1; i < legs.length; i++) {
            require(legs[i].tokenIn == legs[i - 1].tokenOut, "DexArbFlashLoan: legs not connected");
        }
        require(!inFlashSwap, "DexArbFlashLoan: reentrant");

        Context memory ctx = Context({
            amountIn: amount,
            assetBefore: IERC20(asset).balanceOf(address(this)),
            firstOutBefore: IERC20(legs[0].tokenOut).balanceOf(address(this)),
            minProfit: minProfit
        });
        bytes memory data = abi.encode(legs, ctx);

        inFlashSwap = true;
        activePool = legs[0].pool;

        if (legs[0].kind == KIND_V2) {
            _borrowFromV2(legs[0], amount, data);
        } else if (legs[0].kind == KIND_V3) {
            _borrowFromV3(legs[0].pool, asset, amount, data);
        } else {
            revert("DexArbFlashLoan: unknown pool kind");
        }

        require(!inFlashSwap, "DexArbFlashLoan: callback not received");
        activePool = address(0);
        activePayToken = address(0);
    }

    /// @dev プールの準備量を、入力側・出力側の順で返す。
    function _reserves(address pool, address tokenIn) internal view returns (uint256 rIn, uint256 rOut, bool inIsToken0) {
        (uint112 r0, uint112 r1, ) = IAmmPoolV2(pool).getReserves();
        inIsToken0 = IAmmPoolV2(pool).token0() == tokenIn;
        rIn = inIsToken0 ? r0 : r1;
        rOut = inIsToken0 ? r1 : r0;
    }

    /// @dev V2の受取量。プール自身が計算できればそれを使い、無ければ計算式で求める。
    function _v2Quote(address pool, address tokenIn, uint256 amountIn, uint16 feeBps, uint256 rIn, uint256 rOut)
        internal view returns (uint256)
    {
        try IAmmQuoteV2(pool).getAmountOut(amountIn, tokenIn) returns (uint256 out) {
            if (out > 0) return out;
        } catch {}
        if (rIn == 0 || rOut == 0 || feeBps >= 10000) return 0;
        uint256 inWithFee = amountIn * (10000 - feeBps);
        return (inWithFee * rOut) / (rIn * 10000 + inWithFee);
    }

    /// @dev V2プールから、1段目の出力通貨を支払わずに先に受け取る。
    /// 受け取る量は、今の準備量から計算した「投入額に見合う量」。
    function _borrowFromV2(Leg calldata leg, uint256 amount, bytes memory data) internal {
        (uint256 rIn, uint256 rOut, bool inIsToken0) = _reserves(leg.pool, leg.tokenIn);
        uint256 out = _v2Quote(leg.pool, leg.tokenIn, amount, leg.feeBps, rIn, rOut);
        require(out > 0, "DexArbFlashLoan: zero output");
        IAmmPoolV2(leg.pool).swap(inIsToken0 ? 0 : out, inIsToken0 ? out : 0, address(this), data);
    }

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
    function _runRouteAndRepay(bytes memory data, uint256 v3Owed) internal {
        (Leg[] memory legs, Context memory ctx) = abi.decode(data, (Leg[], Context));
        inFlashSwap = false;

        uint256 running = IERC20(legs[0].tokenOut).balanceOf(address(this)) - ctx.firstOutBefore;
        require(running > 0, "DexArbFlashLoan: nothing received");

        for (uint256 i = 1; i < legs.length; i++) {
            running = _swapLeg(legs[i], running);
        }

        _repayAndReport(legs, ctx, v3Owed);
    }

    function _repayAndReport(Leg[] memory legs, Context memory ctx, uint256 v3Owed) internal {
        uint256 owed = legs[0].kind == KIND_V3 ? v3Owed : ctx.amountIn;
        address asset = legs[0].tokenIn;
        uint256 returned = IERC20(asset).balanceOf(address(this)) - ctx.assetBefore;
        if (simulating) revert SimulationResult(returned, owed);
        require(returned >= owed + ctx.minProfit, "DexArbFlashLoan: not profitable, reverting");
        _safeTransfer(asset, legs[0].pool, owed);
        emit RouteExecuted(asset, ctx.amountIn, returned - owed, uint8(legs.length));
    }

    /// @dev 1段をスワップし、実際に受け取った量を返す(残高の差分で測る)。
    function _swapLeg(Leg memory leg, uint256 amountIn) internal returns (uint256) {
        require(amountIn > 0, "DexArbFlashLoan: zero input");
        uint256 before = IERC20(leg.tokenOut).balanceOf(address(this));

        if (leg.kind == KIND_V2) {
            _swapV2(leg, amountIn);
        } else if (leg.kind == KIND_V3) {
            _swapV3(leg.pool, leg.tokenIn, amountIn);
        } else {
            revert("DexArbFlashLoan: unknown pool kind");
        }

        uint256 received = IERC20(leg.tokenOut).balanceOf(address(this)) - before;
        require(received > 0, "DexArbFlashLoan: insufficient output");
        return received;
    }

    /// @dev V2のスワップ。送った後にプールへ実際に届いた量で受取量を計算する
    /// (送金時に税を取るトークンでも失敗しない)。
    function _swapV2(Leg memory leg, uint256 amountIn) internal {
        (uint256 rIn, uint256 rOut, bool inIsToken0) = _reserves(leg.pool, leg.tokenIn);
        _safeTransfer(leg.tokenIn, leg.pool, amountIn);
        uint256 out = _v2Quote(leg.pool, leg.tokenIn, _arrived(leg.tokenIn, leg.pool, rIn, amountIn), leg.feeBps, rIn, rOut);
        require(out > 0, "DexArbFlashLoan: zero output");
        IAmmPoolV2(leg.pool).swap(inIsToken0 ? 0 : out, inIsToken0 ? out : 0, address(this), new bytes(0));
    }

    /// @dev プールに実際に届いた量(送った量を上限とする)。
    function _arrived(address token, address pool, uint256 reserveIn, uint256 sent) internal view returns (uint256) {
        uint256 balance = IERC20(token).balanceOf(pool);
        uint256 arrived = balance > reserveIn ? balance - reserveIn : 0;
        if (arrived > sent) arrived = sent;
        require(arrived > 0, "DexArbFlashLoan: nothing arrived");
        return arrived;
    }

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
    /// 失敗した場合はトークン側の拒否理由をそのまま返す。
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

    function _onV2Callback(address sender, bytes memory data) internal {
        if (data.length == 0) return;
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

    /// @dev 名前の分からないV2フォークのコールバック(ApeSwap等)。
    /// 形が (address, uint256, uint256, bytes) の呼び出しを同じ条件で処理する。
    fallback() external {
        require(msg.data.length >= 4 + 32 * 4, "DexArbFlashLoan: unknown call");
        (address sender, , , bytes memory data) = abi.decode(msg.data[4:], (address, uint256, uint256, bytes));
        _onV2Callback(sender, data);
    }

    // ===== V3形式のコールバック =====

    function _onV3Callback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) internal {
        require(msg.sender == activePool, "DexArbFlashLoan: unexpected callback");
        int256 owedSigned = amount0Delta > 0 ? amount0Delta : amount1Delta;
        require(owedSigned > 0, "DexArbFlashLoan: nothing owed");
        uint256 owed = uint256(owedSigned);

        if (data.length == 0) {
            _safeTransfer(activePayToken, msg.sender, owed);
            return;
        }
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
