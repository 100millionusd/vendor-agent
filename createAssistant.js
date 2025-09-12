import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function createAssistant() {
  const assistant = await client.beta.assistants.create({
    name: "Vendor Offer Checker",
    instructions: `
You are an AI agent that checks vendor offers for construction projects in Bolivia.
Compare vendor prices against reference DB values and flag if overpriced or suspicious.
Always return JSON with fields: item, vendor_price, reference_price, difference_percent, verdict.
`,
    model: "gpt-4.1",
    file_search: true
  });

  console.log("✅ Assistant created with ID:", assistant.id);
}

createAssistant();
