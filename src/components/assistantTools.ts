// The assistant's system prompt and tool list (Amendment 8b), in one place so the
// panel, the tests and the real-model eval (src-tauri/examples/assistant_eval.rs)
// all use the same text.

/** Every tool the model has. None of them writes anything (D2 test reads this list). */
export const TOOLS = [
  {
    name: "find_pictures",
    description:
      "Find pictures in Andy's library and put them in the tray. Use the fewest filters that match what he asked. place matches a trip folder, an album or a recognised subject. Returns the count and text facts for the first ones.",
    input_schema: {
      type: "object",
      properties: {
        place: { type: "string", description: "A trip, country, city or place name, e.g. Egypt, Lima" },
        mark: { type: "string", enum: ["selected", "maybe", "rejected", "unreviewed"], description: "Approved = selected" },
        from: { type: "string", description: "YYYY-MM-DD" },
        to: { type: "string", description: "YYYY-MM-DD" },
        kind: { type: "string", enum: ["photo", "video"] },
        words: { type: "string", description: "Words to match in file names, folders and recognised content" },
        album: { type: "string", description: "Album name" },
        edited: { type: "boolean" },
        never_posted: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "select_pictures",
    description: "Narrow the tray selection: the first N of the tray, or exact picture ids from the facts. Use for « the first three », « only these ».",
    input_schema: { type: "object", properties: { first: { type: "integer" }, photo_ids: { type: "array", items: { type: "string" } } }, additionalProperties: false },
  },
  { name: "list_trips", description: "Trip folders with their picture counts.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "list_albums", description: "Albums with their picture counts.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "list_projects", description: "Projects in progress (title and stage).", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "propose",
    description: "Suggest one of the four outcomes for the selected pictures and a short title. This only highlights the button; Andy clicks to create.",
    input_schema: {
      type: "object",
      properties: { outcome: { type: "string", enum: ["post", "website", "album", "project"] }, title: { type: "string" } },
      required: ["outcome"],
      additionalProperties: false,
    },
  },
] as const;

export const SYSTEM = `You help Andy, a photographer, start things fast in his photo app, Captured by Andy.
Find pictures with the tools, narrow them when he asks, then propose one of four outcomes: an Instagram post, a website project, an album or a project. You never create anything yourself: he clicks the button, and the app makes a draft he can undo.
Rules:
- Answer from tool results only. Never invent pictures, places or counts. If a place or album does not exist, say so and add « Your trips include … » with a few the tool returned (never « nearest »). If it exists but nothing matches, just say that.
- One or two short lines, entirely in Andy's language: when he writes French or Dutch, translate every word, « tray » included. No praise, no emoji, no « I'd be happy to ».
- Talk to him as « you »; never name him or say « Andy » in a reply.
- « Approved » means mark = selected.
- You cannot delete, reject, publish, export or send, and you say so if asked.`;

