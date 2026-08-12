// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * FlashArbitrage (Arbitrum One 向け)
 * ------------------------------------------------------------
 * Aave V3のフラッシュローンで資産を借り、単一トランザクション内で
 *   1) Uniswap V3 または SushiSwap で買う
 *   2) もう一方のDEXで売る
 *   3) 元本+手数料をAaveに返済し、残りをオーナーに送る
 * を実行する。返済できなければトランザクション全体が自動的に
 * revert されるため、実行が失敗しても資金を失うことはなく、
 * 負担するのはガス代のみ。
 *
 * onlyOwnerのみが呼び出せる。デプロイ時のmsg.senderがオーナーになる。
 */

interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface IUniswapV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

contract FlashArbitrage is IFlashLoanSimpleReceiver {
    address public owner;
    IPool public immutable aavePool;
    IUniswapV3SwapRouter public immutable uniRouter;
    IUniswapV2Router public immutable sushiRouter;

    event ArbitrageExecuted(address indexed asset, uint256 borrowed, uint256 profit);
    event ArbitrageFailed(string reason);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address _aavePool, address _uniRouter, address _sushiRouter) {
        owner = msg.sender;
        aavePool = IPool(_aavePool);
        uniRouter = IUniswapV3SwapRouter(_uniRouter);
        sushiRouter = IUniswapV2Router(_sushiRouter);
    }

    function executeArbitrage(
        address asset,
        uint256 amount,
        address baseToken,
        bool buyOnUni,
        uint24 uniFee,
        uint256 minBaseOut,
        uint256 minAssetOut
    ) external onlyOwner {
        bytes memory params = abi.encode(baseToken, buyOnUni, uniFee, minBaseOut, minAssetOut);
        aavePool.flashLoanSimple(address(this), asset, amount, params, 0);
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(aavePool), "caller must be aave pool");
        require(initiator == address(this), "invalid initiator");

        (address baseToken, bool buyOnUni, uint24 uniFee, uint256 minBaseOut, uint256 minAssetOut) =
            abi.decode(params, (address, bool, uint24, uint256, uint256));

        if (buyOnUni) {
            IERC20(asset).approve(address(uniRouter), amount);
            uint256 baseReceived = uniRouter.exactInputSingle(IUniswapV3SwapRouter.ExactInputSingleParams({
                tokenIn: asset,
                tokenOut: baseToken,
                fee: uniFee,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: amount,
                amountOutMinimum: minBaseOut,
                sqrtPriceLimitX96: 0
            }));

            IERC20(baseToken).approve(address(sushiRouter), baseReceived);
            address[] memory path = new address[](2);
            path[0] = baseToken;
            path[1] = asset;
            sushiRouter.swapExactTokensForTokens(baseReceived, minAssetOut, path, address(this), block.timestamp);
        } else {
            IERC20(asset).approve(address(sushiRouter), amount);
            address[] memory path = new address[](2);
            path[0] = asset;
            path[1] = baseToken;
            uint256[] memory amounts = sushiRouter.swapExactTokensForTokens(amount, minBaseOut, path, address(this), block.timestamp);
            uint256 baseReceived = amounts[1];

            IERC20(baseToken).approve(address(uniRouter), baseReceived);
            uniRouter.exactInputSingle(IUniswapV3SwapRouter.ExactInputSingleParams({
                tokenIn: baseToken,
                tokenOut: asset,
                fee: uniFee,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: baseReceived,
                amountOutMinimum: minAssetOut,
                sqrtPriceLimitX96: 0
            }));
        }

        uint256 amountOwed = amount + premium;
        require(
            IERC20(asset).balanceOf(address(this)) >= amountOwed,
            "unprofitable: cannot repay flash loan"
        );

        IERC20(asset).approve(address(aavePool), amountOwed);

        uint256 profit = IERC20(asset).balanceOf(address(this)) - amountOwed;
        if (profit > 0) {
            IERC20(asset).transfer(owner, profit);
        }
        emit ArbitrageExecuted(asset, amount, profit);
        return true;
    }

    function withdraw(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal > 0, "nothing to withdraw");
        IERC20(token).transfer(owner, bal);
    }
}
