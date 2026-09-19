#!/usr/bin/env node
// Optional Solana main-prize hook: mint a Phantom Arena match result as a compressed NFT on devnet.
//
//   npm install
//   node mint_match.mjs --winner Ada --mode Duel --kills 3 --loot 2 --badges 6 --dry-run
//   node mint_match.mjs --winner Ada --mode Duel --uri https://example.com/match.json
//
// First real run creates a devnet wallet (.wallet.json), airdrops 1 SOL, and creates a Merkle tree
// (tree.json); later runs reuse both. --dry-run only prints the metadata and touches no network.
// Not part of the badge demo; unverified against devnet in this repo.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export function buildMetadata({ winner, mode = "Duel", kills = 0, loot = 0, badges = 0, when = new Date() }) {
  if (!winner) throw new Error("winner is required");
  const name = `Phantom Arena: ${winner} wins`.slice(0, 32);
  return {
    name,
    symbol: "PHNTM",
    description: `${winner} won a ${mode} in Phantom Arena at Hack the North 2026 with ${kills} kills; ${badges} badges in the arena, ${loot} relics found.`,
    attributes: [
      { trait_type: "mode", value: mode },
      { trait_type: "kills", value: String(kills) },
      { trait_type: "loot", value: String(loot) },
      { trait_type: "badges", value: String(badges) },
      { trait_type: "date", value: when.toISOString().slice(0, 10) },
    ],
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[k] = v;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const meta = buildMetadata({ winner: args.winner, mode: args.mode, kills: +args.kills || 0, loot: +args.loot || 0, badges: +args.badges || 0 });
  if (args["dry-run"]) {
    console.log(JSON.stringify(meta, null, 2));
    return;
  }
  const { createUmi } = await import("@metaplex-foundation/umi-bundle-defaults");
  const { keypairIdentity, generateSigner, publicKey, sol } = await import("@metaplex-foundation/umi");
  const { createTree, mintV1, mplBubblegum } = await import("@metaplex-foundation/mpl-bubblegum");
  const umi = createUmi("https://api.devnet.solana.com").use(mplBubblegum());
  let secret;
  if (existsSync(".wallet.json")) secret = new Uint8Array(JSON.parse(readFileSync(".wallet.json", "utf8")));
  else {
    const kp = generateSigner(umi);
    secret = kp.secretKey;
    writeFileSync(".wallet.json", JSON.stringify(Array.from(secret)));
  }
  const keypair = umi.eddsa.createKeypairFromSecretKey(secret);
  umi.use(keypairIdentity(keypair));
  const balance = await umi.rpc.getBalance(umi.identity.publicKey);
  if (Number(balance.basisPoints) < 0.2e9) {
    console.log("airdropping 1 devnet SOL to", umi.identity.publicKey);
    await umi.rpc.airdrop(umi.identity.publicKey, sol(1));
  }
  let tree;
  if (existsSync("tree.json")) tree = publicKey(JSON.parse(readFileSync("tree.json", "utf8")).tree);
  else {
    const merkleTree = generateSigner(umi);
    const builder = await createTree(umi, { merkleTree, maxDepth: 14, maxBufferSize: 64 });
    await builder.sendAndConfirm(umi);
    tree = merkleTree.publicKey;
    writeFileSync("tree.json", JSON.stringify({ tree: tree.toString() }));
    console.log("created merkle tree", tree.toString());
  }
  const uri = args.uri || "https://phantom-arena.example/match.json";
  const { signature } = await mintV1(umi, {
    leafOwner: umi.identity.publicKey,
    merkleTree: tree,
    metadata: { name: meta.name, symbol: meta.symbol, uri, sellerFeeBasisPoints: 0, collection: null, creators: [] },
  }).sendAndConfirm(umi);
  console.log("minted", meta.name, "tx", Buffer.from(signature).toString("base64"));
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("mint_match.mjs")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
