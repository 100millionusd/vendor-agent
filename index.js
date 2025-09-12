import express from "express";
import multer from "multer";
import pkg from "pg";
import OpenAI from "openai";
import fs from "fs";
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
 * Uploads vendor PDF, parses it, and checks against DB.
 */
app.post("/upload-offer", upload.single("file"), async (req, res) => {
  try {
    // 1. Upload PDF to OpenAI
    const file = await client.files.create({
      file: fs.createReadStream(req.file.path),
      purpose: "assistants"
    });

    // 2. Create a thread
    const thread = await client.beta.threads.create();

    // 3. Add vendor message (attach PDF)
    await client.beta.threads.messages.create(thread.id, {
      role: "user",
      content: "Analyze this vendor offer and compare with DB reference prices.",
      attachments: [{ file_id: file.id }]
    });

    // 4. Run the Vendor Assistant
    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: process.env.VENDOR_AGENT_ID
    });

    // Poll until run is finished
    let runStatus;
    do {
      runStatus = await client.beta.threads.runs.retrieve(thread.id, run.id);
    } while (runStatus.status !== "completed");

    // 5. Get the AI analysis
    const messages = await client.beta.threads.messages.list(thread.id);
    const aiReply = messages.data[0].content[0].text.value;

    // 6. Save into Postgres
    await pool.query(
      "INSERT INTO vendor_offers (file_url, parsed_data, ai_analysis) VALUES ($1, $2, $3)",
      [req.file.path, "PDF handled by Assistant API", aiReply]
    );

    res.json({ success: true, analysis: aiReply });
  } catch (err) {
    console.error("Agent 2 error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 Vendor Agent running on port ${port}`);
});
