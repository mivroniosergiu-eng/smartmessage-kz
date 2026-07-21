/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@smartmessage/db'],
  allowedDevOrigins: ['127.0.0.1'],
  typedRoutes: true,
}

export default nextConfig
