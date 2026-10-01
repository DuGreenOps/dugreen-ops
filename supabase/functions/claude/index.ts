// Supabase Edge Function "claude": the app's link to Claude.
// Secrets (Supabase → Edge Functions → Secrets): ANTHROPIC_API_KEY (required), CLAUDE_MODEL (optional).
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const MODEL = Deno.env.get("CLAUDE_MODEL") || "claude-sonnet-5-5";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function callClaude(body: Record<string, unknown>) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("The server has no ANTHROPIC_API_KEY secret set yet.");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 4096, ...body }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Claude API error ${r.status}`);
  return data;
}
const toolInput = (data: any) => data.content?.find((c: any) => c.type === "tool_use")?.input ?? {};
const text = (data: any) => (data.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();

const COMPANY = "Du Green Investments (trading as Du Green Organic), a landscaping company in Eswatini that installs gardens, lawns, hardscaping and irrigation and runs maintenance contracts. Currency is Emalangeni (E / SZL); VAT is 15%.";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") || "";
    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ error: "Please sign in again." }, 401);
    const { data: prof } = await userClient.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
    if (!prof || prof.role === "pending") return json({ error: "Your account does not have access yet." }, 403);

    const body = await req.json();
    const action = body.action;

    // ---------------------------------------------------------- read a supplier quote
    if (action === "extract_quote") {
      const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      const { data: file, error } = await admin.storage.from("quotes").download(body.file_path);
      if (error || !file) throw new Error("Could not open the uploaded quote file.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const name = String(body.file_name || body.file_path).toLowerCase();
      const mime = file.type && file.type !== "application/octet-stream" ? file.type : name.endsWith(".pdf") ? "application/pdf" : name.match(/\.png$/) ? "image/png" : name.match(/\.webp$/) ? "image/webp" : "image/jpeg";
      const b64 = encodeBase64(bytes);
      const block = mime === "application/pdf"
        ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } }
        : { type: "image", source: { type: "base64", media_type: mime, data: b64 } };
      const lines = (body.rfq_lines || []) as any[];
      const data = await callClaude({
        system: `You read supplier quotations for ${COMPANY} Extract prices exactly as printed. Never invent a price. Unit price means price per single unit, excluding VAT unless the quote clearly only shows VAT-inclusive prices (then set vat_included true).`,
        tools: [{
          name: "record_quote",
          description: "Record the prices found on the supplier quote, matched to the RFQ lines.",
          input_schema: {
            type: "object",
            properties: {
              supplier_name: { type: "string" }, quote_ref: { type: "string" }, quote_date: { type: "string", description: "YYYY-MM-DD if shown" },
              vat_included: { type: "boolean", description: "true only if the unit prices shown include VAT" },
              note: { type: "string", description: "One short sentence on anything the buyer should check (e.g. different sizes, missing items, validity)." },
              lines: { type: "array", items: { type: "object", properties: {
                rfq_line_id: { type: ["string", "null"], description: "id of the matching RFQ line, or null if this quote line is not on the RFQ" },
                description: { type: "string" }, spec: { type: "string" }, unit: { type: "string" }, qty: { type: "number" },
                unit_price: { type: "number" }, lead_time: { type: "string" }, notes: { type: "string" },
              }, required: ["description", "unit_price"] } },
            }, required: ["lines"],
          },
        }],
        tool_choice: { type: "tool", name: "record_quote" },
        messages: [{ role: "user", content: [block, { type: "text", text:
          `Supplier: ${body.supplier || "unknown"}\nRFQ lines (match each quote line to one of these ids when it is the same product, allowing for different wording or pot size; if a size differs, still match but say so in notes):\n` +
          lines.map(l => `- id ${l.id}: ${l.description}${l.spec ? " (" + l.spec + ")" : ""}, ${l.qty} ${l.unit}`).join("\n") +
          `\n\nRecord every priced line on the quote.` }] }],
      });
      return json(toolInput(data));
    }

    // ---------------------------------------------------------- suggest a specification
    if (action === "suggest_spec") {
      const a = body.area || {};
      const data = await callClaude({
        system: `You are a senior horticulturist and landscape QS for ${COMPANY} You know plants that thrive in Eswatini's climate zones (Highveld frost, Middleveld, Lowveld heat). Suggest practical, buildable specifications. Prefer quantities as rates linked to the area: qty_mode "per_m2" with rate = units per m², "per_m" per metre, "per_no" per point, or "manual" with qty.`,
        tools: [{
          name: "suggest_items",
          description: "Suggested specification lines for one area.",
          input_schema: { type: "object", properties: {
            note: { type: "string", description: "One or two sentences on the approach." },
            items: { type: "array", items: { type: "object", properties: {
              category: { type: "string", enum: ["Plants", "Trees", "Lawn & grassing", "Hardscaping", "Irrigation & piping", "Soil & fertiliser", "Earthworks", "Drainage", "Structures & furniture", "Labour", "Plant hire & transport", "Preliminaries", "Maintenance", "Other"] },
              description: { type: "string" }, spec: { type: "string", description: "botanical name and size, or material spec" },
              unit: { type: "string", enum: ["each", "m²", "m", "m³", "bag", "load", "kg", "L", "tray", "roll", "item", "hour", "day", "week", "month", "trip"] },
              qty_mode: { type: "string", enum: ["manual", "per_m2", "per_m", "per_no"] }, rate: { type: "number" }, qty: { type: "number" },
              allowance_pct: { type: "number" }, notes: { type: "string" },
            }, required: ["category", "description", "unit", "qty_mode"] } },
          }, required: ["items"] },
        }],
        tool_choice: { type: "tool", name: "suggest_items" },
        messages: [{ role: "user", content:
          `Project: ${JSON.stringify(body.project)}\nArea: ${JSON.stringify(a)}\nAlready specified (do not repeat): ${JSON.stringify(body.existing || [])}\n\nSuggest the specification for this area (soil preparation, plants or lawn, mulch, and anything the notes call for). 4–12 lines.` }],
      });
      return json(toolInput(data));
    }

    // ---------------------------------------------------------- ask about the project
    if (action === "ask") {
      const history = ((body.history || []) as any[]).filter(m => m.role && m.content).map(m => ({ role: m.role, content: String(m.content) }));
      const data = await callClaude({
        system: `You are Claude, built into the Du Green Ops app for ${COMPANY} You help the QS, Horticulturist, Procurement Officer and the MD (Matt). Answer plainly and briefly, using the project data provided. Say when the data doesn't contain the answer. Money in E with two decimals.\n\nPROJECT DATA (JSON):\n${JSON.stringify(body.context).slice(0, 150000)}`,
        messages: [...history, { role: "user", content: String(body.question || "") }],
      });
      const answer = text(data);
      try { await userClient.from("claude_log").insert({ project_id: body.project_id || null, kind: "ask", question: body.question, answer, created_by: u.user.id }); } catch (_) { /* optional */ }
      return json({ answer });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
