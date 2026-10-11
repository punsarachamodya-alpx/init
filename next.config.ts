import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  // The database driver and the Anthropic SDK stay as plain Node modules on the server.
  serverExternalPackages: ['pg', '@anthropic-ai/sdk'],
};

export default config;
