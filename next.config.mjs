/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: [
      '@meteora-ag/dlmm',
      '@coral-xyz/anchor',
      '@solana/web3.js',
      '@solana/spl-token',
      '@solana/buffer-layout',
      '@solana/buffer-layout-utils',
      'bn.js',
      'bs58',
      'borsh',
    ],
  },
  outputFileTracingExcludes: {
    '*': [
      'node_modules/@meteora-ag/**',
      'node_modules/@coral-xyz/**',
      'node_modules/@project-serum/**',
    ],
  },
  webpack: (config, { isServer }) => {
    const esmExternals = [
      '@meteora-ag/dlmm',
      '@coral-xyz/anchor',
    ]
    const prevExternals = config.externals ?? []
    config.externals = [
      ...(Array.isArray(prevExternals) ? prevExternals : [prevExternals]),
      ({ request }, callback) => {
        if (esmExternals.some((pkg) => request === pkg || request?.startsWith(pkg + '/'))) {
          return callback(null, 'commonjs ' + request)
        }
        callback()
      },
    ]

    if (!isServer) {
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
