// worker.js — Agent 2 background worker
// -------------------------------------
import dotenv from "dotenv";
import pkg from "pg";
import OpenAI from "openai";

dotenv.config();
const { Pool } = pkg;

// ====== DB connection ======
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Railway Postgres usually requires SSL
});

// ====== OpenAI client ======
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ====== Core: Analyze a bid ======
async function analyzeBid(bid) {
  const prompt = `
  Analyze the following vendor bid:
  Vendor: ${bid.vendorname}
  Price: $${bid.priceusd}
  Days: ${bid.days}
  Notes: ${bid.notes || "N/A"}
  Wallet: ${bid.walletaddress}
  Stablecoin: ${bid.preferredstablecoin}

  Return a JSON object with fields:
  - clarity (1-10)
  - feasibility (1-10)
  - budget_risk (low/medium/high)
  - timeline_risk (low/medium/high)
  - issues (list of concerns)
  - summary (short vendor-facing explanation)
  `;

  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    return JSON.parse(resp.choices[0].message.content || "{}");
  } catch (err) {
    console.error("❌ AI analysis failed:", err);
    return { error: err.message };
  }
}

// ====== Worker loop ======
async function runWorker() {
  console.log("🤖 Agent 2 worker started…");

  while (true) {
    try {
      // 1. Find unprocessed bids (aiAnalysis is NULL)
      const { rows } = await pool.query(
        `SELECT * FROM bids WHERE aiAnalysis IS NULL ORDER BY createdat ASC LIMIT 1`
      );

      if (rows.length === 0) {
        await new Promise((r) => setTimeout(r, 10000)); // wait 10s
        continue;
      }

      const bid = rows[0];
      console.log(`🔍 Analyzing bid ${bid.bidid} for proposal ${bid.proposalid}`);

      // 2. Run AI analysis
      const analysis = await analyzeBid(bid);

      // 3. Save result into DB
      await pool.query(
        `UPDATE bids SET aiAnalysis = $1 WHERE bidId = $2`,
        [analysis, bid.bidid]
      );

      console.log(`✅ Stored AI analysis for bid ${bid.bidid}`);
    } catch (err) {
      console.error("❌ Worker error:", err);
      await new Promise((r) => setTimeout(r, 15000)); // pause longer on error
    }
  }
}

// ====== Start worker ======
runWorker().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
