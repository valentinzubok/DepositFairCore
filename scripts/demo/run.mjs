// DepositFair lifecycle on Studio Dev. State-aware and resumable: every step has a label, done
// steps are skipped on a rerun, waits are on deadlines read from the chain, rulings are resent
// when the stored state did not move. Usage: ADDR=0x... node run.mjs
import fs from "fs";
import { createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { acct, rpc, bal, call, read, retry, GEN, fmt } from "./lib.mjs";

const URLS = Object.fromEntries(
  fs.readFileSync("urls.txt", "utf8") /* copy of fixtures/report-urls.txt */.trim().split("\n").map((l) => l.split(" ")),
);
const MI12 = URLS["flat-12-move-in.md"];
const MO12 = URLS["flat-12-move-out.md"];
const MI7 = URLS["flat-7-move-in.md"];
const LONG = "https://httpbin.org/range/4000";

const T = acct("tenant");
const L = acct("landlord");
const S = acct("stranger");
const WHO = { [T.address]: "tenant", [L.address]: "landlord", [S.address]: "stranger" };

const DONE_F = "done.json";
const done = fs.existsSync(DONE_F) ? JSON.parse(fs.readFileSync(DONE_F, "utf8")) : {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);
const J = async (fn, args) => JSON.parse(await read(fn, args));
const reader = createClient({ chain: studioDevnet });

async function payloadOf(hash) {
  try {
    const tx = await retry(() => reader.getTransaction({ hash }));
    const s = JSON.stringify(tx, (k, v) => (typeof v === "bigint" ? v.toString() : v));
    const m = s.match(/"payload":"((?:[^"\\]|\\.){0,400})/);
    return m ? m[1] : "";
  } catch (e) {
    return "";
  }
}

let n = Object.keys(done).length;
async function step(label, note, who, fn, args = [], value = 0n) {
  if (done[label]) return done[label];
  const r = await call(who, fn, args, value);
  const payload = await payloadOf(r.hash);
  n += 1;
  const row = { n, label, note, sender: WHO[who.address], from: who.address, fn, args: args.map((a) => String(a).slice(0, 80)), value: fmt(value), hash: r.hash, exec: r.exec, payload, at: new Date().toISOString() };
  fs.appendFileSync("steps.jsonl", JSON.stringify(row) + "\n");
  console.log(`#${n} ${label} ${r.exec} ${payload.slice(0, 160)}`);
  done[label] = row;
  fs.writeFileSync(DONE_F, JSON.stringify(done, null, 1));
  return row;
}

async function waitUntil(ts, why) {
  const t = Number(ts) + 25;
  while (nowS() < t) {
    console.log(`waiting ${t - nowS()} s for ${why}`);
    await sleep(Math.min(30000, (t - nowS()) * 1000));
  }
}

for (const a of [T, L, S]) {
  if ((await bal(a.address)) < 30n * GEN) await retry(() => rpc("sim_fundAccount", [a.address, 100e18]));
}
console.log("tenant", T.address, "landlord", L.address, "stranger", S.address);
fs.writeFileSync("accounts.json", JSON.stringify({ tenant: T.address, landlord: L.address, stranger: S.address }, null, 1));

const ITEMS12 = JSON.stringify([
  { id: "wall-paint", description: "Living room walls: paint and plaster", max_deduction: String(GEN) },
  { id: "carpet", description: "Living room carpet", max_deduction: String((8n * GEN) / 10n) },
  { id: "oven", description: "Kitchen oven", max_deduction: String(GEN / 2n) },
  { id: "window", description: "Kitchen window glass", max_deduction: String(GEN) },
]);
const ITEMS7 = JSON.stringify([{ id: "keys", description: "Two sets of keys", max_deduction: String(GEN / 5n) }]);
const ITEMS9 = JSON.stringify([{ id: "walls", description: "Walls", max_deduction: String(GEN / 2n) }]);

// 1. flat-9 first: its accept window is 300 s, the refusals must land inside it
await step("open-flat-9", "flat-9: 1 GEN, move-in URL serves 4000 chars, accept window 300 s", T, "open_deposit",
  ["flat-9", L.address, "Flat 9, 4 Harbour Street", ITEMS9, LONG, "300", "900", "600", "1", "60"], GEN);
await step("freeze-flat-9", "flat-9 move-in page has 4000 chars", T, "freeze_move_in", ["flat-9"]);
await step("expire-flat-9-early", "expire flat-9 before its accept deadline", S, "expire", ["flat-9"]);

// 2. flat-7: open, freeze, accept (accept window 600 s, claim window 900 s)
await step("open-flat-7", "flat-7: 1 GEN, claim window 900 s, for the no-claim refund", T, "open_deposit",
  ["flat-7", L.address, "Flat 7, 4 Harbour Street", ITEMS7, MI7, "600", "900", "600", "1", "60"], GEN);
await step("freeze-flat-7", "tenant freezes the flat-7 move-in report", T, "freeze_move_in", ["flat-7"]);
const h7 = (await J("get_terms", ["flat-7"])).terms_hash;
await step("accept-flat-7", "landlord accepts flat-7 by its terms hash", L, "accept_deposit", ["flat-7", h7]);

// 3. dust and flat-12
await step("open-dust", "dust-1: 0.5 GEN, below the 1 GEN minimum: refused, credited", T, "open_deposit",
  ["dust-1", L.address, "Flat 3", ITEMS7, MI7, "600", "900", "600", "1", "60"], GEN / 2n);
await step("open-flat-12", "flat-12: 3 GEN, 4 items, 3 ruling rounds 60 s apart", T, "open_deposit",
  ["flat-12", L.address, "Flat 12, 4 Harbour Street", ITEMS12, MI12, "1800", "3600", "7200", "3", "60"], 3n * GEN);
await step("freeze-flat-12", "tenant freezes the flat-12 move-in report", T, "freeze_move_in", ["flat-12"]);
const h12 = (await J("get_terms", ["flat-12"])).terms_hash;
await step("accept-flat-12-stranger", "a stranger tries to accept flat-12", S, "accept_deposit", ["flat-12", h12]);
await step("accept-flat-12-badhash", "landlord accepts with a wrong terms hash", L, "accept_deposit", ["flat-12", "0".repeat(64)]);
await step("accept-flat-12", "landlord accepts flat-12 by its terms hash", L, "accept_deposit", ["flat-12", h12]);

// 5. flat-12 claim: refused ones, then the claim
await step("claim-flat-12-tenant", "the tenant tries to file the claim", T, "file_claim", ["flat-12", MO12, JSON.stringify(["carpet"])]);
await step("claim-flat-12-unknown", "landlord claims an item not on the price list", L, "file_claim", ["flat-12", MO12, JSON.stringify(["carpet", "sofa"])]);
await step("claim-flat-12", "landlord files the claim: wall-paint, carpet, oven", L, "file_claim", ["flat-12", MO12, JSON.stringify(["wall-paint", "carpet", "oven"])]);
await step("rule-flat-12-window", "rule an item that was not claimed", S, "rule", ["flat-12", "window"]);
await step("expire-flat-12-early", "expire flat-12 before its final deadline", S, "expire", ["flat-12"]);

// 6. Rulings: 3 rounds per item, resend when the item state did not move
const ITEMS = ["wall-paint", "carpet", "oven"];
for (let k = 1; k <= 3; k++) {
  for (const item of ITEMS) {
    for (let attempt = 1; ; attempt++) {
      const st = await J("get_item", ["flat-12", item]);
      if (st.rounds >= k) break;
      if (st.rounds > 0) await waitUntil(st.last_round_at + 60, `${item} interval`);
      const label = `rule-flat-12-${item}-r${k}-a${attempt}`;
      await step(label, `ruling round ${k} of ${item}${attempt > 1 ? ` (resend ${attempt})` : ""}`, S, "rule", ["flat-12", item]);
      const after = await J("get_item", ["flat-12", item]);
      if (after.rounds >= k) {
        const rr = await J("get_round", ["flat-12", item, k]);
        done[label].round = rr;
        fs.writeFileSync(DONE_F, JSON.stringify(done, null, 1));
        fs.appendFileSync("rounds.jsonl", JSON.stringify(rr) + "\n");
        console.log(`   -> ${item} r${k}: ${rr.finding} (${rr.reason})`);
        break;
      }
      console.log(`   -> ${item} r${k}: state did not move, resending`);
      if (attempt >= 6) throw new Error("too many resends");
      await sleep(10000);
    }
    if (k === 1 && item === "carpet") {
      await step("settle-flat-12-early", "settle before every item is ruled", S, "settle", ["flat-12"]);
    }
  }
}

// 7. Settlement and withdrawals
await step("settle-flat-12", "settle flat-12: the code sums the fixed amounts", S, "settle", ["flat-12"]);
await step("withdraw-flat-12-stranger", "a stranger tries to withdraw", S, "withdraw", ["flat-12"]);
await step("withdraw-flat-12-landlord", "landlord takes the deduction", L, "withdraw", ["flat-12"]);
await step("withdraw-flat-12-tenant", "tenant takes the rest", T, "withdraw", ["flat-12"]);
await step("withdraw-flat-12-tenant-again", "tenant withdraws a second time", T, "withdraw", ["flat-12"]);

// 8. flat-9: never accepted -> refund
const d9 = await J("get_deposit", ["flat-9"]);
await waitUntil(d9.accept_deadline, "flat-9 accept deadline");
await step("expire-flat-9", "flat-9 never accepted: refund", S, "expire", ["flat-9"]);
await step("withdraw-flat-9-tenant", "tenant takes flat-9 back", T, "withdraw", ["flat-9"]);

// 9. flat-7: no claim -> refund
const d7 = await J("get_deposit", ["flat-7"]);
await waitUntil(d7.claim_deadline, "flat-7 claim deadline");
await step("claim-flat-7-late", "landlord files a claim after the claim deadline", L, "file_claim", ["flat-7", MI7, JSON.stringify(["keys"])]);
await step("expire-flat-7", "flat-7 no claim by the deadline: full refund", S, "expire", ["flat-7"]);
await step("withdraw-flat-7-landlord", "landlord tries to withdraw from a full refund", L, "withdraw", ["flat-7"]);
await step("withdraw-flat-7-tenant", "tenant takes flat-7 back", T, "withdraw", ["flat-7"]);

// 10. Credit
await step("withdraw-credit-tenant", "tenant takes back the refused 0.5 GEN", T, "withdraw_credit", []);

console.log("balance", await read("get_balance", []));
for (const id of ["flat-12", "flat-7", "flat-9"]) console.log(id, await read("get_deposit", [id]));
console.log("credit", await read("get_credit", [T.address]));
console.log("DONE");
