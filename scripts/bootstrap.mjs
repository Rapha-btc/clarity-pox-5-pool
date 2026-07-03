#!/usr/bin/env node
//
// Bootstrap the sBTC liquid-staking pool on the private Hiro node (chain id 256),
// AFTER scripts/deploy-testnet.sh has published the contracts. All txs are signed
// with @stacks/transactions (Clarinet can't sign chain id 256).
//
//   node scripts/bootstrap.mjs register        # register-self for each signer-manager on pox-5
//   node scripts/bootstrap.mjs bind            # assign-vault + vault.set-pool for each signer
//   node scripts/bootstrap.mjs list            # (optional) list-signer in the discovery registry
//   node scripts/bootstrap.mjs fund-sbtc       # sBTC faucet -> DEPOSITOR (0.05 sBTC/call)
//   node scripts/bootstrap.mjs fund-staker     # STX faucet -> DEPOSITOR (500 STX/call; covers fees + bond collateral)
//   node scripts/bootstrap.mjs deposit         # pool.deposit (needs sBTC + STX on the depositor)
//   node scripts/bootstrap.mjs register-cohort # pool.register-cohort (needs an allowlisted bond)
//   node scripts/bootstrap.mjs bond-info       # read-only: bond params + the vault's allowlist entry
//   node scripts/bootstrap.mjs pending-rewards # read-only: per-cycle unclaimed sBTC (signer + staker)
//   REWARD_CYCLE=<n> node scripts/bootstrap.mjs claim-rewards         # signer pulls its sBTC for the cycle
//   REWARD_CYCLE=<n> node scripts/bootstrap.mjs claim-staker-rewards  # pay the vault its share
//   AMOUNT_SATS=<n>  node scripts/bootstrap.mjs fold-rewards          # record sBTC into the redemption rate
//   AMOUNT_SATS=<n>  node scripts/bootstrap.mjs unstake-cohort        # unwind sBTC from the bond (exit)
//   SHARES=<n>       node scripts/bootstrap.mjs withdraw              # depositor redeems sBTC + STX
//
// pox-5 = ST000000000000000000002AMW42H.pox-5 ; sBTC = SN3R84…sbtc-token (both live on the node).
//
// Topology (one signer-manager per vault; operator = deployer = mnemonic acct 0):
//   signer-manager-1 <-> vault-1   signer = acct 1, depositor = acct 3
//   signer-manager-2 <-> vault-2   signer = acct 2, depositor = acct 4
//
// Keys come from the mnemonic in settings/Testnet.toml (or DEPLOYER_MNEMONIC).
//
// Env: API_URL, CHAIN_ID(256), FEE(100000), AUTH_ID(1),
//      SM (1|2, default 1) picks the signer-manager/vault/depositor pair,
//      DEPOSITOR_KEY (hex; overrides the pair's depositor account),
//      SBTC_SATS(1000000), USTX(min for the bond), BOND_INDEX(0),
//      REWARD_CYCLE, BOND_PERIODS (csv), STAKER_ADDR, AMOUNT_SATS, SHARES.
//
import {
  Cl, signStructuredData, privateKeyToPublic, getAddressFromPrivateKey,
  makeContractCall, broadcastTransaction,
  serializeCV, deserializeCV, cvToValue,
} from '@stacks/transactions';
import { STACKS_TESTNET } from '@stacks/network';
import { resolveDeployerKey, resolveKeyAtIndex } from './_wallet.mjs';

const API_URL = process.env.API_URL ?? 'https://api.private-1.hiro.so';
const CHAIN_ID = BigInt(process.env.CHAIN_ID ?? '256');
const FEE = BigInt(process.env.FEE ?? '100000');
const AUTH_ID = BigInt(process.env.AUTH_ID ?? '1');
const POX5 = 'ST000000000000000000002AMW42H';
const client = { baseUrl: API_URL };
const net = { network: { ...STACKS_TESTNET, chainId: Number(CHAIN_ID) }, client };
const hex = (b) => b.replace(/^0x/, '');

// signer-manager <-> vault pairs (signer key from the given mnemonic account index)
const PAIRS = [
  { sm: 'signer-manager-1', vault: 'vault-1', signerIndex: 1, depositorIndex: 3 },
  { sm: 'signer-manager-2', vault: 'vault-2', signerIndex: 2, depositorIndex: 4 },
];

const deployerKey = await resolveDeployerKey();
const deployer = getAddressFromPrivateKey(deployerKey, 'testnet');
const cp = (name) => Cl.contractPrincipal(deployer, name);

async function nonceOf(addr) {
  const r = await fetch(`${API_URL}/v2/accounts/${addr}?proof=0`).then((x) => x.json());
  return Number(r.nonce);
}

// senderKey-aware sender so a batch from one principal increments the nonce locally
function sender(key) {
  const addr = getAddressFromPrivateKey(key, 'testnet');
  let n = null;
  return async (fn, args, contract, label) => {
    if (n === null) n = await nonceOf(addr);
    const [cAddr, cName] = contract.split('.');
    const tx = await makeContractCall({
      contractAddress: cAddr, contractName: cName, functionName: fn,
      functionArgs: args, senderKey: key, nonce: n, fee: FEE,
      postConditionMode: 'allow', ...net,
    });
    const res = await broadcastTransaction({ transaction: tx, ...net });
    if (res.error) { console.error(`x ${label}:`, JSON.stringify(res)); process.exit(1); }
    console.log(`-> ${label} (nonce ${n}) txid 0x${res.txid}`);
    n++;
    return res.txid;
  };
}

function grantSig(signerManagerPrincipal, signerKey) {
  const domain = Cl.tuple({
    name: Cl.stringAscii('pox-5-signer'),
    version: Cl.stringAscii('1.0.0'),
    'chain-id': Cl.uint(CHAIN_ID),
  });
  const message = Cl.tuple({
    topic: Cl.stringAscii('grant-authorization'),
    'signer-manager': Cl.principal(signerManagerPrincipal),
    'auth-id': Cl.uint(AUTH_ID),
  });
  return hex(signStructuredData({ message, domain, privateKey: signerKey }));
}

async function register() {
  const send = sender(deployerKey); // admin of each signer-manager
  for (const p of PAIRS) {
    const signerKey = await resolveKeyAtIndex(p.signerIndex);
    const pubKey = hex(privateKeyToPublic(signerKey));
    const smPrincipal = `${deployer}.${p.sm}`;
    console.log(`register ${p.sm}: signer-key=0x${pubKey} (acct ${p.signerIndex}) auth-id=${AUTH_ID}`);
    await send('register-self',
      [cp(p.sm), Cl.bufferFromHex(pubKey), Cl.uint(AUTH_ID), Cl.bufferFromHex(grantSig(smPrincipal, signerKey))],
      smPrincipal, `${p.sm}.register-self`);
  }
}

async function bind() {
  const send = sender(deployerKey); // operator + vault deployer
  for (const p of PAIRS) {
    await send('assign-vault', [Cl.principal(`${deployer}.${p.sm}`), cp(p.vault)], `${deployer}.pool`, `pool.assign-vault(${p.sm}->${p.vault})`);
    await send('set-pool', [Cl.principal(`${deployer}.pool`)], `${deployer}.${p.vault}`, `${p.vault}.set-pool`);
  }
}

async function list() {
  const send = sender(deployerKey);
  for (const p of PAIRS) {
    await send('list-signer', [cp(p.sm), Cl.stringUtf8(p.sm), Cl.uint(0)], `${deployer}.pool`, `pool.list-signer(${p.sm})`);
  }
}

function pickPair() { return PAIRS[(Number(process.env.SM ?? '1')) - 1]; }

async function depositorKeyFor(p) {
  return (process.env.DEPOSITOR_KEY ?? await resolveKeyAtIndex(p.depositorIndex)).replace(/^0x/, '');
}

async function fundSbtc() {
  const p = pickPair();
  const addr = getAddressFromPrivateKey(await depositorKeyFor(p), 'testnet');
  const r = await fetch(`${API_URL}/extended/v1/faucets/sbtc?address=${addr}`, { method: 'POST' }).then((x) => x.json());
  console.log(`sbtc faucet -> ${addr} (acct ${p.depositorIndex}):`, JSON.stringify(r));
}

// STX faucet -> the pair's depositor (the account that stakes into the bond via
// pool.deposit). The regular faucet (500 STX/call, no stacking=true) is plenty
// for fees + the bond's STX collateral, unlike fastpool-pox-5's STX-only stake
// which needs the 50k stacking minimum.
async function fundStx() {
  const p = pickPair();
  const addr = getAddressFromPrivateKey(await depositorKeyFor(p), 'testnet');
  const r = await fetch(`${API_URL}/extended/v1/faucets/stx?address=${addr}`, { method: 'POST' }).then((x) => x.json());
  console.log(`stx faucet -> ${addr} (acct ${p.depositorIndex}):`, JSON.stringify(r));
}

async function deposit() {
  const p = pickPair();
  const key = await depositorKeyFor(p);
  const sbtc = BigInt(process.env.SBTC_SATS ?? '1000000');     // 0.01 sBTC
  const ustx = BigInt(process.env.USTX ?? '10000000');                // STX collateral the bond requires
  if (ustx === 0n) console.warn('! USTX=0 — set USTX to the STX collateral the bond needs');
  const send = sender(key);
  await send('deposit', [cp(p.sm), cp(p.vault), Cl.uint(sbtc), Cl.uint(ustx)], `${deployer}.pool`, `pool.deposit(${p.sm},${p.vault},${sbtc},${ustx})`);
}

async function registerCohort() {
  const p = pickPair();
  const bondIndex = BigInt(process.env.BOND_INDEX ?? '0');
  const send = sender(deployerKey); // operator
  await send('register-cohort', [cp(p.vault), Cl.uint(bondIndex), cp(p.sm), Cl.none()], `${deployer}.pool`, `pool.register-cohort(${p.vault},bond ${bondIndex})`);
}

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`set ${k}`); process.exit(1); } return v; };

// signer-manager-N pulls its sBTC reward for REWARD_CYCLE into itself
// (signer-manager.claim-rewards). Permissionless; signed by the deployer.
// BOND_PERIODS = comma-separated bond indices (the bond's distribution periods).
async function claimRewards() {
  const p = pickPair();
  const cycle = BigInt(need('REWARD_CYCLE'));
  const bondPeriods = (process.env.BOND_PERIODS ?? '').split(',').filter(Boolean).map((n) => Cl.uint(BigInt(n)));
  const send = sender(deployerKey);
  await send('claim-rewards', [Cl.list(bondPeriods), Cl.uint(cycle)], `${deployer}.${p.sm}`, `${p.sm}.claim-rewards(${cycle})`);
}

// Pay the vault (the bonded staker) its sBTC share for REWARD_CYCLE
// (signer-manager.claim-staker-rewards). Permissionless; signed by the deployer.
// staker defaults to the pair's vault; STAKER_ADDR overrides. BOND_INDEX optional.
async function claimStakerRewards() {
  const p = pickPair();
  const cycle = BigInt(need('REWARD_CYCLE'));
  const staker = process.env.STAKER_ADDR ?? `${deployer}.${p.vault}`;
  const bondIndex = process.env.BOND_INDEX ? Cl.some(Cl.uint(BigInt(process.env.BOND_INDEX))) : Cl.none();
  const send = sender(deployerKey);
  await send('claim-staker-rewards', [Cl.principal(staker), Cl.uint(cycle), bondIndex], `${deployer}.${p.sm}`, `${p.sm}.claim-staker-rewards(${staker},${cycle})`);
}

// Operator records AMOUNT_SATS of sBTC (already delivered to the vault) into the
// pool's redemption rate (pool.fold-rewards).
async function foldRewards() {
  const p = pickPair();
  const amount = BigInt(need('AMOUNT_SATS'));
  const send = sender(deployerKey); // operator
  await send('fold-rewards', [cp(p.vault), Cl.uint(amount)], `${deployer}.pool`, `pool.fold-rewards(${p.vault},${amount})`);
}

// Operator unwinds AMOUNT_SATS of sBTC from the vault's bond back into the vault
// (pool.unstake-cohort) — the bond-pool equivalent of "unstake".
async function unstakeCohort() {
  const p = pickPair();
  const amount = BigInt(need('AMOUNT_SATS'));
  const send = sender(deployerKey); // operator
  await send('unstake-cohort', [cp(p.vault), cp(p.sm), Cl.uint(amount)], `${deployer}.pool`, `pool.unstake-cohort(${p.vault},${amount})`);
}

// Depositor burns SHARES of the liquid token to redeem sBTC + their STX
// (pool.withdraw). Signed by the pair's depositor (acct 3/4) or DEPOSITOR_KEY.
async function withdraw() {
  const p = pickPair();
  const shares = BigInt(need('SHARES'));
  const send = sender(await depositorKeyFor(p)); // depositor = tx-sender
  await send('withdraw', [cp(p.vault), Cl.uint(shares)], `${deployer}.pool`, `pool.withdraw(${p.vault},${shares})`);
}

// Read-only `call-read` against pox-5. Returns the decoded result (cvToValue with
// strictJsonCompat: uints are strings, `(none)` decodes to null). Signs nothing.
async function callRead(fn, argCVs) {
  const body = JSON.stringify({ sender: deployer, arguments: argCVs.map((cv) => `0x${serializeCV(cv)}`) });
  const r = await fetch(`${API_URL}/v2/contracts/call-read/${POX5}/pox-5/${fn}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  }).then((x) => x.json());
  if (!r.okay) throw new Error(`call-read ${fn}: ${JSON.stringify(r)}`);
  return cvToValue(deserializeCV(r.result), true); // null when the result is (none)
}

// Read-only: the bond's parameters, the pair vault's allowlist entry, the
// registration window, and the STX collateral SBTC_SATS would require. The bond
// allowlist is keyed by the VAULT principal (vault.register-bond calls pox-5
// inside `as-contract?`), so this checks `<deployer>.<vault>`, not the depositor.
// BOND_INDEX (default 0), SM (1|2) picks the vault, SBTC_SATS (default 1000000).
async function bondInfo() {
  const p = pickPair();
  const bondIndex = BigInt(process.env.BOND_INDEX ?? '0');
  const vault = `${deployer}.${p.vault}`;

  const bond = await callRead('get-protocol-bond', [Cl.uint(bondIndex)]);
  if (bond === null) { console.log(`bond ${bondIndex}: NOT SET UP (get-protocol-bond -> none)`); return; }
  const f = (k) => BigInt(bond.value[k].value);
  const stxValueRatio = f('stx-value-ratio');
  const minUstxRatio = f('min-ustx-ratio');

  const startHt = BigInt(await callRead('bond-period-to-burn-height', [Cl.uint(bondIndex)]));
  const burn = BigInt((await fetch(`${API_URL}/v2/pox`).then((r) => r.json())).current_burnchain_block_height);
  const allowance = await callRead('get-bond-allowance', [Cl.uint(bondIndex), Cl.principal(vault)]);

  const sats = BigInt(process.env.SBTC_SATS ?? '1000000');
  const minUstx = (((stxValueRatio * sats) / 100n) * minUstxRatio) / 10000n;

  console.log(`bond ${bondIndex}:`);
  console.log(`  target-rate      ${f('target-rate')} bips`);
  console.log(`  stx-value-ratio  ${stxValueRatio} uSTX/100 sats`);
  console.log(`  min-ustx-ratio   ${minUstxRatio} bips (${Number(minUstxRatio) / 100}%)`);
  console.log(`  register window  start ${startHt}, burn ${burn} -> ${
    burn < startHt ? `OPEN (${startHt - burn} blocks left)` : 'CLOSED (bond already started)'}`);
  console.log(`  ${p.vault} (${vault})`);
  console.log(`  allowlist        ${allowance === null ? 'NOT ALLOWLISTED (get-bond-allowance -> none)' : `max ${allowance.value} sats`}`);
  console.log(`  collateral for ${sats} sats: min ${minUstx} uSTX (${Number(minUstx) / 1e6} STX)`);
}

// Read-only: for the pair's vault, list per-cycle sBTC earned-but-unclaimed
// (signer-level via get-earned, staker-level via get-earned-staker-rewards)
// from the vault's first-reward-cycle through the current (possibly still
// in-progress) cycle. No tx sent -- use this before claim-rewards /
// claim-staker-rewards to know which REWARD_CYCLE values actually have
// something to claim, and with which BOND_PERIODS / BOND_INDEX.
async function pendingRewards() {
  const p = pickPair();
  const vault = `${deployer}.${p.vault}`;
  const signer = `${deployer}.${p.sm}`;

  const membership = await callRead('get-bond-membership', [Cl.principal(vault)]);
  if (membership === null) { console.log(`${p.vault}: not bonded (get-bond-membership -> none)`); return; }
  const bondIndex = BigInt(membership.value['bond-index'].value);
  const firstRewardCycle = BigInt(await callRead('bond-period-to-reward-cycle', [Cl.uint(bondIndex)]));
  const currentCycle = BigInt(await callRead('current-pox-reward-cycle', []));

  console.log(`${p.vault} bond ${bondIndex} (signer ${p.sm}): first-reward-cycle ${firstRewardCycle}, current cycle ${currentCycle}`);
  let totalSigner = 0n;
  let totalStaker = 0n;
  for (let cycle = firstRewardCycle; cycle <= currentCycle; cycle++) {
    const bondIndexOpt = Cl.some(Cl.uint(bondIndex));
    const signerEarned = BigInt(await callRead('get-earned', [Cl.principal(signer), Cl.uint(cycle), bondIndexOpt]));
    const stakerEarned = BigInt(await callRead('get-earned-staker-rewards', [Cl.principal(signer), Cl.uint(cycle), bondIndexOpt, Cl.principal(vault)]));
    const tag = cycle < currentCycle ? 'complete' : 'IN PROGRESS';
    console.log(`  cycle ${cycle} (${tag}): signer ${signerEarned} sats, staker ${stakerEarned} sats`);
    totalSigner += signerEarned;
    totalStaker += stakerEarned;
  }
  console.log(`  TOTAL unclaimed: signer ${totalSigner} sats, staker ${totalStaker} sats`);
  if (totalSigner > 0n) {
    console.log(`  claim with: SM=${process.env.SM ?? '1'} BOND_PERIODS=${bondIndex} REWARD_CYCLE=<cycle> node scripts/bootstrap.mjs claim-rewards`);
    console.log(`          then SM=${process.env.SM ?? '1'} BOND_INDEX=${bondIndex} REWARD_CYCLE=<cycle> node scripts/bootstrap.mjs claim-staker-rewards`);
  }
}

const cmd = process.argv[2];
const cmds = {
  register, bind, list, 'fund-sbtc': fundSbtc, 'fund-staker': fundStx, deposit, 'register-cohort': registerCohort,
  'claim-rewards': claimRewards, 'claim-staker-rewards': claimStakerRewards,
  'fold-rewards': foldRewards, 'unstake-cohort': unstakeCohort, withdraw,
  'bond-info': bondInfo, 'pending-rewards': pendingRewards,
};
if (cmds[cmd]) { console.log(`operator/deployer ${deployer} | chain ${CHAIN_ID}`); await cmds[cmd](); }
else { console.error(`usage: node scripts/bootstrap.mjs <${Object.keys(cmds).join('|')}>`); process.exit(1); }
