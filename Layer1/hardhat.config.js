require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.20",

  networks: {
    hardhat: {}, // Mạng mặc định của Hardhat (chạy local trong môi trường Hardhat)

    // Cấu hình Ganache GUI sử dụng private key
    ganache: {
      url: process.env.RPC_URL, // RPC server của Ganache GUI
      network_id: process.env.NETWORK_ID, // Network ID của Ganache GUI
      accounts: [process.env.PRIVATE_KEY],
    },

    // Sepolia testnet
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || process.env.RPC_URL,
      chainId: 11155111,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },

  // Cấu hình các tài khoản (named accounts)
  namedAccounts: {
    deployer: {
      default: 0, // Tài khoản đầu tiên từ Ganache GUI
    },
  },
};
