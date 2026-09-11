// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

// Aaveの公式パッケージ一式を丸ごと依存に加えるのではなく、実際に必要な
// インターフェースだけをここに直接定義する軽量構成。ロジック自体は
// Aave公式のFlashLoanSimpleReceiverパターンに準拠。
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

// AMMプールの低レベルインターフェース。
// Uniswap V2形式もSolidly形式(Aerodrome/Velodrome)も、この swap と
// token0 は全く同じ形式で実装されている。ルーターはこれを呼び出す
// 「便利な窓口」にすぎないため、プールを直接呼べばルーターアドレスの
// 事前調査が一切不要になる(dfyn・swapr・apeswap等、無数のフォークに
// 自動的に対応できる)。
interface IAmmPool {
    function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external;
    function token0() external view returns (address);
}

/// @title DexArbFlashLoan
/// @notice 「安いプールで買う→高いプールで売る」を1トランザクションで完結させる、
///         Aave V3フラッシュローンを使ったDEXアービトラージ実行コントラクト。
///         利益が出ない場合はrequireでrevertし、取引全体が無効化される
///         (実害はガス代のみ)。
///
///         [設計変更] 以前はDEXごとのルーターアドレスを事前に調査して
///         渡す方式だったが、候補の69%がルーター未確認で実行できなかった。
///         プールを直接呼ぶ方式に変更し、この制約を撤廃した。
///
///         受取量(amountOut)はbot側が事前に計算して渡す。プール自身の
///         getAmountOutで実測した手数料を使うため、計算式の違い
///         (Uniswap V2 / Solidly)も吸収できる。
contract DexArbFlashLoan {
    IPoolAddressesProvider public immutable ADDRESSES_PROVIDER;
    IPool public immutable POOL;
    address public owner;

    constructor(address _addressProvider) {
        ADDRESSES_PROVIDER = IPoolAddressesProvider(_addressProvider);
        POOL = IPool(ADDRESSES_PROVIDER.getPool());
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "DexArbFlashLoan: not owner");
        _;
    }

    /// @dev 1回のアービトラージ実行に必要な情報。
    /// tokenYが「借りる・返す・利益を得る」通貨、tokenXが経由するだけの通貨。
    /// amountOutStep1/2 は、bot側がプールの現在の状態から計算した受取量。
    /// この値が実際より大きすぎるとプール側でrevertするため、
    /// 過大請求による損失は起こらない(スリッページ保護を兼ねる)。
    struct ArbParams {
        address poolCheap;
        address poolExpensive;
        address tokenX;
        address tokenY;
        uint256 amountOutStep1;
        uint256 amountOutStep2;
    }

    event ArbExecuted(address indexed tokenY, uint256 amountBorrowed, uint256 profit);

    /// @notice botから呼び出すエントリーポイント。ここでフラッシュローンを開始する。
    function executeArb(address asset, uint256 amount, ArbParams calldata params) external onlyOwner {
        require(asset == params.tokenY, "DexArbFlashLoan: asset must equal tokenY");
        POOL.flashLoanSimple(address(this), asset, amount, abi.encode(params), 0);
    }

    /// @dev プールを直接呼んでスワップする。
    /// 手順: ①プールへトークンを送る ②swapを呼んで受取量を要求する。
    /// プールは「送られた量に見合うか」を自分で検算し、過大なら自動的に拒否する。
    function _swapDirect(
        address pool,
        address tokenIn,
        uint256 amountIn,
        uint256 amountOut
    ) internal {
        require(amountOut > 0, "DexArbFlashLoan: amountOut must be positive");

        // プールへ入力トークンを直接送る(ルーターを経由しない)。
        IERC20(tokenIn).transfer(pool, amountIn);

        // token0/token1のどちら側を受け取るかを決める。
        bool tokenInIsToken0 = IAmmPool(pool).token0() == tokenIn;
        uint256 amount0Out = tokenInIsToken0 ? 0 : amountOut;
        uint256 amount1Out = tokenInIsToken0 ? amountOut : 0;

        IAmmPool(pool).swap(amount0Out, amount1Out, address(this), new bytes(0));
    }

    /// @notice Aave Poolから呼び戻されるコールバック。実際のアービトラージ処理。
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address /* initiator */,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(POOL), "DexArbFlashLoan: caller must be Aave Pool");

        ArbParams memory p = abi.decode(params, (ArbParams));

        // ステップ1: 安いプールで tokenY(借りた資金) → tokenX
        _swapDirect(p.poolCheap, p.tokenY, amount, p.amountOutStep1);

        // ステップ2: 高いプールで tokenX → tokenY
        // 実際に受け取れたtokenXの全量を使う(見積もりより多いこともあるため)。
        uint256 tokenXBalance = IERC20(p.tokenX).balanceOf(address(this));
        _swapDirect(p.poolExpensive, p.tokenX, tokenXBalance, p.amountOutStep2);

        // 返済額(元本+手数料)を用意できなければここでrevertする。
        uint256 amountOwed = amount + premium;
        uint256 balance = IERC20(asset).balanceOf(address(this));
        require(balance >= amountOwed, "DexArbFlashLoan: not profitable, reverting");

        IERC20(asset).approve(address(POOL), amountOwed);

        emit ArbExecuted(asset, amount, balance - amountOwed);
        return true;
    }

    /// @notice 蓄積した利益をownerのウォレットへ引き出す。
    function withdraw(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "DexArbFlashLoan: nothing to withdraw");
        IERC20(token).transfer(owner, balance);
    }
}
