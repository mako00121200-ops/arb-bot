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

// Uniswap V2互換ルーター(uniswap, quickswap, sushiswap 等)。
interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);
}

// Solidly系ルーター(Aerodrome on Base, Velodrome on Optimism 等)。
// Uniswap V2と違い、経路をaddress[]ではなくRoute構造体の配列で渡す。
// この違いのため、V2形式のまま呼び出すと必ず失敗する。
interface ISolidlyRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        Route[] calldata routes,
        address to,
        uint deadline
    ) external returns (uint[] memory amounts);

    function defaultFactory() external view returns (address);
}

/// @title DexArbFlashLoan
/// @notice 「安いDEXで買う→高いDEXで売る」を1トランザクションで完結させる、
///         Aave V3フラッシュローンを使ったDEXアービトラージ実行コントラクト。
///         利益が出ない場合はrequireでrevertし、取引全体が無効化される
///         (実害はガス代のみ)。
///         Uniswap V2形式とSolidly形式の両方のルーターに対応。
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

    /// @dev ルーターの種類。呼び出し形式が根本的に違うため、bot側から明示的に指定する。
    enum RouterKind { UniswapV2, Solidly }

    /// @dev 1回のアービトラージ実行に必要な情報。
    /// tokenYが「借りる・返す・利益を得る」通貨、tokenXが経由するだけの通貨。
    struct ArbParams {
        address routerCheap;
        address routerExpensive;
        address tokenX;
        address tokenY;
        uint256 minAmountOutStep1;
        uint256 minAmountOutStep2;
        RouterKind kindCheap;
        RouterKind kindExpensive;
    }

    event ArbExecuted(address indexed tokenY, uint256 amountBorrowed, uint256 profit);

    /// @notice botから呼び出すエントリーポイント。ここでフラッシュローンを開始する。
    function executeArb(address asset, uint256 amount, ArbParams calldata params) external onlyOwner {
        require(asset == params.tokenY, "DexArbFlashLoan: asset must equal tokenY");
        bytes memory data = abi.encode(params);
        POOL.flashLoanSimple(address(this), asset, amount, data, 0);
    }

    /// @dev ルーターの種類に応じて、正しい形式でスワップを呼び出す。
    /// Solidly系はvolatileプール(stable=false)のみ対象。観測側もx*y=k型のみを
    /// 扱っているため、ここでもstableは常にfalseで統一する。
    function _swap(
        address router,
        RouterKind kind,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut
    ) internal returns (uint256) {
        IERC20(tokenIn).approve(router, amountIn);

        if (kind == RouterKind.Solidly) {
            ISolidlyRouter.Route[] memory routes = new ISolidlyRouter.Route[](1);
            routes[0] = ISolidlyRouter.Route({
                from: tokenIn,
                to: tokenOut,
                stable: false,
                factory: ISolidlyRouter(router).defaultFactory()
            });
            uint256[] memory amounts = ISolidlyRouter(router).swapExactTokensForTokens(
                amountIn, minAmountOut, routes, address(this), block.timestamp
            );
            return amounts[amounts.length - 1];
        }

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        uint256[] memory outs = IUniswapV2Router(router).swapExactTokensForTokens(
            amountIn, minAmountOut, path, address(this), block.timestamp
        );
        return outs[outs.length - 1];
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

        // ステップ1: 安いDEXで tokenY(借りた資金) → tokenX
        uint256 tokenXReceived = _swap(
            p.routerCheap, p.kindCheap, p.tokenY, p.tokenX, amount, p.minAmountOutStep1
        );

        // ステップ2: 高いDEXで tokenX → tokenY
        _swap(
            p.routerExpensive, p.kindExpensive, p.tokenX, p.tokenY, tokenXReceived, p.minAmountOutStep2
        );

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
