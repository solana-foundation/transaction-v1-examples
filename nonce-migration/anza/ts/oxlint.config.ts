import solanaConfig from '@solana-config/oxc/oxlint';
import { defineConfig } from 'oxlint';

export default defineConfig({
    extends: [solanaConfig],
    // kit/src/client is generated upstream and vendored as-is; see scripts/vendor-ts-client.sh.
    ignorePatterns: ['dist', 'node_modules', 'kit/src/client'],
    options: { typeAware: true },
});
