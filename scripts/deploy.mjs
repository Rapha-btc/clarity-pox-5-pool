#!/usr/bin/env node
//
// Deploy this project's contracts to the private Hiro node, which uses a CUSTOM
// Stacks chain id (256). Clarinet hard-codes testnet = 2147483648 and exposes no
// chain-id override, so we sign + broadcast with @stacks/transactions instead.
//
// The contracts reference MAINNET principals so the simnet tests can resolve them
// (canonical boot pox-5 at SP000…, mainnet sBTC at SM3VDXK3…, the SIP-010 trait at
// SP3FBR2…). On the node those live at DIFFERENT addresses, so at deploy time we
// rewrite the source:
//   - boot pox-5   SP000000000000000000002Q6VF78 -> ST000000000000000000002AMW42H
//   - sBTC suite   SM3VDXK3…                      -> SN3R84… (the node's sBTC)
//     Both already exist on the node, so they are REMAPPED only (never published).
//   - SIP-010 trait SP3FBR2…  is NOT on the node, so it is republished under the
//     deployer and its principal remapped to the deployer (as `clarinet
//     deployments apply` would). Source comes from .cache/requirements/<id>.clar.
//
// Publishes, under the deployer and in order: the republished requirements (just
// the SIP-010 trait), then [contracts.*] (this project's contracts). Idempotent:
// contracts already on the node are skipped (handy across the node's daily resets).
//
// Deployer key resolved from DEPLOYER_KEY (hex), DEPLOYER_MNEMONIC, or the
// mnemonic in settings/Testnet.toml (see scripts/_wallet.mjs).
//
// Env:
//   DEPLOYER_KEY / DEPLOYER_MNEMONIC   override the Testnet.toml mnemonic
//   API_URL        default https://api.private-1.hiro.so
//   CHAIN_ID       default 256
//   FEE            fixed fee (uSTX) per publish; default 1000000 (1 STX)
//   MANIFEST       default ./Clarinet.toml
//   MIN_USTX       faucet floor; default 50000000 (skip funding if >=)
//
// Usage:  ./scripts/deploy-testnet.sh   (mnemonic from settings/Testnet.toml)
//
import { readFileSync } from 'node:fs';
import {
  makeContractDeploy, broadcastTransaction, getAddressFromPrivateKey,
} from '@stacks/transactions';
import { STACKS_TESTNET } from '@stacks/network';
import { resolveDeployerKey } from './_wallet.mjs';

const API_URL = process.env.API_URL ?? 'https://api.private-1.hiro.so';
const CHAIN_ID = Number(process.env.CHAIN_ID ?? '256');
const MANIFEST = process.env.MANIFEST ?? './Clarinet.toml';
const MIN_USTX = BigInt(process.env.MIN_USTX ?? '50000000');
const FEE = BigInt(process.env.FEE ?? '1000000'); // 1 STX/publish; override with FEE
const key = await resolveDeployerKey();

// chainId 256 for signing; transactionVersion stays testnet (ST/SN addresses).
const network = { ...STACKS_TESTNET, chainId: CHAIN_ID };
const client = { baseUrl: API_URL };
const deployer = getAddressFromPrivateKey(key, 'testnet');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const contractExists = (name) =>
  fetch(`${API_URL}/v2/contracts/interface/${deployer}/${name}`).then((r) => r.ok).catch(() => false);

async function accountState() {
  const r = await fetch(`${API_URL}/v2/accounts/${deployer}?proof=0`).then((x) => x.json());
  return { nonce: Number(r.nonce), balance: BigInt(parseInt(r.balance, 16)) };
}

const toml = readFileSync(MANIFEST, 'utf8');

// [[project.requirements]] contract_id list (mainnet contracts)
function parseRequirements() {
  return [...toml.matchAll(/contract_id\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
}

// ordered [contracts.NAME] { path, clarity_version } from the manifest
function parseContracts() {
  const out = [];
  const re = /\[contracts\.([A-Za-z0-9_-]+)\]([\s\S]*?)(?=\n\[|\s*$)/g;
  let m;
  while ((m = re.exec(toml))) {
    const path = (m[2].match(/path\s*=\s*"([^"]+)"/) || [])[1];
    const cv = Number((m[2].match(/clarity_version\s*=\s*(\d+)/) || [])[1] || 5);
    if (path) out.push({ name: m[1], path, clarityVersion: cv });
  }
  return out;
}

// Mainnet principals the contracts reference (for simnet/tests) that already
// exist on the node under a DIFFERENT address: remapped in source, never
// republished. (boot pox-5 mainnet->testnet; mainnet sBTC -> the node's sBTC.)
const NODE_REMAP = {
  SP000000000000000000002Q6VF78: 'ST000000000000000000002AMW42H',
  SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4: 'SN3R84XZYA63QS28932XQF3G1J8R9PC3W76P9CSQS',
};

// Build the ordered publish list: republished requirements first (only those the
// node lacks, e.g. the SIP-010 trait), then local contracts. All sources are
// rewritten: NODE_REMAP principals point at their on-node address, and any
// republished requirement's principal points at the deployer.
function buildUnits() {
  const remap = { ...NODE_REMAP }; // principal -> on-node (or deployer) address
  const reqUnits = [];
  for (const id of parseRequirements()) {
    const [principal, name] = id.split('.');
    // sBTC & co. already live on the node (via NODE_REMAP) — remap only, skip.
    if (NODE_REMAP[principal]) continue;
    remap[principal] = deployer;
    const meta = JSON.parse(readFileSync(`.cache/requirements/${id}.json`, 'utf8'));
    reqUnits.push({
      name,
      source: readFileSync(`.cache/requirements/${id}.clar`, 'utf8'),
      clarityVersion: Number(String(meta.clarity_version).replace(/\D/g, '')) || 1,
    });
  }
  const applyRemap = (src) =>
    Object.entries(remap).reduce((s, [from, to]) => s.split(from).join(to), src);
  const localUnits = parseContracts().map((c) => ({
    name: c.name,
    source: applyRemap(readFileSync(c.path, 'utf8')),
    clarityVersion: c.clarityVersion,
  }));
  reqUnits.forEach((u) => { u.source = applyRemap(u.source); });
  return [...reqUnits, ...localUnits];
}

async function fund() {
  let { balance } = await accountState();
  for (let i = 0; balance < MIN_USTX && i < 8; i++) {
    console.log(`  faucet (${balance} < ${MIN_USTX}) ...`);
    await fetch(`${API_URL}/extended/v1/faucets/stx?address=${deployer}`, { method: 'POST' }).catch(() => {});
    await sleep(12000);
    ({ balance } = await accountState());
  }
  if (balance < MIN_USTX) { console.error('deployer underfunded after faucet'); process.exit(1); }
}

async function waitFor(name) {
  for (let i = 0; i < 60; i++) { if (await contractExists(name)) return true; await sleep(5000); }
  return false;
}

const units = buildUnits();
console.log(`deployer ${deployer} | chain ${CHAIN_ID} | node ${API_URL}`);
console.log(`publishing: ${units.map((u) => u.name).join(', ')}`);
await fund();

let { nonce } = await accountState();
for (const u of units) {
  if (await contractExists(u.name)) { console.log(`= ${u.name} exists, skip`); continue; }
  const tx = await makeContractDeploy({
    contractName: u.name,
    codeBody: u.source,
    clarityVersion: u.clarityVersion,
    senderKey: key,
    network, client, nonce, fee: FEE,
    postConditionMode: 'allow',
  });
  const res = await broadcastTransaction({ transaction: tx, network, client });
  if (res.error) { console.error(`x ${u.name}:`, JSON.stringify(res)); process.exit(1); }
  console.log(`-> ${u.name} clarity${u.clarityVersion} nonce ${nonce} txid 0x${res.txid}`);
  nonce++;
  if (!(await waitFor(u.name))) { console.error(`x ${u.name} not confirmed in time`); process.exit(1); }
  console.log(`   ok ${u.name}`);
}
console.log('deploy complete.');
