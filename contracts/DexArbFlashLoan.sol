// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

// Aaveの公式パッケージ一式(@aave/core-v3)を丸ごと依存に加えるのではなく、
// 実際に必要な3つのインターフェースだけをここに直接定義する軽量構成にしている。
// ロジック自体はAave公式のFlashLoanSimpleReceiverパターンに準拠(仕様書4.4節)。
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

// Uniswap V2互換ルーターの最小インターフェース(V3は対象外。仕様書4.1節のV3除外方針と一致)。
interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
}

/// @title DexArbFlashLoan
/// @notice 「安いDEXで買う→高いDEXで売る」を1トランザクションで完結させる、
///         Aave V3フラッシュローンを使ったDEXアービトラージ実行コントラクト。
///         利益が出ない場合は returnの手前でrevertし、取引全体が無効化される
///         (実害はガス代のみ。仕様書3.2節「1トランザクション完結方式」に対応)。
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
    /// tokenYが「借りる・返す・利益を得る」通貨(観測システムのY相当)、
    /// tokenXが途中で経由するだけの通貨(観測システムのX相当、例:AERO・NPC等)。
    struct ArbParams {
        address routerCheap;       // 安く買えるDEXのルーター(V2互換)
        address routerExpensive;   // 高く売れるDEXのルーター(V2互換)
        address tokenX;            // 経由するだけのトークン
        address tokenY;            // 借入・返済・利益の通貨
        uint256 minAmountOutStep1; // 1回目スワップの最低受取量(スリッページ保護)
        uint256 minAmountOutStep2; // 2回目スワップの最低受取量(スリッページ保護)
    }

    event ArbExecuted(address indexed tokenY, uint256 amountBorrowed, uint256 profit);

    /// @notice botから呼び出すエントリーポイント。ここでフラッシュローンを開始する。
    /// @param asset 借りるトークン(=tokenYと同じである必要がある)
    /// @param amount 借入額。観測システムのtradeAmountIn(理論上の最適額 or 上限$2,000)に対応
    function executeArb(address asset, uint256 amount, ArbParams calldata params) external onlyOwner {
        require(asset == params.tokenY, "DexArbFlashLoan: asset must equal tokenY");
        bytes memory data = abi.encode(params);
        POOL.flashLoanSimple(address(this), asset, amount, data, 0);
    }

    /// @notice Aave Poolから呼び戻されるコールバック。実際のアービトラージ処理はここに書く。
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address /* initiator */,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(POOL), "DexArbFlashLoan: caller must be Aave Pool");

        ArbParams memory p = abi.decode(params, (ArbParams));

        // ステップ1: 安いDEXで tokenY(借りた資金) → tokenX に交換
        IERC20(asset).approve(p.routerCheap, amount);
        address[] memory pathBuy = new address[](2);
        pathBuy[0] = p.tokenY;
        pathBuy[1] = p.tokenX;
        uint256[] memory amountsOut1 = IUniswapV2Router(p.routerCheap).swapExactTokensForTokens(
            amount, p.minAmountOutStep1, pathBuy, address(this), block.timestamp
        );
        uint256 tokenXReceived = amountsOut1[amountsOut1.length - 1];

        // ステップ2: 高いDEXで tokenX → tokenY に交換
        IERC20(p.tokenX).approve(p.routerExpensive, tokenXReceived);
        address[] memory pathSell = new address[](2);
        pathSell[0] = p.tokenX;
        pathSell[1] = p.tokenY;
        IUniswapV2Router(p.routerExpensive).swapExactTokensForTokens(
            tokenXReceived, p.minAmountOutStep2, pathSell, address(this), block.timestamp
        );

        // 返済額(元本+手数料)を用意できなければここでrevertする。
        // これにより「利益が出ない取引は自動的に無かったことになる」を実現する。
        uint256 amountOwed = amount + premium;
        uint256 balance = IERC20(asset).balanceOf(address(this));
        require(balance >= amountOwed, "DexArbFlashLoan: not profitable, reverting");

        IERC20(asset).approve(address(POOL), amountOwed);

        uint256 profit = balance - amountOwed;
        emit ArbExecuted(asset, amount, profit);

        return true;
    }

    /// @notice 蓄積した利益をownerのウォレットへ引き出す。
    function withdraw(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "DexArbFlashLoan: nothing to withdraw");
        IERC20(token).transfer(owner, balance);
    }
}
