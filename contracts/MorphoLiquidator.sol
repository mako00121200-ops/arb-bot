// SPDX-License-Identifier: MIT
// 一時記憶(transient)を使うため 0.8.28 以上。evmVersion は cancun でコンパイルする
// (scripts/compile-contract.js で明示している)。
pragma solidity ^0.8.28;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// Morpho Blue の市場の指定(morpho-blue src/interfaces/IMorpho.sol と同じ並び)。
struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

interface IMorpho {
    function liquidate(
        MarketParams memory marketParams,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes memory data
    ) external returns (uint256, uint256);
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

// Uniswap V3形式(集中流動性)。Aerodrome Slipstream 等のフォークも同じ形。
interface IAmmPoolV3 {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// @title MorphoLiquidator
/// @notice Morpho Blue の清算を、**元手ゼロ・借入手数料ゼロ**で行うコントラクト。
///
/// [流れ(morpho-blue src/Morpho.sol の liquidate の順番どおり)]
///   1. Morpho.liquidate を呼ぶ。Morpho は**先に担保をこちらへ送り**、
///   2. onMorphoLiquidate(repaidAssets, data) を呼び返す。ここで担保を DEX の段(legs)で借金の通貨に売る
///   3. 呼び返しの後、Morpho が repaidAssets を transferFrom で回収する
///   売って戻った量 − repaidAssets が利益。minProfit に届かなければ取り消す。
///   Aave と違ってフラッシュローンが要らないので、手数料(0.05%)も掛からない。
///
/// [裁定・Aave 清算のコントラクトと同じ作法]
///   ・受取量は**残高の差**で測る(Morpho や DEX の戻り値を信じない)
///   ・承認は 0 → 必要量で、回収で使い切って残らない
///   ・simulateLiquidation は最後まで回して SimulationResult で結果を返して取り消す(eth_call 専用)
///   ・Leg の形(pool / tokenOut / flags / feeBps)と V3 のコールバックは裁定側と同じ
///
/// [量の指定]
/// Morpho は seizedAssets(受け取る担保)か repaidShares(返す借金の持分)の**どちらか一方だけ**を取る。
/// 担保が足りる時は repaidShares = 借金の持分の全部(利息が増えても持分は変わらないので外れない)。
/// 担保が足りない時(貸し倒れ域)は seizedAssets = 担保の全部。どちらにするかは bot が決める。
contract MorphoLiquidator {
    address public immutable owner;
    IMorpho public immutable MORPHO;

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

    /// @dev 清算の指定。seizedAssets と repaidShares は**どちらか一方だけ** 0 でない値にする。
    struct Liq {
        address borrower;      // 清算される人
        uint256 seizedAssets;  // 受け取る担保の量(貸し倒れ域で使う)
        uint256 repaidShares;  // 返す借金の持分(通常はこちら)
        uint256 minProfit;     // これ未満なら取り消す(借金の通貨の単位)
    }

    /// @dev 呼び返しへ渡す控え(変数が多すぎてスタックに載らないので1つにまとめる)。
    struct Ctx {
        address loanToken;
        address collateralToken;
        address borrower;
        uint256 minProfit;
        uint256 loanBefore;
        uint256 collBefore;
    }

    error SimulationResult(uint256 returned, uint256 owed);

    // 取引の間だけ要る印。一時記憶なので取引の終わりに勝手に消える。
    address private transient activePool;
    address private transient activePayToken;
    bool private transient inLiquidation;
    bool private transient simulating;

    event Liquidated(address indexed borrower, address indexed loanToken, address indexed collateralToken, uint256 repaid, uint256 seized, uint256 profit);
    event Withdrawn(address indexed token, uint256 amount);

    constructor(address morpho) {
        require(morpho != address(0), "MorphoLiquidator: morpho required");
        owner = msg.sender;
        MORPHO = IMorpho(morpho);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "MorphoLiquidator: not owner");
        _;
    }

    /// @notice 清算する。利益が minProfit に届かなければ取り消す。
    function liquidate(MarketParams calldata mp, Liq calldata liq, Leg[] calldata legs) external onlyOwner {
        _start(mp, liq, legs);
    }

    /// @notice 清算を最後まで回し、結果を SimulationResult(returned, owed) で返して取り消す。
    /// eth_call で呼ぶ。返済後に残る利益は returned - owed。**送る前に必ずこれで確かめる。**
    function simulateLiquidation(MarketParams calldata mp, Liq calldata liq, Leg[] calldata legs) external onlyOwner {
        simulating = true;
        _start(mp, liq, legs);
        revert("MorphoLiquidator: simulation did not finish");
    }

    function _start(MarketParams calldata mp, Liq calldata liq, Leg[] calldata legs) internal {
        require(liq.borrower != address(0), "MorphoLiquidator: borrower required");
        require((liq.seizedAssets == 0) != (liq.repaidShares == 0), "MorphoLiquidator: exactly one amount");
        // 借金と担保が同じだと、受け取った担保の量を残高の差で測れない。扱わない。
        require(mp.loanToken != mp.collateralToken, "MorphoLiquidator: collateral must differ from loan");
        require(legs.length >= 1 && legs.length <= 3, "MorphoLiquidator: 1-3 legs");
        require(legs[legs.length - 1].tokenOut == mp.loanToken, "MorphoLiquidator: last leg must end with loan token");
        require(!inLiquidation, "MorphoLiquidator: reentrant");

        // 清算前の残高。返済の計算はこの差で行う(過去の利益が残っていても誤らない)。
        Ctx memory ctx = Ctx({
            loanToken: mp.loanToken,
            collateralToken: mp.collateralToken,
            borrower: liq.borrower,
            minProfit: liq.minProfit,
            loanBefore: IERC20(mp.loanToken).balanceOf(address(this)),
            collBefore: IERC20(mp.collateralToken).balanceOf(address(this))
        });
        inLiquidation = true;
        MORPHO.liquidate(mp, liq.borrower, liq.seizedAssets, liq.repaidShares, abi.encode(ctx, legs));
        require(!inLiquidation, "MorphoLiquidator: callback not received");
        activePool = address(0);
        activePayToken = address(0);
    }

    /// @notice Morpho が担保を送った後に呼び返す。この後 Morpho が repaidAssets を回収する。
    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata data) external {
        require(msg.sender == address(MORPHO), "MorphoLiquidator: unexpected callback");
        require(inLiquidation, "MorphoLiquidator: not liquidating");
        inLiquidation = false;
        (Ctx memory ctx, Leg[] memory legs) = abi.decode(data, (Ctx, Leg[]));

        // 1. 受け取った担保は残高の差で測る。
        uint256 seized = IERC20(ctx.collateralToken).balanceOf(address(this)) - ctx.collBefore;
        require(seized > 0, "MorphoLiquidator: nothing seized");

        // 2. 担保を売って借金の通貨に戻す。
        uint256 running = seized;
        address tokenIn = ctx.collateralToken;
        for (uint256 i = 0; i < legs.length; i++) {
            running = _swapLeg(legs[i], tokenIn, running);
            tokenIn = legs[i].tokenOut;
        }

        // 3. 返済と利益の判定。戻ってきた量は残高の差。
        uint256 returned = IERC20(ctx.loanToken).balanceOf(address(this)) - ctx.loanBefore;
        if (simulating) revert SimulationResult(returned, repaidAssets);
        require(returned >= repaidAssets + ctx.minProfit, "MorphoLiquidator: not profitable, reverting");
        // Morpho が transferFrom で回収する。ちょうどの額だけ承認する(回収で 0 に戻る)。
        _safeApprove(ctx.loanToken, address(MORPHO), 0);
        _safeApprove(ctx.loanToken, address(MORPHO), repaidAssets);
        emit Liquidated(ctx.borrower, ctx.loanToken, ctx.collateralToken, repaidAssets, seized, returned - repaidAssets);
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
        require(amountIn > 0, "MorphoLiquidator: zero input");
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
            require(out > 0, "MorphoLiquidator: zero output");
            IAmmPoolV2(leg.pool).swap(inIsToken0 ? 0 : out, inIsToken0 ? out : 0, address(this), new bytes(0));
            received = IERC20(leg.tokenOut).balanceOf(address(this)) - before;
        }
        require(received > 0, "MorphoLiquidator: insufficient output");
    }

    /// @dev プールに実際に届いた量(送った量を上限とする)。
    function _arrived(address token, address pool, uint256 reserveIn, uint256 sent) internal view returns (uint256) {
        uint256 balance = IERC20(token).balanceOf(pool);
        uint256 arrived = balance > reserveIn ? balance - reserveIn : 0;
        if (arrived > sent) arrived = sent;
        require(arrived > 0, "MorphoLiquidator: nothing arrived");
        return arrived;
    }

    /// @dev 戻り値の無い通貨(USDT等)にも対応した承認。
    function _safeApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "MorphoLiquidator: approve failed");
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
            revert("MorphoLiquidator: transfer failed");
        }
        require(ret.length == 0 || abi.decode(ret, (bool)), "MorphoLiquidator: transfer failed");
    }

    // ===== V3形式のコールバック(支払うだけ)=====
    // V2 の段は data 無しで swap するのでコールバックは来ない。V3 の段だけ、
    // 今スワップ中のプールから請求された量を支払う。

    function _onV3Callback(int256 amount0Delta, int256 amount1Delta) internal {
        require(msg.sender == activePool && activePool != address(0), "MorphoLiquidator: unexpected callback");
        int256 owedSigned = amount0Delta > 0 ? amount0Delta : amount1Delta;
        require(owedSigned > 0, "MorphoLiquidator: nothing owed");
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
        require(msg.data.length >= 4 + 32 * 3, "MorphoLiquidator: unknown call");
        (int256 a0, int256 a1) = abi.decode(msg.data[4:], (int256, int256));
        _onV3Callback(a0, a1);
    }

    // ===== 残高確認と引き出し =====

    function balanceOfToken(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function withdraw(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "MorphoLiquidator: nothing to withdraw");
        _safeTransfer(token, owner, balance);
        emit Withdrawn(token, balance);
    }
}
