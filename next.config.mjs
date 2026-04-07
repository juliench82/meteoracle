/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: false,
  },
  // Keep heavy Node.js-only packages server-side only — never bundled by webpack.
  // Required for @meteora-ag/dlmm, @solana/web3.js, @solana/spl-token, bn.js, bs58.
  serverExternalPackages: [
    '@meteora-ag/dlmm',
    '@solana/web3.js',
    '@solana/spl-token',
    '@solana/buffer-layout',
    '@solana/buffer-layout-utils',
    'bn.js',
    'bs58',
    'borsh',
  ],
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Prevent webpack from trying to polyfill Node built-ins in the browser bundle.
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        os: false,
        crypto: false,
        stream: false,
        buffer: false,
        net: false,
        tls: false,
        zlib: false,
        http: false,
        https: false,
        assert: false,
      }
    }
    return config
  },
}

export default nextConfig
