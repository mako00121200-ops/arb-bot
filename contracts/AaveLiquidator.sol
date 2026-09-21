// SPDX-License-Identifier: MIT
// 一時記憶(transient)を使うため 0.8.28 以上。evmVersion は cancun 以上で
// コンパイルする(scripts/compile-contract.js で明示している)。
pragma solidity ^0.8.28;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

// Aave V3 の Pool。
interface IAavePool {
    function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external;
    function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external;
}

// Uniswap V2形式(Solidly形式も同じ)。
interface IAmmPoolV2 {
    function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external;
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

// Solidly系・Camelot等は、プール自身が受取量を計算する関数を持つ。
interface IAmmQuoteV2 {
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
}

// Uniswap V3形式(集中流動性)。Pharaoh 等のフォークも同じ形。
interface IAmmPoolV3 {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// @title AaveLiquidator
/// @notice Aave V3 の清算を、元手ゼロ(flashLoanSimple)で行うコントラクト。
///
/// [流れ]
///   1. Aave から借金の通貨を flashLoanSimple で借りる
///   2. executeOperation の中で liquidationCall(担保をボーナスぶん多く受け取る)
///   3. 受け取った担保を DEX の段(legs)で借金の通貨に売る
///   4. 借りた額 + 手数料(0.05%)を Aave に返し、残りが利益。minProfit に届かなければ取り消す
///
/// [裁定のコントラクト(DexArbFlashLoan)と同じ作法]
///   ・受取量は**残高の差**で測る(Aave や DEX の戻り値を信じない)
///   ・承認は 0 → 必要量 → 0 で、残さない
///   ・simulateLiquidation は最後まで回して SimulationResult で結果を返して取り消す(eth_call 専用)
///   ・Leg の形(pool / tokenOut / flags / feeBps)と V3 のコールバックは裁定側と同じ
///
/// [Aave が全額を使わないことがある]
/// 一度に返せる上限(HF≥0.95 なら借金の50%)で頭打ちにされると、借りた通貨が余る。
/// 余りは借金の通貨のまま残高にあるので、返済の計算(残高の差)に自然に含まれる。損はしない。
/// ただし余った分の手数料(0.05%)は無駄になるので、bot 側で「上限ぴったり」に計算して渡す。
contract AaveLiquidator {
    address public immutable owner;
    IAavePool public immutable POOL;

    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    // Leg.flags のビット(裁定のコントラクトと同じ)。
    uint8 public constant FLAG_V3 = 1;           // V3形式(集中流動性)。無ければV2形式
    uint8 public constant FLAG_IN_IS_TOKEN0 = 2; // 投入通貨がそのプールの token0
    uint8 public constant FLAG_HAS_QUOTE = 4;    // プールが getAmountOut を持つ(Solidly系・Camelot等)

    /// @dev 担保を売る経路の1段。投入通貨は前の段の出力通貨(1段目は担保)。
    struct Leg {
        address pool;
        address tokenOut;
        uint8 flags;
        uint16 feeBps;
    }

    /// @dev 清算の指定。
    struct Liq {
        address collateralAsset; // 受け取る担保
        address debtAsset;       // 肩代わりする借金(= flashLoanSimple で借りる通貨 = legs の最終出力)
        address user;            // 清算される人
        uint256 debtToCover;     // 肩代わりする量(= 借りる量)
        uint256 minProfit;       // これ未満なら取り消す(借金の通貨の単位)
    }

    error SimulationResult(uint256 returned, uint256 owed);

    // 取引の間だけ要る印。一時記憶なので取引の終わりに勝手に消える。
    address private transient activePool;
    address private transient activePayToken;
    bool private transient inFlashLoan;
    bool private transient simulating;

    event Liquidated(address indexed user, address indexed debtAsset, address indexed collateralAsset, uint256 debtCovered, uint256 seized, uint256 profit);
    event Withdrawn(address indexed token, uint256 amount);

    constructor(address pool) {
        require(pool != address(0), "AaveLiquidator: pool required");
        owner = msg.sender;
        POOL = IAavePool(pool);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "AaveLiquidator: not owner");
        _;
    }

    /// @notice 清算する。利益が minProfit に届かなければ取り消す。
    function liquidate(Liq calldata liq, Leg[] calldata legs) external onlyOwner {
        _start(liq, legs);
    }

    /// @notice 清算を最後まで回し、結果を SimulationResult(returned, owed) で返して取り消す。
    /// eth_call で呼ぶ。返済後に残る利益は returned - owed。**送る前に必ずこれで確かめる。**
    function simulateLiquidation(Liq calldata liq, Leg[] calldata legs) external onlyOwner {
        simulating = true;
        _start(liq, legs);
        revert("AaveLiquidator: simulation did not finish");
    }

    function _start(Liq calldata liq, Leg[] calldata legs) internal {
        require(liq.debtToCover > 0, "AaveLiquidator: zero debt to cover");
        require(liq.user != address(0), "AaveLiquidator: user required");
        require(liq.collateralAsset != address(0) && liq.debtAsset != address(0), "AaveLiquidator: assets required");
        // 借金と担保が同じだと、受け取った担保の量を残高の差で測れない。扱わない。
        require(liq.collateralAsset != liq.debtAsset, "AaveLiquidator: collateral must differ from debt");
        require(legs.length >= 1 && legs.length <= 3, "AaveLiquidator: 1-3 legs");
        require(legs[legs.length - 1].tokenOut == liq.debtAsset, "AaveLiquidator: last leg must end with debt asset");
        require(!inFlashLoan, "AaveLiquidator: reentrant");

        // 借りる前の残高。返済の計算はこの差で行う(過去の利益が残っていても誤らない)。
        uint256 debtBefore = IERC20(liq.debtAsset).balanceOf(address(this));
        inFlashLoan = true;
        POOL.flashLoanSimple(address(this), liq.debtAsset, liq.debtToCover, abi.encode(liq, legs, debtBefore), 0);
        require(!inFlashLoan, "AaveLiquidator: callback not received");
        activePool = address(0);
        activePayToken = address(0);
    }

    /// @notice Aave が借入金を渡した後に呼び返す。
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(POOL), "AaveLiquidator: unexpected callback");
        require(initiator == address(this) && inFlashLoan, "AaveLiquidator: unexpected initiator");
        inFlashLoan = false;
        (Liq memory liq, Leg[] memory legs, uint256 debtBefore) = abi.decode(params, (Liq, Leg[], uint256));
        require(asset == liq.debtAsset, "AaveLiquidator: asset mismatch");

        // 1. 清算。受け取った担保は残高の差で測る。
        uint256 collBefore = IERC20(liq.collateralAsset).balanceOf(address(this));
        _safeApprove(liq.debtAsset, address(POOL), 0);
        _safeApprove(liq.debtAsset, address(POOL), amount);
        POOL.liquidationCall(liq.collateralAsset, liq.debtAsset, liq.user, amount, false);
        _safeApprove(liq.debtAsset, address(POOL), 0);
        uint256 seized = IERC20(liq.collateralAsset).balanceOf(address(this)) - collBefore;
        require(seized > 0, "AaveLiquidator: nothing seized");
        // 実際に使われた額(= 借りる前の残高 + 借りた額 − 今の残高)。渡した額を信じない。
        uint256 debtUsed = debtBefore + amount - IERC20(liq.debtAsset).balanceOf(address(this));

        // 2. 担保を売って借金の通貨に戻す。
        uint256 running = seized;
        address tokenIn = liq.collateralAsset;
        for (uint256 i = 0; i < legs.length; i++) {
            running = _swapLeg(legs[i], tokenIn, running);
            tokenIn = legs[i].tokenOut;
        }

        // 3. 返済と利益の判定。戻ってきた量は残高の差(余った借入金も含まれる)。
        uint256 owed = amount + premium;
        uint256 returned = IERC20(liq.debtAsset).balanceOf(address(this)) - debtBefore;
        if (simulating) revert SimulationResult(returned, owed);
        require(returned >= owed + liq.minProfit, "AaveLiquidator: not profitable, reverting");
        // Aave が transferFrom で回収する。ちょうどの額だけ承認する(回収後は 0 に戻る)。
        _safeApprove(liq.debtAsset, address(POOL), 0);
        _safeApprove(liq.debtAsset, address(POOL), owed);
        emit Liquidated(liq.user, liq.debtAsset, liq.collateralAsset, debtUsed, seized, returned - owed);
        return true;
    }

    /// @dev プールの準備量を、入力側・出力側の順で返す。
    function _reserves(address pool, bool inIsToken0) internal view returns (uint256 rIn, uint256 rOut) {
        (uint112 r0, uint112 r1, ) = IAmmPoolV2(pool).getReserves();
        rIn = inIsToken0 ? r0 : r1;
        rOut = inIsToken0 ? r1 : r0;
    }

    /// @dev V2の受取量。プール自身が計算できる(flags で指定)ならそれを使い、無ければ計算式で求める。
    function _v2Quote(Leg memory leg, address tokenIn, uint256 amountIn, uint256 rIn, uint256 rOut)
        internal view returns (uint256)
    {
        if (leg.flags & FLAG_HAS_QUOTE != 0) {
            try IAmmQuoteV2(leg.pool).getAmountOut(amountIn, tokenIn) returns (uint256 out) {
                if (out > 0) return out;
            } catch {}
        }
        if (rIn == 0 || rOut == 0 || leg.feeBps >= 10000) return 0;
        uint256 inWithFee = amountIn * (10000 - leg.feeBps);
        return (inWithFee * rOut) / (rIn * 10000 + inWithFee);
    }

    /// @dev 1段をスワップし、受け取った量を返す。V3はプールが返す量、V2は残高の差分。
    function _swapLeg(Leg memory leg, address tokenIn, uint256 amountIn) internal returns (uint256 received) {
        require(amountIn > 0, "AaveLiquidator: zero input");
        bool inIsToken0 = leg.flags & FLAG_IN_IS_TOKEN0 != 0;
        if (leg.flags & FLAG_V3 != 0) {
            activePool = leg.pool;
            activePayToken = tokenIn;
            (int256 a0, int256 a1) = IAmmPoolV3(leg.pool).swap(
                address(this),
                inIsToken0,
                int256(amountIn),
                inIsToken0 ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
                new bytes(0)
            );
            activePool = address(0);
            activePayToken = address(0);
            int256 r = inIsToken0 ? -a1 : -a0;
            received = r > 0 ? uint256(r) : 0;
        } else {
            // V2は送った後にプールへ実際に届いた量で受取量を計算する(税を取るトークンでも失敗しない)。
            uint256 before = IERC20(leg.tokenOut).balanceOf(address(this));
            (uint256 rIn, uint256 rOut) = _reserves(leg.pool, inIsToken0);
            _safeTransfer(tokenIn, leg.pool, amountIn);
            uint256 out = _v2Quote(leg, tokenIn, _arrived(tokenIn, leg.pool, rIn, amountIn), rIn, rOut);
            require(out > 0, "AaveLiquidator: zero output");
            IAmmPoolV2(leg.pool).swap(inIsToken0 ? 0 : out, inIsToken0 ? out : 0, address(this), new bytes(0));
            received = IERC20(leg.tokenOut).balanceOf(address(this)) - before;
        }
        require(received > 0, "AaveLiquidator: insufficient output");
    }

    /// @dev プールに実際に届いた量(送った量を上限とする)。
    function _arrived(address token, address pool, uint256 reserveIn, uint256 sent) internal view returns (uint256) {
        uint256 balance = IERC20(token).balanceOf(pool);
        uint256 arrived = balance > reserveIn ? balance - reserveIn : 0;
        if (arrived > sent) arrived = sent;
        require(arrived > 0, "AaveLiquidator: nothing arrived");
        return arrived;
    }

    /// @dev 戻り値の無い通貨(USDT等)にも対応した承認。
    function _safeApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "AaveLiquidator: approve failed");
    }

    /// @dev 戻り値の無いトークン(USDT等)にも対応した送金。失敗した場合はトークン側の拒否理由をそのまま返す。
    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            revert("AaveLiquidator: transfer failed");
        }
        require(ret.length == 0 || abi.decode(ret, (bool)), "AaveLiquidator: transfer failed");
    }

    // ===== V3形式のコールバック(支払うだけ)=====
    // V2 の段は data 無しで swap するのでコールバックは来ない。V3 の段だけ、
    // 今スワップ中のプールから請求された量を支払う。

    function _onV3Callback(int256 amount0Delta, int256 amount1Delta) internal {
        require(msg.sender == activePool && activePool != address(0), "AaveLiquidator: unexpected callback");
        int256 owedSigned = amount0Delta > 0 ? amount0Delta : amount1Delta;
        require(owedSigned > 0, "AaveLiquidator: nothing owed");
        _safeTransfer(activePayToken, msg.sender, uint256(owedSigned));
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        _onV3Callback(a0, a1);
    }
    function pancakeV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        _onV3Callback(a0, a1);
    }
    function algebraSwapCallback(int256 a0, int256 a1, bytes calldata) external {
        _onV3Callback(a0, a1);
    }
    /// @dev Ramses 系(Pharaoh の元)の名前。
    function ramsesV2SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        _onV3Callback(a0, a1);
    }

    /// @dev 名前の分からないフォークのコールバック。V3形式 (int256, int256, bytes) として解釈する。
    /// スワップ中でなければ activePool は 0 なので、誰が呼んでも通らない。
    fallback() external {
        require(msg.data.length >= 4 + 32 * 3, "AaveLiquidator: unknown call");
        (int256 a0, int256 a1) = abi.decode(msg.data[4:], (int256, int256));
        _onV3Callback(a0, a1);
    }

    // ===== 残高確認と引き出し =====

    function balanceOfToken(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function withdraw(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "AaveLiquidator: nothing to withdraw");
        _safeTransfer(token, owner, balance);
        emit Withdrawn(token, balance);
    }
}
