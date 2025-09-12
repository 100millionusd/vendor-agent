import express from "express";
import multer from "multer";
import pkg from "pg";
import OpenAI from "openai";
import fs from "fs";
import { File } from "node:buffer";
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pkg;
const app = express();
const upload = multer({ dest: "uploads/" });
const port = process.env.PORT || 3000;

// ensure uploads dir exists (Railway ephemeral fs)
try { fs.mkdirSync("uploads", { recursive: true }); } catch {}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

/**
 * -------------------------------
 * Agent 2 – Vendor Offer Checker
 * -------------------------------
 */
app.post("/upload-offer", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // 1) Wrap PDF in File (preserves .pdf name for OpenAI)
    const pdfBuffer = fs.readFileSync(req.file.path);
    const openaiFile = new File([pdfBuffer], req.file.originalname);

    const uploaded = await client.files.create({
      file: openaiFile,
      purpose: "assistants"
    });
    console.log("📄 OpenAI file:", uploaded.id, uploaded.filename);

    // 2) Create-and-Run: avoids separate thread creation
    const run = await client.beta.threads.createAndRun({
      assistant_id: process.env.VENDOR_AGENT_ID,
      thread: {
        messages: [
          {
            role: "user",
            content:
              "Analyze this vendor offer and compare with DB reference prices. Always return JSON with fields: item, vendor_price, reference_price, difference_percent, verdict.",
            attachments: [
              {
                file_id: uploaded.id,
                tools: [{ type: "file_search" }]
              }
            ]
          }
        ]
      },
      tool_choice: "auto",
      parallel_tool_calls: true,
      response_format: { type: "text" }
    });

    const threadId = run.thread_id;
    if (!threadId) {
      throw new Error("createAndRun did not return thread_id");
    }
    console.log("🧵 threadId:", threadId, "🏃 runId:", run.id);

    // 3) Poll run until completed
    let status;
    do {
      const current = await client.beta.threads.runs.retrieve(threadId, run.id);
      status = current.status;
      console.log("⏳ Run status:", status);
      if (status === "failed" || status === "cancelled" || status === "expired") {
        throw new Error(`Run ended with status: ${status}`);
      }
      if (status !== "completed") await sleep(1200);
    } while (status !== "completed");

    // 4) Fetch assistant reply
    const msgs = await client.beta.threads.messages.list(threadId, { limit: 10 });
    // find most recent assistant message
    const assistantMsg = msgs.data.find(m => m.role === "assistant") || msgs.data[0];
    const aiReply =
      assistantMsg?.content?.[0]?.text?.value ||
      assistantMsg?.content?.[0]?.[assistantMsg?.content?.[0]?.type]?.value ||
      "No reply";

    console.log("🤖 AI Reply:", aiReply);

    // 5) Save into Postgres (your existing table)
    await pool.query(
      "INSERT INTO offer_id (file_url, parsed_data, ai_analysis) VALUES ($1, $2, $3)",
      [req.file.originalname, "PDF handled by Assistant API", aiReply]
    );
    console.log("💾 Saved analysis to DB");

    res.json({ success: true, analysis: aiReply });
  } catch (err) {
    console.error("❌ Agent 2 error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 Vendor Agent running on port ${port}`);
});
