// worker.js — Agent 2 background worker
// -------------------------------------
import "dotenv/config";
import OpenAI from "openai";
import pg from "pg";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Railway Postgres usually requires SSL
});

async function analyzeBid(bid) {
  const prompt = `
  Analyze this vendor bid in Bolivia construction context:

  Vendor: ${bid.vendor_name}
  Price (USD): ${bid.price_usd}
  Price (BOB): ${bid.price_bol}
  Days: ${bid.days}
  Notes: ${bid.notes || "N/A"}

  Return ONLY valid JSON with this shape:
  {
    "verdict": "Fair | Overpriced | Suspicious",
    "reasoning": "short explanation",
    "suggestions": ["...","..."]
  }
  `;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
  });

  try {
    return JSON.parse(resp.choices[0].message.content || "{}");
  } catch {
    return {
      verdict: "Unknown",
      reasoning: "AI returned invalid JSON",
      suggestions: [],
    };
  }
}

async function runWorker() {
  console.log("🚀 Agent 2 Worker started. Watching for new bids...");

  while (true) {
    try {
      // Find the next unanalyzed bid
      const { rows } = await pool.query(
        `SELECT * FROM bids WHERE ai_analysis IS NULL ORDER BY created_at ASC LIMIT 1`
      );

      if (rows.length === 0) {
        await new Promise((r) => setTimeout(r, 5000)); // Wait before retry
        continue;
      }

      const bid = rows[0];
      console.log(`⚙️ Analyzing bid ${bid.bid_id} for proposal ${bid.proposal_id}`);

      // Run OpenAI analysis
      const analysis = await analyzeBid(bid);

      // Save result back into database
      await pool.query(
        `UPDATE bids SET ai_analysis = $1 WHERE bid_id = $2`,
        [analysis, bid.bid_id]
      );

      console.log(`✅ Stored AI analysis for bid ${bid.bid_id}`);
    } catch (err) {
      console.error("❌ Worker error:", err);
      await new Promise((r) => setTimeout(r, 10000)); // Wait longer on error
    }
  }
}

// Start worker
runWorker();
