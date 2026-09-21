// SPDX-License-Identifier: MIT
// 一時記憶(transient)を使うため 0.8.28 以上。evmVersion は cancun 以上で
// コンパイルする(scripts/compile-contract.js で明示している)。
pragma solidity ^0.8.28;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

// Aave V3 の Pool。フォーク(Seamless 等)も同じ形。
//
// [なぜ清算を足すのか(2026年9月21日)]
// 裁定の利益は「価格の差」で、誰でも取れるので競争で差そのものが消える。
// 実測でも深いプールは0bps、浅いプールは$1〜30しか吸えなかった。
// 清算の利益は**プロトコルが決めた固定のボーナス(5〜10%)**で、
// **競争しても額が変わらない**。競争は「誰が取るか」の競走になるだけ。
// base の実測では2日で $1,000超の清算が4回、清算した人は6人・上位1者22%
// (独占されていない)。1回の粗利 $25〜50。
interface IAavePool {
    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;
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

// Uniswap V3形式(集中流動性)。Ramses/Pharaoh 等のフォークも同じ形。
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
/// [ガス削減版(2026年9月20日)]
/// 2段の実測は272,246ガスで、1件の粗利($0.01〜0.04)とガス代($0.015)が
/// 同程度だった。実測で分かった無駄を削っている。
///   1. 取引中の印(activePool 等)を永続記憶から一時記憶(EIP-1153)へ。
///      永続記憶では 0→値→0 の書き戻しに約65,000ガスかかり、払い戻しは
///      取引全体の2割まで(EIP-3529)なので一部が消えていた。一時記憶は
///      1回100ガスで、取引の終わりに勝手に消える
///   2. token0() を鎖上で問い直さない。bot は地図で知っているので flags で渡す
///   3. getAmountOut の試し呼びをやめる。持つプール(Solidly系)だけ flags で指定
///   4. V3の段は残高で測らず、プールが返す量(delta)をそのまま使う
///   5. owner を immutable に
///   6. Leg から tokenIn を外す(前の段の tokenOut と同じ)。呼び出しデータも減る
/// 資金の安全に関わる読み取りは残している: 最終段の資産残高の差分(税トークンで
/// 自分の残高から返済してしまう事故を防ぐ)、V2の段の到着量確認。
///
/// [受取量はチェーン上で計算する(2026年9月17日)]
/// 各段の受取量を「実行するその瞬間の準備量」から計算する。
///   V2 … プールが getAmountOut を持っていればそれを使い(Solidly系・Camelot等)、
///        無ければ準備量と手数料(botが実測値を渡す)から計算する
///   V3 … 投入額ちょうどをスワップする(プールが正確に計算する)
/// 送金時に税を取るトークンは、プールに実際に届いた量で計算するので、
/// 失敗ではなく「利益が減る」だけになる。
///
/// [結果の問い合わせ]
/// simulateRoute は経路を最後まで実行し、戻ってきた量と返済額を
/// SimulationResult として返して取り消す(eth_call で使う)。
///
/// [仕組み]
///   1. 最初のプールから、1段目の出力通貨を先に受け取る
///   2. コールバックの中で2段目以降を回して投入通貨(asset)に戻す
///   3. 利益が minProfit 以上なら最初のプールへ支払う。届かなければ取消
///
/// [コールバック]
/// フォークはそれぞれ独自の名前で呼び返す(uniswapV2Call, pancakeCall,
/// ramsesV2SwapCallback 等)。名前が分からないフォーク(Pharaoh 等)も受け付ける
/// よう、fallback は「今スワップ中のプールの形式」で呼び出しを解釈する。
/// 呼び出し元の確認は全て同じ条件で行う。
contract DexArbFlashLoan {
    address public immutable owner;

    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    // Leg.flags のビット。bot が地図から分かっている事をそのまま渡す。
    uint8 public constant FLAG_V3 = 1;           // V3形式(集中流動性)。無ければV2形式
    uint8 public constant FLAG_IN_IS_TOKEN0 = 2; // 投入通貨がそのプールの token0
    uint8 public constant FLAG_HAS_QUOTE = 4;    // プールが getAmountOut を持つ(Solidly系・Camelot等)

    /// @dev 経路の1段。投入通貨は「前の段の出力通貨」(1段目は asset)なので持たない。
    /// feeBps はV2の手数料(実測値)。V3では使わない。
    struct Leg {
        address pool;
        address tokenOut;
        uint8 flags;
        uint16 feeBps;
    }

    struct Context {
        uint256 amountIn;
        uint256 assetBefore;
        uint256 firstOutBefore;
        uint256 minProfit;
    }

    /// @dev 清算の1手ぶんの指定。
    /// debtToCover は**持たない**。1段目のフラッシュスワップで受け取った量を
    /// そのまま肩代わりする。額を2箇所で管理すると必ずずれる。
    struct Liq {
        address pool;            // Aave V3 の Pool(またはフォーク)
        address collateralAsset; // 受け取る担保
        address debtAsset;       // 肩代わりする借金(= legs[0].tokenOut)
        address user;            // 清算される人
    }

    error SimulationResult(uint256 returned, uint256 owed);
    /// @dev quoteV3 の結果。QuoterV2 と同じで、わざと失敗させて値を返す。
    error QuoteResult(uint256 amountOut);

    // 取引の間だけ要る印。一時記憶なので取引の終わりに勝手に消える。
    address private transient activePool;
    address private transient activePayToken;
    bool private transient activeIsV3;
    bool private transient inFlashSwap;
    bool private transient simulating;
    bool private transient quoting;

    // 清算の指定。一時記憶なので取引の終わりに勝手に消える。
    // (構造体は transient に置けないので、住所4つに分けて持つ)
    address private transient liqPool;
    address private transient liqCollateral;
    address private transient liqDebt;
    address private transient liqUser;

    event RouteExecuted(address indexed asset, uint256 amountIn, uint256 profit, uint8 legCount);
    event Liquidated(address indexed user, address indexed debtAsset, address indexed collateralAsset, uint256 debtCovered, uint256 seized);
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
    /// eth_call で呼び、実際に送信はしない。
    function simulateRoute(address asset, uint256 amount, Leg[] calldata legs) external onlyOwner {
        simulating = true;
        _start(asset, amount, legs, 0);
        revert("DexArbFlashLoan: simulation did not finish");
    }

    /// @notice 清算して、受け取った担保を売り、フラッシュスワップを返す。
    ///
    /// 流れは executeRoute とほぼ同じで、**1段目と2段目の間に清算が1手入るだけ**。
    ///   legs[0] で debtAsset を借りる(フラッシュスワップ)
    ///     → その全額で liquidationCall(担保をボーナスぶん多く受け取る)
    ///     → legs[1..] で担保を売って asset に戻す
    ///     → 返済と利益の判定は既存のまま
    ///
    /// @param liq 清算の指定。`liq.debtAsset` は `legs[0].tokenOut` と一致すること。
    function liquidateRoute(
        address asset,
        uint256 amount,
        Leg[] calldata legs,
        uint256 minProfit,
        Liq calldata liq
    ) external onlyOwner {
        _setLiq(liq, legs);
        _start(asset, amount, legs, minProfit);
    }

    /// @notice 清算つきの経路を最後まで実行し、結果を SimulationResult で返して取り消す。
    /// eth_call で呼び、実際に送信はしない。**送る前に必ずこれで確かめる。**
    function simulateLiquidate(
        address asset,
        uint256 amount,
        Leg[] calldata legs,
        Liq calldata liq
    ) external onlyOwner {
        simulating = true;
        _setLiq(liq, legs);
        _start(asset, amount, legs, 0);
        revert("DexArbFlashLoan: simulation did not finish");
    }

    /// @dev 清算の指定を確かめて一時記憶に置く。
    ///
    /// [なぜ Pool の住所を引数で受け取るのか]
    /// 埋め込むとチェーンを増やすたびに再デプロイが要る。呼べるのは
    /// `onlyOwner`、つまり bot のウォレットだけなので、住所は bot 側で管理し、
    /// **起動時に実測で確かめる**方が安全で柔軟。
    function _setLiq(Liq calldata liq, Leg[] calldata legs) internal {
        require(liq.pool != address(0), "DexArbFlashLoan: liq pool required");
        require(liq.user != address(0), "DexArbFlashLoan: liq user required");
        require(liq.collateralAsset != address(0) && liq.debtAsset != address(0), "DexArbFlashLoan: liq assets required");
        // 借金と担保が同じだと、受け取った担保の量を残高の差で測れなくなる
        // (出ていく借金と入ってくる担保が相殺される)。測れないものは扱わない。
        require(liq.collateralAsset != liq.debtAsset, "DexArbFlashLoan: collateral must differ from debt");
        // 1段目が運んでくる通貨で肩代わりする。食い違えば何も清算できない。
        require(legs[0].tokenOut == liq.debtAsset, "DexArbFlashLoan: first leg must deliver debtAsset");
        // 担保を売る段が最低1つ要る(_start でも 2〜4段を確かめている)。
        require(legs.length >= 2, "DexArbFlashLoan: need a leg to sell collateral");

        liqPool = liq.pool;
        liqCollateral = liq.collateralAsset;
        liqDebt = liq.debtAsset;
        liqUser = liq.user;
    }

    /// @notice プールを指定して受取量を求める。eth_call 専用で、送信はしない。
    ///
    /// [なぜ要るか(2026年9月17日)]
    /// Uniswap公式の QuoterV2 は引数にプールのアドレスが無く、中に固定された
    /// ファクトリーからアドレスを計算するため、フォークのプールには届かない。
    /// プールのアドレスを直接受け取れば、ファクトリーを問わず見積もれる。
    /// コールバックは実行と同じものを使うので、対応済みの形式はそのまま扱える。
    ///
    /// onlyOwner は付けない。eth_call で値を読むだけで資産は動かない。
    /// 引数の形は旧版と同じ(bot の quoteV3ByPoolBatch がそのまま使える)。
    function quoteV3(address pool, address tokenIn, uint256 amountIn) external {
        require(amountIn > 0, "DexArbFlashLoan: zero amount");
        require(!inFlashSwap, "DexArbFlashLoan: reentrant");
        quoting = true;
        activePool = pool;
        activePayToken = tokenIn;
        activeIsV3 = true;
        bool zeroForOne = IAmmPoolV3(pool).token0() == tokenIn;
        IAmmPoolV3(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            new bytes(0)
        );
        // ここに来るのはプールが何も返さなかった時だけ。
        revert("DexArbFlashLoan: quote did not finish");
    }

    function _start(address asset, uint256 amount, Leg[] calldata legs, uint256 minProfit) internal {
        require(legs.length >= 2 && legs.length <= 4, "DexArbFlashLoan: 2-4 legs");
        require(amount > 0, "DexArbFlashLoan: zero amount");
        require(legs[legs.length - 1].tokenOut == asset, "DexArbFlashLoan: last leg must end with asset");
        require(!inFlashSwap, "DexArbFlashLoan: reentrant");

        Leg calldata first = legs[0];
        bool firstV3 = first.flags & FLAG_V3 != 0;
        Context memory ctx = Context({
            amountIn: amount,
            assetBefore: IERC20(asset).balanceOf(address(this)),
            // V3は受取量をプールが正確に返すので、残高で測るのはV2の時だけ。
            firstOutBefore: firstV3 ? 0 : IERC20(first.tokenOut).balanceOf(address(this)),
            minProfit: minProfit
        });
        bytes memory data = abi.encode(asset, legs, ctx);

        inFlashSwap = true;
        activePool = first.pool;
        activeIsV3 = firstV3;

        if (firstV3) {
            activePayToken = asset;
            _callV3Swap(first.pool, first.flags & FLAG_IN_IS_TOKEN0 != 0, amount, data);
        } else {
            _borrowFromV2(first, asset, amount, data);
        }

        require(!inFlashSwap, "DexArbFlashLoan: callback not received");
        activePool = address(0);
        activePayToken = address(0);
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

    /// @dev V2プールから、1段目の出力通貨を支払わずに先に受け取る。
    /// 受け取る量は、今の準備量から計算した「投入額に見合う量」。
    function _borrowFromV2(Leg calldata leg, address tokenIn, uint256 amount, bytes memory data) internal {
        bool inIsToken0 = leg.flags & FLAG_IN_IS_TOKEN0 != 0;
        (uint256 rIn, uint256 rOut) = _reserves(leg.pool, inIsToken0);
        uint256 out = _v2Quote(leg, tokenIn, amount, rIn, rOut);
        require(out > 0, "DexArbFlashLoan: zero output");
        IAmmPoolV2(leg.pool).swap(inIsToken0 ? 0 : out, inIsToken0 ? out : 0, address(this), data);
    }

    /// @dev V3のスワップ。受け取った量(プールが返す負の delta)を返す。
    function _callV3Swap(address pool, bool zeroForOne, uint256 amountIn, bytes memory data)
        internal returns (uint256 received)
    {
        (int256 a0, int256 a1) = IAmmPoolV3(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            data
        );
        int256 r = zeroForOne ? -a1 : -a0;
        received = r > 0 ? uint256(r) : 0;
    }

    /// @dev 最初のプールから受け取った後に呼ばれる本体。
    /// v3Received は1段目がV3の時にコールバックが受け取った量(V2なら0で、残高で測る)。
    function _runRouteAndRepay(bytes memory data, uint256 v3Owed, uint256 v3Received) internal {
        (address asset, Leg[] memory legs, Context memory ctx) = abi.decode(data, (address, Leg[], Context));
        inFlashSwap = false;

        uint256 running = v3Received > 0
            ? v3Received
            : IERC20(legs[0].tokenOut).balanceOf(address(this)) - ctx.firstOutBefore;
        require(running > 0, "DexArbFlashLoan: nothing received");

        address tokenIn = legs[0].tokenOut;

        // 清算が指定されていれば、ここで1手だけ差し込む。
        // 以降は「担保を売る経路」として、既存の処理がそのまま続く。
        if (liqPool != address(0)) {
            running = _liquidate(running);
            tokenIn = liqCollateral;
        }

        for (uint256 i = 1; i < legs.length; i++) {
            running = _swapLeg(legs[i], tokenIn, running);
            tokenIn = legs[i].tokenOut;
        }

        uint256 owed = legs[0].flags & FLAG_V3 != 0 ? v3Owed : ctx.amountIn;
        // 戻ってきた量は実際の残高で測る(最終段が税トークンでも、自分の残高から
        // 返済してしまわないため)。
        uint256 returned = IERC20(asset).balanceOf(address(this)) - ctx.assetBefore;
        if (simulating) revert SimulationResult(returned, owed);
        require(returned >= owed + ctx.minProfit, "DexArbFlashLoan: not profitable, reverting");
        _safeTransfer(asset, legs[0].pool, owed);
        emit RouteExecuted(asset, ctx.amountIn, returned - owed, uint8(legs.length));
    }

    /// @dev 借金を肩代わりし、受け取った担保の量を返す。
    ///
    /// 受け取った量は**必ず残高の差で測る**。Aave の戻り値を信じない。
    /// (担保の通貨が送金時に手数料を取る種類でも、実際に増えた量で進める)
    function _liquidate(uint256 debtToCover) internal returns (uint256 seized) {
        require(debtToCover > 0, "DexArbFlashLoan: zero debt to cover");
        address pool = liqPool;
        address collateral = liqCollateral;
        address debt = liqDebt;

        uint256 before = IERC20(collateral).balanceOf(address(this));
        uint256 debtBefore = IERC20(debt).balanceOf(address(this));

        // **使う分だけ承認し、直後に0へ戻す。** 残したままにしない。
        // 先に0を入れるのは、0以外からの上書きを拒む通貨(USDT等)のため。
        _safeApprove(debt, pool, 0);
        _safeApprove(debt, pool, debtToCover);
        IAavePool(pool).liquidationCall(collateral, debt, liqUser, debtToCover, false);
        _safeApprove(debt, pool, 0);

        seized = IERC20(collateral).balanceOf(address(this)) - before;
        require(seized > 0, "DexArbFlashLoan: nothing seized");

        // **実際にいくら使われたかを測る。** 渡した額を信じない。
        //
        // Aave は「一度に返せる上限」(HF≥0.95 なら借金の50%)で頭打ちにするので、
        // **こちらが渡した額より少ししか使われないことがある**。
        // その場合、余った借金の通貨がこの中に残る。
        // 売る段(legs[1..])は担保の通貨しか売らないので、**余りは換金されない**。
        //
        // 損にはならない(チェーン上の `returned >= owed + minProfit` が守る。
        // 足りなければ取り消されるだけで、余りは引き出せる)が、
        // **利益は目減りする**。だから bot 側が「上限ぴったり」で借りる必要がある。
        // 実際に使われた額を残しておけば、ずれていた時にログで分かる。
        // debtBefore は1段目が運んできた後の残高なので、既に debtToCover を含む。
        // 足し直すと二重に数える(最初そう書いてしまった)。**引くだけでよい。**
        // 担保と借金が別の通貨であることは _setLiq で確かめてあるので、
        // 担保が入ってきても借金側の残高は動かない。
        uint256 debtUsed = debtBefore - IERC20(debt).balanceOf(address(this));
        emit Liquidated(liqUser, debt, collateral, debtUsed, seized);
    }

    /// @dev 戻り値の無い通貨(USDT等)にも対応した承認。
    function _safeApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "DexArbFlashLoan: approve failed");
    }

    /// @dev 1段をスワップし、受け取った量を返す。V3はプールが返す量、V2は残高の差分。
    function _swapLeg(Leg memory leg, address tokenIn, uint256 amountIn) internal returns (uint256 received) {
        require(amountIn > 0, "DexArbFlashLoan: zero input");
        bool inIsToken0 = leg.flags & FLAG_IN_IS_TOKEN0 != 0;
        if (leg.flags & FLAG_V3 != 0) {
            address prevPool = activePool;
            address prevToken = activePayToken;
            bool prevV3 = activeIsV3;
            activePool = leg.pool;
            activePayToken = tokenIn;
            activeIsV3 = true;
            received = _callV3Swap(leg.pool, inIsToken0, amountIn, new bytes(0));
            activePool = prevPool;
            activePayToken = prevToken;
            activeIsV3 = prevV3;
        } else {
            // V2は送った後にプールへ実際に届いた量で受取量を計算する
            // (送金時に税を取るトークンでも失敗しない)。
            uint256 before = IERC20(leg.tokenOut).balanceOf(address(this));
            (uint256 rIn, uint256 rOut) = _reserves(leg.pool, inIsToken0);
            _safeTransfer(tokenIn, leg.pool, amountIn);
            uint256 out = _v2Quote(leg, tokenIn, _arrived(tokenIn, leg.pool, rIn, amountIn), rIn, rOut);
            require(out > 0, "DexArbFlashLoan: zero output");
            IAmmPoolV2(leg.pool).swap(inIsToken0 ? 0 : out, inIsToken0 ? out : 0, address(this), new bytes(0));
            received = IERC20(leg.tokenOut).balanceOf(address(this)) - before;
        }
        require(received > 0, "DexArbFlashLoan: insufficient output");
    }

    /// @dev プールに実際に届いた量(送った量を上限とする)。
    function _arrived(address token, address pool, uint256 reserveIn, uint256 sent) internal view returns (uint256) {
        uint256 balance = IERC20(token).balanceOf(pool);
        uint256 arrived = balance > reserveIn ? balance - reserveIn : 0;
        if (arrived > sent) arrived = sent;
        require(arrived > 0, "DexArbFlashLoan: nothing arrived");
        return arrived;
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
        _runRouteAndRepay(data, 0, 0);
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

    function _onV3Callback(int256 amount0Delta, int256 amount1Delta, bytes memory data) internal {
        require(msg.sender == activePool, "DexArbFlashLoan: unexpected callback");
        int256 owedSigned = amount0Delta > 0 ? amount0Delta : amount1Delta;
        require(owedSigned > 0, "DexArbFlashLoan: nothing owed");
        uint256 owed = uint256(owedSigned);

        if (data.length == 0) {
            // 見積もり中は支払わず、受け取れる量をそのまま返して取り消す。
            // 受取側の差分(負のdelta)が受取量になる。
            if (quoting) {
                int256 receivedSigned = amount0Delta < 0 ? -amount0Delta : -amount1Delta;
                revert QuoteResult(receivedSigned > 0 ? uint256(receivedSigned) : 0);
            }
            _safeTransfer(activePayToken, msg.sender, owed);
            return;
        }
        require(inFlashSwap, "DexArbFlashLoan: not in flash swap");
        int256 recv = amount0Delta < 0 ? -amount0Delta : -amount1Delta;
        _runRouteAndRepay(data, owed, recv > 0 ? uint256(recv) : 0);
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
    /// @dev Ramses 系(Pharaoh の元)の名前。
    function ramsesV2SwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        _onV3Callback(a0, a1, data);
    }

    /// @dev 名前の分からないフォークのコールバック。今スワップ中のプールの形式で解釈する。
    /// V3形式なら (int256, int256, bytes)、V2形式なら (address, uint256, uint256, bytes)。
    /// 呼び出し元がスワップ中のプールである事は、どちらの道でも同じ条件で確かめる
    /// (スワップ中でなければ activePool は 0 なので、誰が呼んでも通らない)。
    fallback() external {
        if (activeIsV3) {
            require(msg.data.length >= 4 + 32 * 3, "DexArbFlashLoan: unknown call");
            (int256 a0, int256 a1, bytes memory data) = abi.decode(msg.data[4:], (int256, int256, bytes));
            _onV3Callback(a0, a1, data);
        } else {
            require(msg.data.length >= 4 + 32 * 4, "DexArbFlashLoan: unknown call");
            (address sender, , , bytes memory data) = abi.decode(msg.data[4:], (address, uint256, uint256, bytes));
            _onV2Callback(sender, data);
        }
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
