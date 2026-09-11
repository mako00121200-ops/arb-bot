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

// AMMプールの低レベルインターフェース。
// Uniswap V2形式もSolidly形式(Aerodrome/Velodrome)も、この swap と
// token0 は全く同じ形式で実装されている。ルーターはこれを呼び出す
// 「便利な窓口」にすぎないため、プールを直接呼べばルーターアドレスの
// 事前調査が一切不要になる。
interface IAmmPool {
    function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external;
    function token0() external view returns (address);
}

/// @title DexArbFlashLoan
/// @notice Aave V3フラッシュローンを使ったDEXアービトラージ実行コントラクト。
///         利益が出ない場合はrequireでrevertし、取引全体が無効化される
///         (実害はガス代のみ)。
///
///         2種類の裁定に対応する:
///           executeArb     … 2ステップ。同じペアの価格差を2つのプールで取る。
///           executeTriArb  … 3ステップ(三角裁定)。A→B→C→Aと巡回して、
///                            トークン間の相対価格の歪みを取る。同じDEX内で
///                            完結するため機会の母数が桁違いに多く、専業botとの
///                            競合も比較的少ない。
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

    /// @dev 2ステップ裁定のパラメータ。
    struct ArbParams {
        address poolCheap;
        address poolExpensive;
        address tokenX;
        address tokenY;
        uint256 amountOutStep1;
        uint256 amountOutStep2;
    }

    /// @dev 3ステップ(三角)裁定のパラメータ。
    /// tokenA(借りる通貨) → tokenB → tokenC → tokenA と巡回する。
    /// pools[i] は i番目のスワップに使うプール。
    struct TriArbParams {
        address pool1;
        address pool2;
        address pool3;
        address tokenA;
        address tokenB;
        address tokenC;
        uint256 amountOut1;
        uint256 amountOut2;
        uint256 amountOut3;
    }

    event ArbExecuted(address indexed tokenY, uint256 amountBorrowed, uint256 profit);
    event TriArbExecuted(address indexed tokenA, uint256 amountBorrowed, uint256 profit);

    /// @dev フラッシュローンのコールバックで、どちらの処理を行うかの目印。
    uint8 private constant MODE_TWO_STEP = 1;
    uint8 private constant MODE_THREE_STEP = 2;

    /// @notice 2ステップ裁定のエントリーポイント。
    function executeArb(address asset, uint256 amount, ArbParams calldata params) external onlyOwner {
        require(asset == params.tokenY, "DexArbFlashLoan: asset must equal tokenY");
        POOL.flashLoanSimple(address(this), asset, amount, abi.encode(MODE_TWO_STEP, abi.encode(params)), 0);
    }

    /// @notice 3ステップ(三角)裁定のエントリーポイント。
    function executeTriArb(address asset, uint256 amount, TriArbParams calldata params) external onlyOwner {
        require(asset == params.tokenA, "DexArbFlashLoan: asset must equal tokenA");
        POOL.flashLoanSimple(address(this), asset, amount, abi.encode(MODE_THREE_STEP, abi.encode(params)), 0);
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
        IERC20(tokenIn).transfer(pool, amountIn);

        bool tokenInIsToken0 = IAmmPool(pool).token0() == tokenIn;
        uint256 amount0Out = tokenInIsToken0 ? 0 : amountOut;
        uint256 amount1Out = tokenInIsToken0 ? amountOut : 0;

        IAmmPool(pool).swap(amount0Out, amount1Out, address(this), new bytes(0));
    }

    /// @notice Aave Poolから呼び戻されるコールバック。
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address /* initiator */,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(POOL), "DexArbFlashLoan: caller must be Aave Pool");

        (uint8 mode, bytes memory inner) = abi.decode(params, (uint8, bytes));

        if (mode == MODE_TWO_STEP) {
            _runTwoStep(amount, abi.decode(inner, (ArbParams)));
        } else {
            _runThreeStep(amount, abi.decode(inner, (TriArbParams)));
        }

        uint256 amountOwed = amount + premium;
        uint256 balance = IERC20(asset).balanceOf(address(this));
        require(balance >= amountOwed, "DexArbFlashLoan: not profitable, reverting");

        IERC20(asset).approve(address(POOL), amountOwed);

        if (mode == MODE_TWO_STEP) {
            emit ArbExecuted(asset, amount, balance - amountOwed);
        } else {
            emit TriArbExecuted(asset, amount, balance - amountOwed);
        }
        return true;
    }

    function _runTwoStep(uint256 amount, ArbParams memory p) internal {
        _swapDirect(p.poolCheap, p.tokenY, amount, p.amountOutStep1);
        uint256 tokenXBalance = IERC20(p.tokenX).balanceOf(address(this));
        _swapDirect(p.poolExpensive, p.tokenX, tokenXBalance, p.amountOutStep2);
    }

    /// @dev A → B → C → A と3回スワップして巡回する。
    /// 各段で「実際に受け取れた全量」を次に回す(見積もりより多いこともあるため)。
    function _runThreeStep(uint256 amount, TriArbParams memory p) internal {
        _swapDirect(p.pool1, p.tokenA, amount, p.amountOut1);

        uint256 balanceB = IERC20(p.tokenB).balanceOf(address(this));
        _swapDirect(p.pool2, p.tokenB, balanceB, p.amountOut2);

        uint256 balanceC = IERC20(p.tokenC).balanceOf(address(this));
        _swapDirect(p.pool3, p.tokenC, balanceC, p.amountOut3);
    }

    /// @notice 蓄積した利益をownerのウォレットへ引き出す。
    function withdraw(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "DexArbFlashLoan: nothing to withdraw");
        IERC20(token).transfer(owner, balance);
    }
}
