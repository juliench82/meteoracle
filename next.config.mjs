/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: false,
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
  // Prevent Next.js from tracing into these packages during page data collection.
  // @meteora-ag/dlmm ships an .mjs that imports @coral-xyz/anchor with bare
  // directory imports — unsupported by Node ESM. These packages are runtime-only
  // (loaded by PM2 workers), never needed at build time.
  outputFileTracingExcludes: {
    '*': [
      'node_modules/@meteora-ag/**',
      'node_modules/@coral-xyz/**',
      'node_modules/@project-serum/**',
    ],
  },
  webpack: (config, { isServer }) => {
    // Hard-exclude the problematic ESM packages from webpack bundling.
    // They are loaded at runtime by the server process, not bundled.
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
