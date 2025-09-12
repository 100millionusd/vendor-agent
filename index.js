import express from "express";
import multer from "multer";
import pkg from "pg";
import OpenAI from "openai";
import fs from "fs";
import { File } from "node:buffer";   // ✅ Use File object
import dotenv from "dotenv";

dotenv.config();
const { Pool } = pkg;
const app = express();
const upload = multer({ dest: "uploads/" });
const port = process.env.PORT || 3000;

// === Database (Railway Postgres) ===
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// === OpenAI Client ===
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * -------------------------------
 * Agent 2 – Vendor Offer Checker
 * -------------------------------
 */
app.post("/upload-offer", upload.single("file"), async (req, res) => {
  try {
    // 1. Wrap PDF in File object to preserve extension
    const pdfBuffer = fs.readFileSync(req.file.path);
    const openaiFile = new File([pdfBuffer], req.file.originalname);

    const file = await client.files.create({
      file: openaiFile,
      purpose: "assistants"
    });
    console.log("📄 Uploaded file to OpenAI:", file);

    // 2. Create a thread
    const thread = await client.beta.threads.create();
    console.log("🧵 Created thread:", thread);

    if (!thread?.id) {
      throw new Error("Thread creation failed — no ID returned.");
    }

    // 3. Add vendor message (attach PDF with tools)
    await client.beta.threads.messages.create(thread.id, {
      role: "user",
      content:
        "Analyze this vendor offer and compare with DB reference prices. Always return JSON with fields: item, vendor_price, reference_price, difference_percent, verdict.",
      attachments: [
        {
          file_id: file.id,
          tools: [{ type: "file_search" }]
        }
      ]
    });
    console.log("📨 Added vendor message to thread:", thread.id);

    // 4. Run the Vendor Assistant
    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.VENDOR_AGENT_ID
    });
    console.log("🏃 Created run:", run);

    if (!run?.id) {
      throw new Error("Run creation failed — no ID returned.");
    }

    // Poll until run is finished
    let runStatus;
    do {
      runStatus = await client.beta.threads.runs.retrieve(thread.id, run.id);
      console.log("⏳ Run status:", runStatus.status);
    } while (runStatus.status !== "completed");

    // 5. Get the AI analysis
    const messages = await client.beta.threads.messages.list(thread.id);
    const aiReply = messages.data[0]?.content[0]?.text?.value || "No reply";
    console.log("🤖 AI Reply:", aiReply);

    // 6. Save into Postgres
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
