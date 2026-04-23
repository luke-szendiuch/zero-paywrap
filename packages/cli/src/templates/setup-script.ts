export const setupScriptTemplate = (): string => `import "dotenv/config";
import { generateMppSecretKey, generateWallet } from "@zeroclickai/paywrap/setup";

/**
 * One-shot bootstrap for a fresh deploy. Prints a full \`.env\`-shaped block so
 * you can pipe it straight into your secret manager / \`.env\`.
 */
const main = () => {
\tconst wallet = generateWallet();
\tconst mppKey = generateMppSecretKey();
\tconsole.log(\`WALLET_PRIVATE_KEY=\${wallet.privateKey}\`);
\tconsole.log(\`WALLET_ADDRESS=\${wallet.address}\`);
\tconsole.log(\`MPP_SECRET_KEY=\${mppKey}\`);
};

main();
`;
